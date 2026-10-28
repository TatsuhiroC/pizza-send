import { test, expect } from '@playwright/test';
import { StreamFallback, INITIAL_RELAY_WAIT_MS, MAX_CONNECT_ATTEMPTS } from '../../src/stream-fallback';

test('an unconnected peer starts relay after four seconds and uses authenticated control rather than a bandwidth probe', async () => {
  const peers: Record<string, StreamFallback> = {}, channels: any = {}, epochs: any = { sender: 0, receiver: 0 };
  let opens = 0, binaryBytes = 0;
  for (const role of ['sender', 'receiver'] as const) {
    const opposite = role === 'sender' ? 'receiver' : 'sender';
    channels[role] = { readyState: 'open', ready: Promise.resolve(), close() { this.readyState = 'closed'; }, send(data: any) {
      if (data instanceof ArrayBuffer) binaryBytes += data.byteLength;
      queueMicrotask(() => channels[opposite].onmessage?.({ data }));
    } };
    peers[role] = new StreamFallback(role, {
      epoch: () => epochs[role], progress: () => ({ bytes: 0, total: 0, active: false, hidden: false, connected: false }), stopped: () => false,
      open: async () => { opens++; return channels[role]; }, send: async message => { queueMicrotask(() => { void peers[opposite].handle(message); }); },
      activate: async (_channel, epoch) => { epochs[role] = epoch; }, restore: () => { throw Error('Unexpected restore'); }
    });
    peers[role].supported = peers[role].quickSupported = true;
  }
  try {
    peers.sender.negotiated(0);
    for (const now of [0, 2000, INITIAL_RELAY_WAIT_MS - 1]) { peers.sender.negotiated(now); peers.sender.monitor(true, now); }
    expect(opens).toBe(0);
    peers.sender.monitor(true, INITIAL_RELAY_WAIT_MS);
    await expect.poll(() => peers.sender.active && peers.receiver.active).toBe(true);
    expect({ opens, binaryBytes, epochs }).toEqual({ opens: 2, binaryBytes: 0, epochs: { sender: 1, receiver: 1 } });
  } finally { peers.sender.close(); peers.receiver.close(); }
});

test('a receiver awaiting a relay socket still processes cancellation and the next session immediately', async () => {
  const channels: any[] = []; let open = 0;
  const peer: any = new StreamFallback('receiver', {
    epoch: () => 0, progress: () => ({ bytes: 0, total: 0, active: false, hidden: false, connected: false }), stopped: () => false,
    open: async () => {
      let resolve!: () => void;
      const channel = { readyState: 'connecting', ready: new Promise<void>(done => { resolve = done; }), close() { this.readyState = 'closed'; resolve(); } };
      channels.push(channel); open++; return channel as any;
    }, send: async () => {}, activate: async () => {}, restore: () => {}
  });
  peer.supported = peer.quickSupported = true;
  try {
    const handled = peer.handle({ type: 'stream-prepare', session: 'a'.repeat(64), epoch: 0, probeBytes: 0 });
    expect(await Promise.race([handled.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50))])).toBe(true);
    await peer.handle({ type: 'stream-unavailable', session: 'a'.repeat(64), epoch: 0 });
    expect(channels[0].readyState).toBe('closed');
    await peer.handle({ type: 'stream-prepare', session: 'b'.repeat(64), epoch: 0, probeBytes: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect({ open, busy: peer.busy, session: peer.candidate.session }).toEqual({ open: 2, busy: true, session: 'b'.repeat(64) });
  } finally { peer.close(); }
});

test('initial relay failure retries with backoff, fresh sessions and a bounded attempt count', async () => {
  let opens = 0; const sessions = new Set<string>();
  const peer = new StreamFallback('sender', {
    epoch: () => 0, progress: () => ({ bytes: 0, total: 0, active: false, hidden: false, connected: false }), stopped: () => false,
    open: async session => { sessions.add(session); opens++; throw Error('Transient fixture outage'); }, send: async () => {}, activate: async () => {}, restore: () => {}
  });
  peer.supported = peer.quickSupported = true; peer.negotiated(0);
  try {
    for (const [now, expected] of [[4000, 1], [6000, 1], [7000, 2], [12999, 2], [13000, 3], [60000, 3]]) {
      peer.monitor(true, now); await expect.poll(() => peer.busy).toBe(false); expect(opens).toBe(expected);
    }
    expect(sessions.size).toBe(MAX_CONNECT_ATTEMPTS);
    expect(peer.state).toMatchObject({ failed: true, connected: false, available: true });
    peer.choose('stream'); peer.monitor(true, 62000);
    await expect.poll(() => opens).toBe(MAX_CONNECT_ATTEMPTS + 1);
  } finally { peer.close(); }
});

test('zero-byte relay handshake requires negotiated support and invalid probe sizes never open a socket', async () => {
  let opens = 0;
  const peer = new StreamFallback('receiver', {
    epoch: () => 0, progress: () => ({ bytes: 0, total: 0, active: false, hidden: false, connected: false }), stopped: () => false,
    open: async () => { opens++; throw Error('Fixture'); }, send: async () => {}, activate: async () => {}, restore: () => {}
  });
  peer.supported = true;
  try {
    for (const probeBytes of [0, -1, 1, 1e9]) await peer.handle({ type: 'stream-prepare', session: 'a'.repeat(64), epoch: 0, probeBytes });
    expect(opens).toBe(0);
    await peer.handle({ type: 'stream-prepare', session: 'b'.repeat(64), epoch: 0 });
    expect(opens).toBe(1);
  } finally { peer.close(); }
});

test('native winning during quick relay setup keeps the working direct route', async () => {
  let connected = false, activations = 0, closes = 0;
  const channel: any = { ready: Promise.resolve(), readyState: 'open', close() { closes++; this.readyState = 'closed'; }, send(value: string) {
    if (JSON.parse(value).type === 'stream-probe-end') { connected = true; queueMicrotask(() => channel.onmessage?.({ data: JSON.stringify({ type: 'stream-probe-ok' }) })); }
  } };
  const peer = new StreamFallback('sender', {
    epoch: () => 0, progress: () => ({ bytes: 0, total: 0, active: false, hidden: false, connected }), stopped: () => false,
    open: async () => channel, send: async () => {}, activate: async () => { activations++; }, restore: () => { throw Error('Unexpected restore'); }
  });
  peer.supported = peer.quickSupported = true; peer.negotiated(0);
  try {
    peer.monitor(true, 4000);
    await expect.poll(() => closes).toBe(1);
    expect({ active: peer.active, busy: peer.busy, activations }).toEqual({ active: false, busy: false, activations: 0 });
  } finally { peer.close(); }
});

test('failed initial setup does not disable later slow-link evaluation after direct eventually connects', async () => {
  let connected = false, bytes = 0, opens = 0;
  const peer = new StreamFallback('sender', {
    epoch: () => 0, progress: () => ({ bytes, total: 1e9, active: connected, hidden: false, connected }), stopped: () => false,
    open: async () => { opens++; throw Error('Fixture outage'); }, send: async () => {}, activate: async () => {}, restore: () => {}
  });
  peer.supported = peer.quickSupported = true; peer.negotiated(0);
  try {
    peer.monitor(true, 4000); await expect.poll(() => peer.busy).toBe(false); expect(opens).toBe(1);
    connected = true;
    for (let now = 6000; now <= 24000; now += 2000) { bytes = (now - 6000) * 30; peer.monitor(true, now); }
    await expect.poll(() => opens).toBe(2);
  } finally { peer.close(); }
});

test('an unanswered quick handshake times out after fifteen seconds and releases pending receiver work', async ({ page }) => {
  await page.goto('./');
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.evaluate(async () => {
    const { StreamFallback } = await import('/src/stream-fallback.ts');
    const state = window as any; state.__quickCloses = 0;
    const peer = state.__quickDeadline = new StreamFallback('receiver', {
      epoch: () => 0, progress: () => ({ bytes: 0, total: 0, active: false, hidden: false, connected: false }), stopped: () => false,
      open: async () => {
        let release!: () => void;
        return { readyState: 'connecting', ready: new Promise<void>(resolve => { release = resolve; }), close() { state.__quickCloses++; release(); } } as any;
      }, send: async () => {}, activate: async () => {}, restore: () => {}
    });
    peer.supported = peer.quickSupported = true;
    await peer.handle({ type: 'stream-prepare', session: 'a'.repeat(64), epoch: 0, probeBytes: 0 });
  });
  await page.clock.fastForward(14999);
  expect(await page.evaluate(() => (window as any).__quickDeadline.busy)).toBe(true);
  await page.clock.fastForward(1);
  expect(await page.evaluate(() => ({ busy: (window as any).__quickDeadline.busy, closes: (window as any).__quickCloses }))).toEqual({ busy: false, closes: 1 });
  await page.evaluate(() => (window as any).__quickDeadline.close());
});

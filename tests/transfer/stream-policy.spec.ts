import { RouteFallbackPolicy } from '../../src/route-policy';
import { test, expect } from '@playwright/test';
import { StreamFallback } from '../../src/stream-fallback';

test('authenticated route negotiation commits both peers to the same next epoch', async () => {
  const peers: any = {}, channels: any = {}, epochs = { sender: 0, receiver: 0 }, activations: string[] = [], delivered: any[] = [];
  let bytes = 0;
  for (const role of ['sender', 'receiver'] as const) {
    const opposite = role === 'sender' ? 'receiver' : 'sender';
    channels[role] = { readyState: 'open', ready: Promise.resolve(), close() { this.readyState = 'closed'; },
      send(data: any) { queueMicrotask(() => channels[opposite].onmessage?.({ data })); } };
    peers[role] = new StreamFallback(role, {
      epoch: () => epochs[role], progress: () => ({ bytes, total: 3000 * 1800, active: true, hidden: false, connected: true }), stopped: () => false,
      open: async () => channels[role], send: async message => { queueMicrotask(() => { void peers[opposite].handle(message); }); },
      activate: async (_channel, epoch) => {
        epochs[role] = epoch; activations.push(role);
        if (role === 'receiver') channels.receiver.send(JSON.stringify({ type: 'visibility', hidden: false }));
        else channels.sender.onmessage = (event: any) => delivered.push(JSON.parse(event.data));
      }, restore: () => { throw Error('Unexpected restore'); }
    });
    peers[role].supported = true;
  }
  try {
    for (let ms = 0; ms <= 18000; ms += 2000) { bytes = 3000 * ms / 1000; peers.sender.monitor(true, 1e7 + ms); }
    await expect.poll(() => peers.sender.active && peers.receiver.active, { timeout: 1000 }).toBe(true);
    expect(epochs).toEqual({ sender: 1, receiver: 1 }); expect(activations).toEqual(['receiver', 'sender']);
    expect(delivered).toEqual([{ type: 'visibility', hidden: false }]);
  } finally { peers.sender.close(); peers.receiver.close(); }
});
test('failed candidate preparation preserves the existing route; cancellation closes late resources', async () => {
  let activate = 0, restore = 0, finish!: (channel: any) => void, closes = 0;
  const make = (open: any) => new StreamFallback('sender', { epoch: () => 0, progress: () => ({ bytes: 0, total: 1e9, active: true, hidden: false, connected: true }), stopped: () => false,
    open, send: async () => {}, activate: async () => { activate++; }, restore: () => { restore++; } });
  const unavailable: any = make(async () => { throw Error('Unavailable'); });
  await unavailable.prepare(3000, false); expect(unavailable.busy).toBe(false); unavailable.close();
  const late: any = make(() => new Promise(resolve => { finish = resolve; }));
  const pending = late.prepare(3000, false); await new Promise(resolve => setTimeout(resolve, 0)); late.close();
  finish({ close() { closes++; } }); await pending;
  expect({ activate, restore, closes }).toEqual({ activate: 0, restore: 0, closes: 1 });
});
test('peer cannot reuse a previous stream salt in a fresh encrypted control message', async () => {
  let opens = 0;
  const peer = new StreamFallback('receiver', { epoch: () => 0, progress: () => ({ bytes: 0, total: 1e9, active: true, hidden: false, connected: true }), stopped: () => false,
    open: async () => { opens++; throw Error('Fixture unavailable'); }, send: async () => {}, activate: async () => {}, restore: () => {} });
  peer.supported = true;
  const message = { type: 'stream-prepare', epoch: 0, session: 'a'.repeat(64) };
  await peer.handle(message); await peer.handle(message); peer.close(); expect(opens).toBe(1);
});
test('an activated candidate that does not improve actual file progress returns to the previous route', () => {
  for (const scenario of [{ speed: 1000, remaining: 1e9, expected: 1 }, { speed: 6000, remaining: 1e9, expected: 0 }, { speed: 1000, remaining: 10000, expected: 0 }]) {
    let restores = 0;
    const peer: any = new StreamFallback('sender', { epoch: () => 1, progress: () => ({ bytes: scenario.speed * 20, total: scenario.speed * 20 + scenario.remaining, active: true, hidden: false, connected: true }), stopped: () => false,
      open: async () => { throw Error('Unexpected probe'); }, send: async () => {}, activate: async () => {}, restore: () => { restores++; } });
    peer.supported = peer.active = peer.tried = true; peer.trial = { at: 10000, bytes: 0, oldBps: 3000 };
    peer.monitor(true, 30000); peer.monitor(true, 32000); peer.close(); expect(restores).toBe(scenario.expected);
  }
});

test('direct connection retries do not reset the disconnected fallback observation forever', async () => {
  let opened = 0;
  const peer = new StreamFallback('sender', { epoch: () => 0, progress: () => ({ bytes: 0, total: 1e9, active: false, hidden: false, connected: false }), stopped: () => false,
    open: async () => { opened++; throw Error('Fixture unavailable'); }, send: async () => {}, activate: async () => {}, restore: () => {} });
  peer.supported = true;
  for (let ms = 0; ms <= 18000; ms += 2000) peer.monitor(ms % 6000 !== 0, 1e7 + ms);
  peer.monitor(true, 1e7 + 20000);
  await expect.poll(() => opened).toBe(1); peer.close();
});

test('manual direct suppresses automatic switching and a manual relay failure is attempted only once', async () => {
  let opened = 0;
  const peer: any = new StreamFallback('sender', { epoch: () => 0, progress: () => ({ bytes: 0, total: 1e9, active: true, hidden: false, connected: true }), stopped: () => false,
    open: async () => { opened++; throw Error('Fixture unavailable'); }, send: async () => {}, activate: async () => {}, restore: () => {} });
  peer.supported = true; peer.choose('direct');
  for (let ms = 0; ms <= 30000; ms += 2000) peer.monitor(true, 1e7 + ms);
  expect(opened).toBe(0);
  peer.choose('stream'); peer.monitor(true, 1e7 + 32000);
  await expect.poll(() => peer.busy).toBe(false);
  for (let ms = 34000; ms <= 60000; ms += 2000) peer.monitor(true, 1e7 + ms);
  expect(opened).toBe(1); expect(peer.state).toMatchObject({ manual: true, current: 'direct', failed: true });
  peer.close();
});
test('an explicitly selected relay is not automatically replaced because it is slower', () => {
  let restores = 0;
  const peer: any = new StreamFallback('sender', { epoch: () => 1, progress: () => ({ bytes: 1000, total: 1e9, active: true, hidden: false, connected: true }), stopped: () => false,
    open: async () => { throw Error('Unexpected probe'); }, send: async () => {}, activate: async () => {}, restore: () => { restores++; } });
  peer.supported = peer.active = true; peer.choose('stream');
  peer.trial = { at: 10000, bytes: 0, oldBps: 100000 };
  peer.monitor(true, 40000); expect(restores).toBe(0);
  peer.choose('direct'); peer.monitor(true, 42000); expect(restores).toBe(1); peer.close();
});

for (const result of ['resolve', 'reject'] as const) test(`a cancelled preparation cannot disturb its replacement when old signaling ${result}s late`, async () => {
  let release!: () => void, reject!: (error: Error) => void;
  const pendingOpens: ((channel: any) => void)[] = [];
  const delayed = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  let first = true, opens = 0;
  const peer: any = new StreamFallback('sender', {
    epoch: () => 0, progress: () => ({ bytes: 0, total: 1e9, active: true, hidden: false, connected: true }), stopped: () => false,
    send: async (message: any) => { if (message.type === 'stream-prepare' && first) { first = false; await delayed; } },
    open: async () => { opens++; return new Promise(resolve => { pendingOpens.push(resolve); }); },
    activate: async () => { throw Error('Unexpected activation'); }, restore: () => { throw Error('Unexpected restore'); }
  });
  peer.supported = true;
  const old = peer.prepare(0, false, true);
  peer.choose('direct'); peer.choose('stream');
  const replacement = peer.prepare(0, false, true);
  try {
    await expect.poll(() => opens).toBe(1);
    const candidate = peer.candidate;
    if (result === 'resolve') release(); else reject(Error('Late signaling failure'));
    // Allow the obsolete continuation and its catch handler to run.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opens).toBe(1);
    expect(peer.candidate).toBe(candidate);
    expect(peer.busy).toBe(true);
  } finally {
    peer.close(); release();
    for (const finish of pendingOpens) finish({ close() {} });
    await Promise.all([old, replacement]);
  }
});

for (const scenario of [
  { name: 'slow with short ETA stays direct', speed: 64 * 1024, seconds: 60, expected: false },
  { name: '800 KB per second stays direct even for a large file', speed: 800 * 1024, seconds: 1800, expected: false },
  { name: 'fast with long ETA stays direct', speed: 8 * 1048576, seconds: 1800, expected: false },
  { name: 'slow and long ETA becomes eligible after sustained observation', speed: 30 * 1024, seconds: 1800, expected: true },
  { name: 'zero progress remains eligible even when control messages arrive', speed: 0, seconds: 1800, expected: true }
]) test(scenario.name, () => {
  const policy = new RouteFallbackPolicy(), total = Math.max(1048576, scenario.speed * scenario.seconds);
  for (let ms = 0; ms <= 16000; ms += 2000) expect(policy.update(ms, scenario.speed * ms / 1000, total, true)).toBe(false);
  expect(policy.update(18000, scenario.speed * 18, total, true)).toBe(scenario.expected);
});
test('one slow sample, backgrounding, rollback and suspension cannot trigger a switch', () => {
  const policy = new RouteFallbackPolicy();
  for (let i = 0; i <= 5; i++) expect(policy.update(i * 2000, i * 65536, 1e9, true)).toBe(false);
  expect(policy.update(12000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(14000, 12 * 1048576, 1e9, false)).toBe(false);
  expect(policy.update(16000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(80000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(82000, 0, 1e9, true)).toBe(false);
});

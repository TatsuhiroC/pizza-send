import { test, expect } from './fixtures';
import { encodeStreamBatch, decodeStreamBatch, STREAM_BATCH_BYTES } from '../src/stream-batch';

test('batch envelopes preserve exact record boundaries, compressed tails and empty records', () => {
  const parts = [new Uint8Array(32768).fill(1).buffer, new Uint8Array([7, 8, 9]).buffer, new ArrayBuffer(0), new Uint8Array(65536).fill(2).buffer];
  const encoded = encodeStreamBatch(parts);
  expect(decodeStreamBatch(encoded).map(value => [...new Uint8Array(value)])).toEqual(parts.map(value => [...new Uint8Array(value)]));
  expect(encoded.byteLength).toBe(parts.reduce((sum, part) => sum + part.byteLength, 0) + 8 + parts.length * 4);
  for (const invalid of [[], Array.from({ length: 9 }, () => new ArrayBuffer(0)), [new ArrayBuffer(65537)], Array.from({ length: 3 }, () => new ArrayBuffer(65536))]) {
    expect(() => encodeStreamBatch(invalid)).toThrow();
  }
});

for (const kind of ['magic', 'reserved', 'empty', 'many', 'table', 'length', 'record-limit', 'trailing', 'frame-limit'] as const) test(`batch decoder rejects ${kind} before exposing records`, () => {
  let frame = encodeStreamBatch([new Uint8Array([1, 2]).buffer, new Uint8Array([3]).buffer]);
  const view = new DataView(frame);
  if (kind === 'magic') view.setUint32(0, 0);
  if (kind === 'reserved') view.setUint16(6, 1);
  if (kind === 'empty') view.setUint16(4, 0);
  if (kind === 'many') view.setUint16(4, 9);
  if (kind === 'table') frame = frame.slice(0, 12);
  if (kind === 'length') view.setUint32(12, 0xffffffff);
  if (kind === 'record-limit') view.setUint32(8, 65537);
  if (kind === 'trailing') { const extra = new Uint8Array(frame.byteLength + 1); extra.set(new Uint8Array(frame)); frame = extra.buffer; }
  if (kind === 'frame-limit') frame = new ArrayBuffer(STREAM_BATCH_BYTES + 41);
  expect(() => decodeStreamBatch(frame)).toThrow();
});

test('negotiated channels batch binary records, flush controls and bound sparse-message latency', async ({ page, context }) => {
  const frames: Buffer[] = []; let socket: any;
  await context.routeWebSocket('ws://127.0.0.1:8787/batch-fixture', route => {
    socket = route; route.onMessage(data => { if (typeof data !== 'string') frames.push(data); });
    route.send(JSON.stringify({ type: 'stream-ready' }));
  });
  await page.goto('./'); await page.clock.install();
  const queued = await page.evaluate(async () => {
    const { StreamCipher } = await import('/src/stream-cipher.ts'), { StreamChannel } = await import('/src/stream-channel.ts');
    const state = window as any;
    state.channel = new StreamChannel('ws://127.0.0.1:8787/batch-fixture', await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'sender'), true);
    await state.channel.ready;
    const first = new Uint8Array(32768).fill(9);
    state.channel.send(first.buffer); first.fill(99); // Caller mutation cannot change queued bytes.
    for (let i = 1; i < 4; i++) state.channel.send(new Uint8Array(32768).fill(i).buffer);
    state.channel.send(new Uint8Array([5, 6, 7]).buffer);
    const queued = state.channel.bufferedAmount;
    state.channel.send(JSON.stringify({ type: 'file-end' }));
    return queued;
  });
  expect(queued).toBeGreaterThan(3);
  await expect.poll(() => frames.length).toBe(3);
  const decoded = await page.evaluate(async frames => {
    const { StreamCipher } = await import('/src/stream-cipher.ts'), { decodeStreamBatch } = await import('/src/stream-batch.ts');
    const cipher = await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'receiver');
    const output: any[] = [];
    for (const frame of frames) {
      const record = await cipher.decrypt(new Uint8Array(frame).buffer);
      output.push(typeof record === 'string' ? record : decodeStreamBatch(record).map(part => ({ size: part.byteLength, first: new Uint8Array(part)[0] })));
    }
    return output;
  }, frames.map(frame => [...frame]));
  expect(decoded).toEqual([[{ size: 32768, first: 9 }, { size: 32768, first: 1 }, { size: 32768, first: 2 }, { size: 32768, first: 3 }], [{ size: 3, first: 5 }], '{"type":"file-end"}']);
  await page.evaluate(() => (window as any).channel.send(new Uint8Array([42]).buffer));
  await page.clock.fastForward(3); expect(frames).toHaveLength(3);
  await page.clock.fastForward(1); await expect.poll(() => frames.length).toBe(4);
  await page.evaluate(() => { (window as any).channel.send(new Uint8Array([77]).buffer); (window as any).channel.close(); });
  await page.clock.fastForward(100); expect(frames).toHaveLength(4);
  socket.close();
});

test('malformed authenticated batches release no plaintext or receive credit', async ({ page, context }) => {
  let socket: any; const controls: string[] = [];
  await context.routeWebSocket('ws://127.0.0.1:8787/bad-batch', route => {
    socket = route; route.onMessage(data => { if (typeof data === 'string') controls.push(data); });
    route.send(JSON.stringify({ type: 'stream-ready' }));
  });
  await page.goto('./');
  const frame = await page.evaluate(async () => {
    const { StreamCipher } = await import('/src/stream-cipher.ts'), { StreamChannel } = await import('/src/stream-channel.ts');
    const { encodeStreamBatch } = await import('/src/stream-batch.ts');
    const state = window as any; state.delivered = 0;
    state.channel = new StreamChannel('ws://127.0.0.1:8787/bad-batch', await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'receiver'), true);
    state.channel.onmessage = () => state.delivered++; await state.channel.ready;
    const bytes = encodeStreamBatch([new Uint8Array([1]).buffer, new Uint8Array([2]).buffer]);
    new DataView(bytes).setUint32(12, 0xffffffff);
    return [...new Uint8Array(await (await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'sender')).encrypt(bytes))];
  });
  socket.send(Buffer.from(frame));
  socket.send(JSON.stringify({ type: 'credit-request', bytes: frame.length, nonce: 'd'.repeat(64) }));
  await expect.poll(() => page.evaluate(() => (window as any).channel.readyState)).toBe('closed');
  expect(await page.evaluate(() => (window as any).delivered)).toBe(0);
  expect(controls).toEqual([]);
});

test('batching requires authenticated matching peer capabilities', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { AutoPair, signalKey } = await import('/src/protocol.ts');
    const result: any[] = [];
    for (const role of ['sender', 'receiver']) for (const [support, authenticated, stream] of [[1, true, 1], [undefined, true, 1], ['1', true, 1], [1, false, 1], [1, true, undefined]] as const) {
      const sent: any[] = [], modes: boolean[] = [];
      const transfer: any = { role, stopped: false, completed: false, recovering: false, pc: { signalingState: 'have-local-offer' },
        enableSourceFailure() {}, enableCandidates() {}, enableRecovery() {}, enableStandby() {}, pairingStage() {}, reportRoute() {},
        finish: async () => {}, answer: async () => ({ type: 'answer', sdp: 'fixture' }),
        routeProgress: () => ({ bytes: 0, total: 0, active: false, hidden: false }) };
      const pair: any = new AutoPair(transfer, await signalKey('a'.repeat(64)), () => {}, 'a'.repeat(64));
      pair.signal.send = async (message: any) => { sent.push(message); };
      pair.signal.stream = async (_secret: string, _session: string, _current: unknown, batching: boolean) => { modes.push(batching); return {}; };
      try {
        await pair.handle({ type: role === 'sender' ? 'answer' : 'offer', epoch: 0, description: { type: 'offer', sdp: 'fixture' }, streamSupport: stream, streamBatchSupport: support }, authenticated);
        await pair.streamFallback.hooks.open('b'.repeat(64), () => true);
        result.push({ role, enabled: modes[0], expected: support === 1 && authenticated && stream === 1 });
      } finally { pair.close(); }
    }
    return result;
  });
  for (const row of result) expect(row.enabled, row.role).toBe(row.expected);
});

test('pending batch headers share the outgoing budget and cancellation drops queued ciphertext', async ({ page, context }) => {
  const frames: unknown[] = [];
  await context.routeWebSocket('ws://127.0.0.1:8787/batch-budget', route => {
    route.onMessage(data => frames.push(data)); route.send(JSON.stringify({ type: 'stream-ready' }));
  });
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { StreamCipher } = await import('/src/stream-cipher.ts'), { StreamChannel } = await import('/src/stream-channel.ts');
    const cipher = await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'sender');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }), encrypt = cipher.encrypt.bind(cipher);
    cipher.encrypt = async data => { await blocked; return encrypt(data); };
    const channel = new StreamChannel('ws://127.0.0.1:8787/batch-budget', cipher, true); await channel.ready;
    let accepted = 0, rejected = false;
    for (let i = 0; i < 40; i++) {
      try { channel.send(new ArrayBuffer(65536)); accepted++; } catch { rejected = true; break; }
    }
    await Promise.resolve();
    const buffered = channel.bufferedAmount;
    channel.close(); release();
    return { accepted, rejected, buffered, pending: (channel as any).pending.length, closed: channel.readyState };
  });
  expect(result).toMatchObject({ accepted: 31, rejected: true, pending: 0, closed: 'closed' });
  expect(result.buffered).toBeLessThanOrEqual(2 * 1048576);
  expect(frames).toEqual([]);
});

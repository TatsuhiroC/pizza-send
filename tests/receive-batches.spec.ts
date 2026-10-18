import { test, expect } from './fixtures';

test('sparse arrivals are written promptly without waiting for a batch timer', async ({ page }) => {
  await page.goto('./');
  const written = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', () => {});
    const state = transfer as any; let written = 0, clock = 10000;
    const channel: any = { readyState: 'open', send() {}, close() {} };
    state.attach(channel); state.accepted = true;
    state.incoming = { info: { id: 0, name: 'sparse.bin', type: '', size: 3 * 32768 }, received: 0, parts: [], hash: sha256.create(), writer: { write: async (buffer: ArrayBuffer) => { written += buffer.byteLength; }, abort: async () => {} } };
    const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });
    try {
      channel.onmessage({ data: new ArrayBuffer(32768) }); await state.queue;
      clock += 10;
      channel.onmessage({ data: new ArrayBuffer(32768) }); await state.queue;
      return written;
    } finally {
      if (descriptor) Object.defineProperty(performance, 'now', descriptor); else delete (performance as any).now;
      transfer.close(false);
    }
  });
  expect(written).toBe(65536);
});

test('short file reads stop before sending any binary data or file completion', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {});
    const state = transfer as any, sent: unknown[] = [];
    state.channel = { readyState: 'open', bufferedAmount: 0, send: (data: unknown) => sent.push(data), close() {} };
    state.files = [{ name: 'short.bin', size: 32768, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(17) }) }];
    let error = '';
    try { await state.sendFiles(0, 0, 0); } catch (failure) { error = (failure as Error).message; }
    transfer.close(false);
    return { error, controls: sent.filter(data => typeof data === 'string').map(data => JSON.parse(data as string).type), binary: sent.filter(data => data instanceof ArrayBuffer).length };
  });
  expect(result.error).toBe('无法读取原文件“short.bin”。请确认文件仍在本机、未被移动或修改，再重新选择。');
  expect(result.binary).toBe(0); expect(result.controls).not.toContain('file-end');
});

test('partial timed batches do not drift committed receipts beyond their byte boundaries', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const data = new Uint8Array(1048576 + 17).fill(93), receipts: number[] = [];
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 2 * 1048576 }, 'receiver', () => {});
    const state = transfer as any;
    const channel: any = { readyState: 'open', send: (raw: string) => { const m = JSON.parse(raw); if (m.type === 'ack') receipts.push(m.bytes); }, close() {} };
    state.attach(channel); state.accepted = true;
    transfer.manifest = [{ id: 0, name: 'boundary.bin', type: '', size: data.length }];
    state.handles = [{ createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }) }];
    channel.onmessage({ data: JSON.stringify({ type: 'file-start', id: 0 }) }); await state.queue;
    let chunks = 0;
    for (let at = 0; at < data.length; at += 32768) {
      channel.onmessage({ data: data.slice(at, at + 32768).buffer });
      // Simulate timers flushing short batches between the regular boundaries.
      if (++chunks % 3 === 0) { state.flushBinary(state.generation); await state.queue; }
    }
    channel.onmessage({ data: JSON.stringify({ type: 'file-end', id: 0, hash: Array.from(sha256(data), n => n.toString(16).padStart(2, '0')).join('') }) });
    channel.onmessage({ data: JSON.stringify({ type: 'done' }) }); await state.queue;
    const result = { receipts, completed: transfer.completed }; transfer.close(false); return result;
  });
  expect(result.completed).toBe(true);
  expect(result.receipts).toEqual([262144, 524288, 786432, 1048576, 1048593]);
});

test('recovery waiting ignores short browser-buffer polling deadlines', async ({ page }) => {
  await page.goto('./');
  const delays = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {}), state = t as any;
    state.channel = { readyState: 'open', close() {} }; t.recovering = true;
    const timeout = window.setTimeout, delays: number[] = [];
    window.setTimeout = ((fn: TimerHandler, delay: number, ...args: any[]) => { delays.push(delay); return timeout(fn, delay, ...args); }) as typeof setTimeout;
    try {
      const pending = state.waitFor(() => false, 0, 60000, () => 1).catch(() => {});
      t.close(false); await pending;
      return delays;
    } finally { window.setTimeout = timeout; }
  });
  expect(delays).toEqual([250]);
});

test('bounded receive batches preserve file boundaries, odd tails and SHA-256 before completion', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    const first = new Uint8Array(600 * 1024 + 17).fill(81), last = new Uint8Array([3, 4, 5]);
    const sources = [first, last], writes: Uint8Array[][] = [[], []], closed: number[] = [], controls: any[] = [];
    const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', () => {}), state = t as any;
    const channel: any = { readyState: 'open', send: (data: string) => controls.push(JSON.parse(data)), close() {} };
    state.attach(channel); state.accepted = true;
    t.manifest = sources.map((bytes, id) => ({ id, name: id + '.bin', type: 'application/octet-stream', size: bytes.length }));
    state.handles = sources.map((_, id) => ({ createWritable: async () => ({ write: async (buffer: ArrayBuffer) => { writes[id].push(new Uint8Array(buffer.slice(0))); }, close: async () => { closed.push(id); }, abort: async () => {} }) }));
    for (let id = 0; id < sources.length; id++) {
      channel.onmessage({ data: JSON.stringify({ type: 'file-start', id, offset: 0 }) });
      for (let offset = 0; offset < sources[id].length; offset += 32768) channel.onmessage({ data: sources[id].slice(offset, offset + 32768).buffer });
      channel.onmessage({ data: JSON.stringify({ type: 'file-end', id, hash: hex(sha256(sources[id])) }) });
    }
    channel.onmessage({ data: JSON.stringify({ type: 'done' }) }); await state.queue;
    const result = { completed: t.completed, closed, sizes: writes.map(list => list.map(bytes => bytes.length)), hashes: writes.map(list => { const hash = sha256.create(); for (const bytes of list) hash.update(bytes); return hex(hash.digest()); }), expected: sources.map(bytes => hex(sha256(bytes))), acknowledgements: controls.filter(m => m.type === 'ack').map(m => m.bytes), saved: controls.filter(m => m.type === 'file-saved').map(m => m.id) };
    t.close(false); return result;
  });
  expect(result.completed).toBe(true); expect(result.closed).toEqual([0, 1]); expect(result.saved).toEqual([0, 1]);
  expect(result.hashes).toEqual(result.expected);
  expect(result.sizes[0].length).toBeLessThan(20); expect(result.sizes.flat().every(size => size <= 256 * 1024)).toBe(true);
  expect(result.sizes[1]).toEqual([3]); expect(result.acknowledgements.at(-1)).toBe(600 * 1024 + 20);
});

for (const action of ['cancel', 'replace'] as const) test(`${action} with an unflushed receive tail never loses or acknowledges uncommitted bytes`, async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async action => {
    const { Transfer } = await import('/src/protocol.ts');
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', () => {}), state = t as any;
    let written = 0, aborted = 0; const controls: unknown[] = [];
    const channel: any = { readyState: 'open', send: (data: string) => controls.push(JSON.parse(data)), close() {} };
    state.attach(channel); state.accepted = true;
    state.incoming = { info: { id: 0, name: 'tail.bin', type: '', size: 65536 }, received: 0, hash: sha256.create(), parts: [], writer: { write: async (buffer: ArrayBuffer) => { written += buffer.byteLength; }, abort: async () => { aborted++; } } };
    channel.onmessage({ data: new ArrayBuffer(32768) });
    if (action === 'cancel') t.close(false); else await t.replaceTransport();
    await state.queue;
    const result = { written, received: state.incoming?.received ?? 0, queued: state.receivingQueuedBytes, controls, aborted };
    t.close(false); return result;
  }, action);
  expect(result.controls).toEqual([]); expect(result.queued).toBe(0);
  if (action === 'cancel') { expect(result.written).toBe(0); expect(result.aborted).toBe(1); }
  else { expect(result.written).toBe(32768); expect(result.received).toBe(32768); }
});

test('coalesced compressed-to-plain arrivals retain wire block boundaries and the original hash', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const { gzip, COMPRESSION } = await import('/src/compression.ts');
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const prefix = new Uint8Array(17).fill(11), raw = new Uint8Array(262144).fill(77), tail = new Uint8Array(65536).fill(93);
    const encoded = await gzip(raw.buffer), original = new Uint8Array(prefix.length + raw.length + tail.length);
    original.set(prefix); original.set(raw, prefix.length); original.set(tail, prefix.length + raw.length);
    const hash = (data: Uint8Array) => Array.from(sha256(data), n => n.toString(16).padStart(2, '0')).join('');
    const errors: string[] = [], writes: Uint8Array[] = [];
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', e => { if (e.type === 'error') errors.push(e.data); });
    const state = transfer as any, channel: any = { readyState: 'open', send() {}, close() {} };
    state.attach(channel); state.accepted = true;
    state.handles = [{ createWritable: async () => ({ write: async (data: ArrayBuffer) => { writes.push(new Uint8Array(data.slice(0))); }, close: async () => {}, abort: async () => {} }) }];
    const send = (data: unknown) => channel.onmessage({ data: data instanceof ArrayBuffer ? data : JSON.stringify(data) });
    const clock = Object.getOwnPropertyDescriptor(performance, 'now');
    Object.defineProperty(performance, 'now', { configurable: true, value: () => 10000 });
    try {
      send({ type: 'manifest', files: [{ id: 0, name: 'mixed.bin', type: '', size: original.length }], compression: COMPRESSION });
      send({ type: 'file-start', id: 0 }); send(prefix.buffer); await state.queue;
      send({ type: 'compression-advice', active: true });
      send({ type: 'compressed-block', id: 0, offset: prefix.length, raw: raw.length, size: encoded.byteLength });
      send(encoded); send(tail.slice(0, 32768).buffer); send(tail.slice(32768).buffer);
      send({ type: 'file-end', id: 0, hash: hash(original) }); send({ type: 'done' }); await state.queue;
      const written = new Uint8Array(writes.reduce((n, b) => n + b.length, 0)); let at = 0;
      for (const part of writes) { written.set(part, at); at += part.length; }
      return { completed: transfer.completed, errors, hash: hash(written), expected: hash(original), queued: state.receivingQueuedBytes, sizes: writes.map(b => b.length) };
    } finally {
      if (clock) Object.defineProperty(performance, 'now', clock); else delete (performance as any).now;
      transfer.close(false);
    }
  });
  expect(result.errors).toEqual([]); expect(result.completed).toBe(true); expect(result.hash).toBe(result.expected);
  expect(result.queued).toBe(0); expect(result.sizes.every(n => n <= 262144)).toBe(true);
});

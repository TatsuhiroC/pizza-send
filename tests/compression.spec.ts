import { test, expect } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('compression stays absent on the ordinary page in both languages', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.compression-hint')).toBeHidden();
  await expect(page.getByRole('button', { name: '改用压缩传输' })).toHaveCount(0);
  await page.locator('#language-toggle').click();
  await expect(page.getByRole('button', { name: 'Use compression', exact: true })).toHaveCount(0);
});

test('slow-link policy needs sustained progress, resets on changes, and rejects a recent recovery', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { SlowLink, compressionEstimate } = await import('/src/compression.ts');
    const link = new SlowLink(), MiB = 1048576;
    link.reset(0, 0);
    for (let second = 1; second <= 7; second++) link.observe(second * MiB / 2, second * 1000);
    const early = link.speed(7000) ?? null;
    link.observe(4 * MiB, 8000); const slow = link.speed(8000);
    link.observe(8 * MiB, 9000); const fast = link.speed(9000) ?? null;
    link.reset(8 * MiB, 10000); const reset = link.speed(10000) ?? null;
    const cautious = compressionEstimate(100 * MiB, .1 * MiB, .5, 2 * MiB, 2 * MiB);
    const overhead = compressionEstimate(100 * MiB, .5 * MiB, .5, 20 * MiB, 50 * MiB, .1 / MiB);
    const estimate = compressionEstimate(100 * MiB, .5 * MiB, .5, 20 * MiB, 50 * MiB);
    const burst = new SlowLink(); burst.reset(0, 0);
    for (let second = 1; second <= 10; second++) { burst.observe((2 * second - 1) * 131072, second * 1000); burst.observe(2 * second * 131072, second * 1000 + 1); }
    const sparse = new SlowLink(); sparse.reset(0, 0);
    for (let second = 8; second <= 24; second += 8) sparse.observe(second * 32768, second * 1000);
    const bounded = new SlowLink(); bounded.reset(0, 0);
    for (let at = 1; at <= 30000; at++) bounded.observe(at * 1000, at);
    return { cautious, overhead, tooMuchOverhead: compressionEstimate(100 * MiB, .5 * MiB, .5, 20 * MiB, 50 * MiB, 1.9 / MiB) ?? null, burst: burst.speed(10001), sparse: sparse.speed(24000), points: (bounded as any).points.length, early, slow, fast, reset, estimate, fastLink: compressionEstimate(100 * MiB, 2 * MiB, .5, 20 * MiB, 50 * MiB) ?? null,
      small: compressionEstimate(MiB, .5 * MiB, .5, 20 * MiB, 50 * MiB) ?? null,
      random: compressionEstimate(100 * MiB, .5 * MiB, .99, 20 * MiB, 50 * MiB) ?? null,
      cpuBound: compressionEstimate(100 * MiB, .5 * MiB, .5, .25 * MiB, .25 * MiB) ?? null,
      invalid: compressionEstimate(100 * MiB, .5 * MiB, .5, Infinity, 50 * MiB) ?? null };
  });
  expect(result.cautious?.threshold).toBeCloseTo(.25 * 1048576 / 1.26); expect(result.overhead?.savedSeconds).toBeCloseTo(75.75); expect(result.tooMuchOverhead).toBeNull();
  expect(result.burst).toBeCloseTo(2621440 * 1000 / 10001); expect(result.sparse).toBe(32768); expect(result.points).toBeLessThan(55);
  expect(result.early).toBeNull(); expect(result.slow).toBe(524288); expect(result.fast).toBeNull(); expect(result.reset).toBeNull();
  expect(result.estimate?.savedSeconds).toBeCloseTo(80.25); expect(result.estimate?.threshold).toBe(1048576);
  expect([result.fastLink, result.small, result.random, result.cpuBound, result.invalid]).toEqual([null, null, null, null, null]);
});

test('gzip roundtrips, rejects truncation, corruption and an expanding body before storing it', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { gzip, gunzip, sampleCompression } = await import('/src/compression.ts');
    const raw = new Uint8Array(256 * 1024).fill(73), encoded = await gzip(raw.buffer);
    const decoded = new Uint8Array(await gunzip(encoded, raw.length));
    const bad = encoded.slice(0); new Uint8Array(bad)[bad.byteLength - 5] ^= 255;
    const forged = encoded.slice(0); new DataView(forged).setUint32(forged.byteLength - 4, 17, true);
    const rejected: boolean[] = [];
    for (const [body, size] of [[encoded, 17], [encoded, raw.length + 1], [encoded.slice(0, -3), raw.length], [bad, raw.length], [forged, 17]] as const) {
      try { await gunzip(body, size); rejected.push(false); } catch { rejected.push(true); }
    }
    const random = new Uint8Array(9 * 1048576); for (let offset = 0; offset < random.length; offset += 65536) crypto.getRandomValues(random.subarray(offset, offset + 65536));
    const rejectedSample = await sampleCompression(new File([random], 'already-compressed.mp4'), 0);
    return { matches: decoded.every(n => n === 73), size: encoded.byteLength, rejected, incompressible: !rejectedSample };
  });
  expect(result.matches).toBe(true); expect(result.size).toBeLessThan(1024); expect(result.rejected).toEqual([true, true, true, true, true]); expect(result.incompressible).toBe(true);
});

for (const action of ['complete', 'replace', 'cancel'] as const) test(`compressed blocks ${action}: original bytes, bounded writes and committed offsets`, async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async action => {
    const { Transfer } = await import('/src/protocol.ts');
    const { gzip, COMPRESSION } = await import('/src/compression.ts');
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const raw = new Uint8Array(256 * 1024).fill(77), encoded = await gzip(raw.buffer);
    const controls: any[] = [], events: any[] = [], writes: ArrayBuffer[] = [];
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', event => events.push(event));
    const state = transfer as any, channel: any = { readyState: 'open', send: (raw: string) => controls.push(JSON.parse(raw)), close() {} };
    state.attach(channel); state.accepted = true;
    state.handles = [{ createWritable: async () => ({ write: async (buffer: ArrayBuffer) => { writes.push(buffer.slice(0)); }, close: async () => {}, abort: async () => {} }) }];
    const send = async (message: any) => { channel.onmessage({ data: typeof message === 'object' && !(message instanceof ArrayBuffer) ? JSON.stringify(message) : message }); state.flushBinary(0); await state.queue; };
    await send({ type: 'manifest', files: [{ id: 0, name: '原文件.txt', type: 'text/plain', size: raw.length + 17 }], compression: COMPRESSION });
    await send({ type: 'file-start', id: 0, offset: 0 });
    // Mix ordinary bytes and compressed bytes, starting at a non-block offset.
    await send(new Uint8Array(17).fill(91).buffer);
    await send({ type: 'compression-advice', active: true });
    await send({ type: 'compressed-block', id: 0, offset: 17, raw: raw.length, size: encoded.byteLength });
    if (action === 'complete') {
      await send(encoded);
      const hash = sha256.create().update(new Uint8Array(17).fill(91)).update(raw).digest();
      await send({ type: 'file-end', id: 0, hash: Array.from(hash, n => n.toString(16).padStart(2, '0')).join('') });
      await send({ type: 'done' });
    } else {
      await send(encoded.slice(0, Math.floor(encoded.byteLength / 2)));
      if (action === 'cancel') transfer.close(false); else await transfer.replaceTransport();
    }
    const result = { completed: transfer.completed, received: state.received, offset: state.incoming?.received, block: !!state.encodedBlock,
      writes: writes.map(buffer => ({ size: buffer.byteLength, value: new Uint8Array(buffer)[0] })), acks: controls.filter(m => m.type === 'ack').map(m => m.bytes), errors: events.filter(e => e.type === 'error') };
    transfer.close(false); return result;
  }, action);
  expect(result.errors).toEqual([]); expect(result.block).toBe(false);
  if (action === 'complete') { expect(result.completed).toBe(true); expect(result.received).toBe(262161); expect(result.writes).toEqual([{ size: 17, value: 91 }, { size: 262144, value: 77 }]); expect(result.acks.at(-1)).toBe(262161); }
  else { expect(result.completed).toBe(false); expect(result.received).toBe(17); expect(result.writes).toEqual([{ size: 17, value: 91 }]); expect(result.acks).toEqual([]); if (action === 'replace') expect(result.offset).toBe(17); }
});

test('unnegotiated, oversized, out-of-order and incomplete compressed blocks fail without committing bytes', async ({ page }) => {
  await page.goto('./');
  const rejected = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts'), { gzip } = await import('/src/compression.ts');
    const encoded = await gzip(new Uint8Array(262144).buffer);
    const outcomes: number[] = [];
    for (const mode of ['unsupported', 'oversized', 'offset', 'partial', 'bomb', 'fragments']) {
      const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', () => {}), state = t as any;
      state.accepted = true; state.compressionSupport = mode !== 'unsupported'; state.compressionStatus = { active: true };
      t.manifest = [{ id: 0, name: 'test.txt', type: '', size: 262144 }]; state.channel = { readyState: 'open', send() {}, close() {} };
      await state.handle(JSON.stringify({ type: 'file-start', id: 0 }), 0);
      try {
        await state.handle(JSON.stringify({ type: 'compressed-block', id: 0, offset: mode === 'offset' ? 1 : 0, raw: mode === 'oversized' ? 262145 : mode === 'bomb' ? 17 : 262144, size: mode === 'fragments' ? 262144 : encoded.byteLength }), 0);
        if (mode === 'fragments') for (let i = 0; i < 513; i++) await state.handle(new Uint8Array([0]).buffer, 0);
        else if (mode === 'partial') { await state.handle(encoded.slice(0, 3), 0); await state.handle(JSON.stringify({ type: 'file-end', id: 0, hash: '' }), 0); }
        else await state.handle(encoded, 0);
        outcomes.push(-1);
      } catch { outcomes.push(state.received); }
      t.close(false);
    }
    return outcomes;
  });
  expect(rejected).toEqual([0, 0, 0, 0, 0, 0]);
});

for (const mode of ['keep', 'enable', 'reconnect', 'lost-enable'] as const) test(`a slow real data channel offers compression after measurement and restores originals (${mode})`, async ({ page, context, browserName }, info) => {
  const reconnect = mode === 'reconnect' || mode === 'lost-enable';
  const loseActivation = mode === 'lost-enable';
  test.skip(browserName === 'webkit', 'Real WebRTC is covered by desktop Chrome; WebKit exercises codecs, policy and bounded receiver handling.');
  await context.addInitScript(({ reconnect, loseActivation }) => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    const state = window as any; state.__wireBytes = 0; state.__blocks = 0; state.__cut = false; state.__starts = [];
    const queues = new WeakMap<RTCDataChannel, Promise<void>>(), nativeSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      const size = data instanceof ArrayBuffer ? data.byteLength : 0;
      const message = typeof data === 'string' ? JSON.parse(data) : undefined;
      if (message?.type === 'file-start') state.__starts.push(message);
      if (typeof data === 'string' && JSON.parse(data).type === 'compressed-block') state.__blocks++;
      const task = (queues.get(this) || Promise.resolve()).then(async () => {
        if (size) await new Promise(resolve => setTimeout(resolve, size * 1000 / (768 * 1024)));
        if (this.readyState === 'open' && loseActivation && message?.type === 'compression-advice' && message.active && !state.__cut) { state.__cut = true; this.close(); return; }
        if (this.readyState === 'open') { nativeSend.call(this, data); state.__wireBytes += size;
          if (reconnect && message?.type === 'compressed-block' && !state.__cut) { state.__cut = true; setTimeout(() => this.close(), 0); } }
      }); queues.set(this, task);
    } as any;
  }, { reconnect, loseActivation });
  const receiver = await context.newPage(); await page.goto('./');
  const buffer = Buffer.alloc(24 * 1048576 + 17, 76);
  await page.locator('#file-input').setInputFiles({ name: '原样还原.txt', mimeType: 'text/plain', buffer });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue());
  const started = performance.now(); await receiver.locator('#accept-files').click();
  await page.waitForTimeout(2500); await expect(page.locator('.compression-enable')).toHaveCount(0); await expect(receiver.locator('.compression-enable')).toHaveCount(0);
  const choose = receiver.locator('.compression-enable'); await expect(choose).toBeVisible({ timeout: 35000 });
  await expect(page.locator('.recipient-row .compression-enable')).toBeVisible();
  await receiver.locator('#language-toggle').click(); await expect(choose).toHaveText('Use compression'); await receiver.locator('#language-toggle').click();
  if (mode === 'enable') {
    await receiver.setViewportSize({ width: 320, height: 844 });
    await receiver.locator('#language-toggle').click();
    expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await receiver.locator('#compression-hint').screenshot({ path: info.outputPath('slow-compression-suggestion.png') });
    await receiver.locator('#language-toggle').click();
  }
  if (mode === 'keep') {
    await receiver.locator('.compression-dismiss').click();
    await expect(receiver.locator('#compression-hint')).toBeHidden();
    await expect(page.locator('.recipient-row .compression-hint')).toBeHidden();
  } else {
    if (loseActivation) await page.locator('.recipient-row .compression-enable').click(); else await choose.click();
    if (!loseActivation) await expect(receiver.locator('#compression-hint')).toContainText('压缩传输中');
  }
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备', { timeout: 60000 });
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  const elapsedSeconds = (performance.now() - started) / 1000;
  const wire = await page.evaluate(() => ({ bytes: (window as any).__wireBytes, blocks: (window as any).__blocks, cut: (window as any).__cut, starts: (window as any).__starts }));
  expect(wire.cut).toBe(reconnect);
  if (reconnect) expect(wire.starts.some((start: any) => start.offset > 0)).toBe(true);
  if (mode === 'keep') { expect(wire.blocks).toBe(0); expect(wire.bytes).toBe(buffer.length); }
  else { expect(wire.blocks).toBeGreaterThan(0); expect(wire.bytes).toBeLessThan(buffer.length * .8); }
  await info.attach('compression-measurement', { body: JSON.stringify({ mode, originalBytes: buffer.length, wireBytes: wire.bytes, compressedBlocks: wire.blocks, elapsedSeconds, controlledRateBytesPerSecond: 768 * 1024, originalHash: createHash('sha256').update(buffer).digest('hex') }), contentType: 'application/json' });
  await expect(receiver.locator('#compression-hint')).toBeHidden();
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click(); const download = await pending;
  expect(download.suggestedFilename()).toBe('原样还原.txt'); expect(createHash('sha256').update(await readFile((await download.path())!)).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'));
  await page.locator('#cancel').click();
});

for (const fallback of [false, true]) test(`sender compression preserves a multi-file stream and falls back for costly blocks (${fallback})`, async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async fallback => {
    const { Transfer, validateManifest } = await import('/src/protocol.ts');
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const hex = (data: Uint8Array) => Array.from(sha256(data), n => n.toString(16).padStart(2, '0')).join('');
    const data = new Uint8Array(1048576 + 17).fill(83);
    if (fallback) for (let offset = 0; offset < 3 * 262144; offset += 65536) crypto.getRandomValues(data.subarray(offset, offset + 65536));
    const sources = [data, new Uint8Array(0), new Uint8Array([1, 2, 3])];
    const output: Uint8Array[][] = [[], [], []], events: any[] = [], controls: any[] = [];
    const config = { signalUrl: '', iceServers: [], memoryLimitBytes: 2 * 1048576 };
    const sender = new Transfer(config, 'sender', e => events.push(e)), receiver = new Transfer(config, 'receiver', e => events.push(e));
    const send = sender as any, receive = receiver as any;
    sender.files = sources.map((raw, id) => new File([raw], id + '-原文件.txt', { type: 'text/plain' }));
    sender.manifest = receiver.manifest = validateManifest(sender.files.map((file, id) => ({ id, name: file.name, size: file.size, type: file.type })));
    let wireBytes = 0; const sizes: number[] = [];
    const deliver = (target: any, data: any) => {
      if (data instanceof ArrayBuffer) { wireBytes += data.byteLength; sizes.push(data.byteLength); }
      else controls.push(JSON.parse(data));
      queueMicrotask(() => target.channel.onmessage({ data }));
    };
    send.attach({ readyState: 'open', bufferedAmount: 0, send: (data: any) => deliver(receive, data), close() {} });
    receive.attach({ readyState: 'open', bufferedAmount: 0, send: (data: any) => deliver(send, data), close() {} });
    send.accepted = receive.accepted = true; send.compressionSupport = receive.compressionSupport = true;
    send.compressionFile = 0; send.compressionWireSpeed = 524288; send.compressionDecodeBps = 100 * 1048576;
    receive.handles = sources.map((_, id) => ({ createWritable: async () => ({ write: async (buffer: ArrayBuffer) => { output[id].push(new Uint8Array(buffer.slice(0))); }, close: async () => {}, abort: async () => {} }) }));
    await send.sendFiles(0, 0, 0); await receive.queue; await send.queue;
    const result = { completed: receiver.completed, hashes: output.map(parts => { const hash = sha256.create(); for (const part of parts) hash.update(part); return Array.from(hash.digest(), n => n.toString(16).padStart(2, '0')).join(''); }), expected: sources.map(hex),
      blocks: controls.filter(m => m.type === 'compressed-block').length, saved: controls.filter(m => m.type === 'file-saved').map(m => m.id), wireBytes, sizes, errors: events.filter(e => e.type === 'error'), active: send.compressionStatus.active };
    sender.close(false); receiver.close(false); return result;
  }, fallback);
  expect(result.completed).toBe(true); expect(result.errors).toEqual([]); expect(result.hashes).toEqual(result.expected); expect(result.saved).toEqual([0, 1, 2]); expect(result.active).toBe(false);
  expect(Math.max(...result.sizes)).toBeLessThanOrEqual(32768);
  if (fallback) { expect(result.blocks).toBe(0); expect(result.wireBytes).toBe(1048596); }
  else { expect(result.blocks).toBeGreaterThan(0); expect(result.wireBytes).toBeLessThan(10000); }
});

test('no capability, slow storage, paused and recovered-fast links never offer compression', async ({ page }) => {
  await page.goto('./');
  const states = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const results: boolean[] = [];
    for (const mode of ['old-peer', 'slow-disk', 'slow-source', 'background', 'recovering', 'fast']) {
      const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {}), state = t as any;
      t.files = [new File([new Uint8Array(10 * 1048576)], 'test.txt')];
      state.accepted = true; state.sendingFile = 0; state.sendingOffset = 1048576;
      state.compressionSupport = mode !== 'old-peer'; state.localHidden = mode === 'background'; t.recovering = mode === 'recovering';
      state.slowLink.speed = () => mode === 'fast' ? undefined : 524288;
      state.readBytes = 1048576; state.readMilliseconds = mode === 'slow-source' ? 10000 : 1;
      state.channel = { readyState: 'open', send() {}, close() {} };
      if (mode === 'slow-disk') {
        state.probe = { id: 1, file: 0, sample: { ratio: .1, compressBps: 20 * 1048576, encoded: new ArrayBuffer(1) }, generation: 0 };
        await state.handle(JSON.stringify({ type: 'compression-probed', id: 1, decompressBps: 20 * 1048576, writeBps: 131072 }), 0);
      } else {
        state.adviseCompression();
        // Optional source samples are asynchronous; let them finish before observing.
        while (state.probing) await new Promise(resolve => setTimeout(resolve, 5));
      }
      results.push(!!state.compressionStatus.offer || t.enableCompression()); t.close(false);
    }
    return results;
  });
  expect(states).toEqual([false, false, false, false, false, false]);
});

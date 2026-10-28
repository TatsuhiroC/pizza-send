import { test, expect } from '../fixtures';

test('a replacement transport repeats active compression state before its first compressed block', async ({ page }) => {
  await page.goto('./');
  const controls = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {}), state = t as any;
    const controls: any[] = [];
    state.channel = { readyState: 'open', bufferedAmount: 0, send(data: any) { if (typeof data === 'string') controls.push(JSON.parse(data)); }, close() {} };
    t.files = [new File([new Uint8Array(32768).fill(76)], 'resume.txt')];
    state.accepted = state.compressionSupport = true; state.fileConfirmed = 0;
    state.compressionFile = 0; state.compressionWireSpeed = 524288; state.compressionDecodeBps = 32 * 1048576;
    // The sender enabled compression on the old channel, but that notification
    // was lost before the receiver saw it. Local state is already active.
    state.compressionStatus = { active: true };
    await state.sendFiles(0, 0, 0); t.close(false); return controls;
  });
  const block = controls.findIndex(message => message.type === 'compressed-block');
  expect(block).toBeGreaterThanOrEqual(0);
  expect(controls.slice(0, block).some(message => message.type === 'compression-advice' && message.active)).toBe(true);
});

test('a new stable connection can retry an interrupted compression assessment', async ({ page }) => {
  await page.goto('./');
  const probes = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {}), state = t as any;
    const controls: any[] = [];
    state.channel = { readyState: 'open', send: (raw: string) => controls.push(JSON.parse(raw)), close() {} };
    t.files = [new File([new Uint8Array(10 * 1048576).fill(76)], 'slow.txt')];
    state.accepted = state.compressionSupport = true; state.sendingFile = 0; state.sendingOffset = 1048576;
    state.readBytes = 1048576; state.readMilliseconds = 1;
    state.sampledFiles.add(0);
    state.probe = { id: 1, file: 0, generation: 0, sample: { ratio: .1, compressBps: 32 * 1048576, encoded: new ArrayBuffer(0) } };
    state.resetCompressionAdvice();
    // The ordinary eight-second observation gate is tested independently. Here
    // the replacement connection has already produced fresh qualifying feedback.
    state.slowLink.speed = () => 524288;
    state.adviseCompression();
    while (state.probing) await new Promise(resolve => setTimeout(resolve, 5));
    t.close(false); return controls.filter(message => message.type === 'compression-probe').length;
  });
  expect(probes).toBe(1);
});

test('dismissed compression suggestions cannot reappear from queued advice after a reconnect', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const config = { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 };
    const receiver = new Transfer(config, 'receiver', () => {}), state = receiver as any;
    state.channel = { readyState: 'open', send() {}, close() {} }; state.compressionSupport = state.accepted = true;
    const advice = JSON.stringify({ type: 'compression-advice', active: false, offer: { file: 0, savedSeconds: 30, percent: 40 } });
    await state.handle(advice, 0); receiver.dismissCompression();
    await state.handle(advice, 0); const replayed = !!state.compressionStatus.offer;
    state.resetCompressionAdvice(); await state.handle(advice, 0); const restored = !!state.compressionStatus.offer;
    receiver.close(false);
    const sender = new Transfer(config, 'sender', () => {}), send = sender as any; const controls: any[] = [];
    send.channel = { readyState: 'open', send: (raw: string) => controls.push(JSON.parse(raw)), close() {} };
    send.accepted = send.compressionSupport = true; send.sendingFile = 0; send.sendingOffset = 1048576;
    sender.files = [new File([new Uint8Array(10 * 1048576).fill(76)], 'keep.txt')];
    send.readBytes = 1048576; send.readMilliseconds = 1;
    send.compressionStatus = { active: false, offer: { file: 0, savedSeconds: 30, percent: 40 } };
    sender.dismissCompression(); send.resetCompressionAdvice(); send.slowLink.speed = () => 524288;
    send.adviseCompression(); while (send.probing) await new Promise(resolve => setTimeout(resolve, 5));
    sender.close(false);
    return { replayed, restored, probes: controls.filter(message => message.type === 'compression-probe').length };
  });
  expect(result).toEqual({ replayed: false, restored: false, probes: 0 });
});

test('a delayed refusal survives a withdrawn offer and cannot suppress a different file', async ({ page }) => {
  await page.goto('./');
  const probes = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const results: number[] = [];
    for (const file of [0, 1]) {
      const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {}), state = t as any; const controls: any[] = [];
      state.channel = { readyState: 'open', send: (raw: string) => controls.push(JSON.parse(raw)), close() {} };
      state.accepted = state.compressionSupport = true; state.sendingFile = 0; state.sendingOffset = 1048576;
      t.files = [new File([new Uint8Array(10 * 1048576).fill(76)], 'later.txt')];
      state.readBytes = 1048576; state.readMilliseconds = 1;
      // A faster interval already withdrew the offer before the refusal arrives.
      await state.handle(JSON.stringify({ type: 'compression-dismiss', file }), 0);
      state.resetCompressionAdvice(); state.slowLink.speed = () => 524288; state.adviseCompression();
      while (state.probing) await new Promise(resolve => setTimeout(resolve, 5));
      results.push(controls.filter(message => message.type === 'compression-probe').length); t.close(false);
    }
    return results;
  });
  expect(probes).toEqual([0, 1]);
});

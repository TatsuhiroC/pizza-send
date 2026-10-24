import { test, expect } from './fixtures';

test('a stalled default source read reaches its deadline with a useful file error', async ({ page }) => {
  await page.goto('./'); await page.clock.install();
  await page.evaluate(async () => {
    const { readSource } = await import('/src/source-files.ts');
    const state = window as any; state.__sourceResult = undefined;
    const file = { name: 'stalled.txt', size: 1, slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) } as any;
    void readSource(file, 0, 1).catch(error => state.__sourceResult = { name: error.constructor.name, message: error.message });
  });
  await page.clock.fastForward(15001);
  await expect.poll(() => page.evaluate(() => (window as any).__sourceResult), { timeout: 1000 }).toMatchObject({ name: 'SourceReadError', message: expect.stringContaining('stalled.txt') });
});

test('cancelling a source read settles immediately and ignores the native late result', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { readSource } = await import('/src/source-files.ts');
    const controller = new AbortController(); let release!: (buffer: ArrayBuffer) => void;
    const file = { name: 'cancelled.txt', size: 1, slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(resolve => release = resolve) }) } as any;
    const reading = readSource(file, 0, 1, undefined, { signal: controller.signal }).then(() => 'resolved', error => error.name);
    controller.abort();
    const beforeNativeCompletion = await Promise.race([reading.then(result => result === 'AbortError'), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
    release(new ArrayBuffer(1));
    return { beforeNativeCompletion, result: await reading };
  });
  expect(result).toEqual({ beforeNativeCompletion: true, result: 'AbortError' });
});

test('closing a transfer cancels pending disk I/O before its native read returns', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const state = window as any;
    const t = state.__sourceTransfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {});
    const file = { name: 'pending.txt', type: 'text/plain', size: 256, slice: () => ({ arrayBuffer: () => new Promise(resolve => { state.__finishNativeRead = resolve; }) }) } as any;
    t.prepare([file]);
    state.__controls = [];
    t.channel = { readyState: 'open', bufferedAmount: 0, send: (data: any) => state.__controls.push(typeof data === 'string' ? JSON.parse(data).type : 'binary'), close() {} } as any;
    state.__sourceSettled = false;
    void (t as any).sendFiles(0, 0, 0).then(() => state.__sourceSettled = true, () => state.__sourceSettled = true);
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishNativeRead)).toBe('function');
  await page.evaluate(() => (window as any).__sourceTransfer.close(false));
  await expect.poll(() => page.evaluate(() => (window as any).__sourceSettled), { timeout: 1000 }).toBe(true);
  await page.evaluate(() => (window as any).__finishNativeRead(new ArrayBuffer(256)));
  expect(await page.evaluate(() => (window as any).__controls)).toEqual(['file-start']);
});

test('transport replacement cancels an old source read while the new generation can still send', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const state = window as any, t = state.__sourceTransfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {});
    let first = true;
    const file = { name: 'replaced.txt', type: 'text/plain', size: 256, slice: (start: number, end: number) => ({ arrayBuffer: () => {
      if (first) { first = false; return new Promise(resolve => state.__finishNativeRead = resolve); }
      return Promise.resolve(new ArrayBuffer(end - start));
    } }) } as any;
    t.prepare([file]);
    t.channel!.onclose = t.channel!.onerror = null;
    t.channel = { readyState: 'open', bufferedAmount: 0, send() {}, close() {} } as any;
    state.__sourceSettled = false;
    void (t as any).sendFiles(0, 0, 0).then(() => state.__sourceSettled = true, () => state.__sourceSettled = true);
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishNativeRead)).toBe('function');
  await page.evaluate(() => (window as any).__sourceTransfer.replaceTransport());
  await expect.poll(() => page.evaluate(() => (window as any).__sourceSettled), { timeout: 1000 }).toBe(true);
  const result = await page.evaluate(async () => {
    const t = (window as any).__sourceTransfer, messages: any[] = []; let bytes = 0;
    t.channel = { readyState: 'open', bufferedAmount: 0, send: (data: any) => { if (typeof data === 'string') messages.push(JSON.parse(data)); else bytes += data.byteLength; }, close() {} };
    t.fileConfirmed = 0;
    await t.sendFiles(0, 0, 1); t.close(false);
    return { bytes, messages: messages.map(message => message.type) };
  });
  expect(result).toEqual({ bytes: 256, messages: ['file-start', 'file-end', 'done'] });
});

test('source deadlines preserve background grace and give a resumed page a fresh read interval', async ({ page }) => {
  await page.goto('./'); await page.clock.install();
  await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const state = window as any;
    state.__sourceErrors = [];
    const t = state.__sourceTransfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', event => { if (event.type === 'error') state.__sourceErrors.push(event.data); });
    const file = { name: 'background.txt', type: 'text/plain', size: 1, slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) } as any;
    t.prepare([file]);
    t.channel = { readyState: 'open', bufferedAmount: 0, send() {}, close() {} } as any;
    (t as any).startSending(0, 0);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(20000);
  expect(await page.evaluate(() => (window as any).__sourceTransfer.stopped)).toBe(false);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(10000);
  expect(await page.evaluate(() => (window as any).__sourceErrors)).toEqual([]);
  await page.clock.fastForward(6000); await page.clock.fastForward(1100);
  await expect.poll(() => page.evaluate(() => (window as any).__sourceErrors)).toEqual([expect.stringContaining('background.txt')]);
  expect(await page.evaluate(() => (window as any).__sourceTransfer.stopped)).toBe(true);
});

test('a recipient leaving during source-error notification cannot overwrite the known failure', async ({ page }) => {
  await page.goto('./'); await page.clock.install();
  await page.route('http://127.0.0.1:8787/rooms/**', route => route.fulfill({ json: {} }));
  const during = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts'), { GroupSender } = await import('/src/group.ts');
    const state = window as any, config = { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 };
    let group: any;
    const transfer = new Transfer(config, 'sender', event => group.firstEvent(event));
    group = state.__sourceGroup = new GroupSender(transfer, config, [], '11'.repeat(32), 'http://127.0.0.1:8787', '22'.repeat(32), '33'.repeat(32), () => {}, () => {});
    const client = '44'.repeat(32);
    group.firstClient = client;
    const peer = state.__sourcePeer = { client, phase: 'sending', message: '正在传输', transfer, number: 1, file: 'source.txt', transferred: 0, total: 256, speed: 0, path: '', started: true };
    group.peers.set(client, peer);
    transfer.fail('无法读取原文件 source.txt', true);
    await group.consume({ multi: true, members: [], inviteExpiresAt: Date.now() + 60000 });
    return { phase: peer.phase, stopped: transfer.stopped };
  });
  expect(during).toEqual({ phase: 'sending', stopped: false });
  await page.clock.fastForward(1100);
  expect(await page.evaluate(() => ({ phase: (window as any).__sourcePeer.phase, message: (window as any).__sourcePeer.message }))).toEqual({ phase: 'error', message: '无法读取原文件 source.txt' });
  await page.evaluate(() => (window as any).__sourceGroup.close(false));
});

test('a source that stalls after pairing reports its read deadline to both real peers', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real WebRTC is covered in Chromium; read deadlines and cancellation also run in WebKit.');
  await context.addInitScript(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
  await page.addInitScript(() => {
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function() {
      const state = window as any;
      if (state.__stallSource && this.size <= 32768) return new Promise(resolve => state.__lateSourceRead = resolve);
      return original.call(this);
    };
  });
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'stalled-after-pairing.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(131072) });
  await page.locator('#start-send').click(); await expect(page.locator('#share-qr')).toBeVisible();
  const receiver = await context.newPage(); await receiver.goto(await page.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible();
  await page.evaluate(() => { (window as any).__stallSource = true; });
  await receiver.locator('#accept-files').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__lateSourceRead)).toBe('function');
  await expect(page.locator('.recipient-message')).toContainText('无法读取原文件', { timeout: 22000 });
  await expect(receiver.locator('#notice')).toContainText('发送方无法读取原文件');
  await expect(receiver.locator('.download-file')).toHaveCount(0);
  await page.evaluate(() => (window as any).__lateSourceRead(new ArrayBuffer(32768)));
  await expect(receiver.locator('.download-file')).toHaveCount(0);
  await page.locator('#cancel').click();
});

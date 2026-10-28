import { test, expect } from '../fixtures';

for (const stage of ['before-manifest', 'disconnected', 'legacy-receiver']) test(`a pending save picker accepted ${stage} during recovery starts the sender only once`, async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async stage => {
    const { Transfer } = await import('/src/protocol.ts');
    const config = { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 };
    const sender = new Transfer(config, 'sender', () => {}), send = sender as any;
    const receiver = new Transfer(config, 'receiver', () => {}), receive = receiver as any;
    const controls: any[] = [], starts: number[] = [];
    const file = new File(['picker recovery'], 'picker.txt', { type: 'text/plain' });
    sender.prepare([file]);
    send.generation = 1; sender.recovering = true;
    send.startSending = (id: number) => { starts.push(id); };
    receive.channel = { readyState: 'open', send: (raw: string) => controls.push(JSON.parse(raw)), close() {} };
    await receive.handle(JSON.stringify({ type: 'manifest', files: sender.manifest }), 0);
    const descriptor = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker');
    let choose!: (handle: unknown) => void;
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: () => new Promise(resolve => { choose = resolve; }) });
    try {
      const pending = receiver.accept();
      receiver.pauseRecovery(); await receiver.replaceTransport();
      // The replacement channel is open, but its repeated manifest has not
      // arrived yet when the operating system returns the chosen location.
      const channel = { readyState: 'open', send: (raw: string) => controls.push(JSON.parse(raw)), close() {} };
      if (stage !== 'disconnected') receive.channel = channel;
      choose({}); await pending;
      receive.channel = channel;
      await receive.handle(JSON.stringify({ type: 'manifest', files: sender.manifest }), 1);
      if (stage === 'legacy-receiver') controls.unshift({ type: 'accept' });
      for (const message of controls) if (['accept', 'resume'].includes(message.type)) await send.handle(JSON.stringify(message), 1);
      return { starts, accepted: sender.hasAccepted };
    } finally {
      sender.close(false); receiver.close(false);
      if (descriptor) Object.defineProperty(window, 'showSaveFilePicker', descriptor); else delete (window as any).showSaveFilePicker;
    }
  }, stage);
  expect(result).toEqual({ starts: [0], accepted: true });
});

for (const kind of ['oversized', 'backlog', 'byte-backlog', 'binary'] as const) test(`signaling rejects ${kind} service messages before processing them`, async ({ page }) => {
  await page.route('http://127.0.0.1:8787/rooms/**', route => route.fulfill({ json: route.request().method() === 'POST' ? { ticket: 'a'.repeat(64) } : { peerPresent: true } }));
  await page.goto('./');
  const result = await page.evaluate(async kind => {
    const { Signaling, signalKey } = await import('/src/protocol.ts');
    const OriginalSocket = window.WebSocket;
    const sockets: any[] = [], errors: string[] = [];
    class Socket {
      static OPEN = 1;
      readyState = 0;
      onopen?: () => void;
      onmessage?: (event: { data: unknown }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    }
    (window as any).WebSocket = Socket;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let processed = 0;
    const signal = new Signaling(await signalKey('b'.repeat(64)), async message => {
      if (message.type === 'hold') { await gate; processed++; }
    }, message => errors.push(message));
    try {
      await signal.connect('http://127.0.0.1:8787', 'c'.repeat(64), 'sender', 'd'.repeat(64));
      const socket = sockets[0];
      if (kind === 'binary') socket.onmessage({ data: new ArrayBuffer(32) });
      else if (kind === 'oversized') socket.onmessage({ data: JSON.stringify({ type: 'hold', padding: 'x'.repeat(128001) }) });
      else for (let i = 0; i < 5000 && socket.readyState === 1; i++) socket.onmessage({ data: JSON.stringify({ type: 'hold', padding: kind === 'byte-backlog' ? 'x'.repeat(60000) : '' }) });
      const closed = socket.readyState === 3;
      release(); await (signal as any).queue;
      return { closed, processed, errors, queued: (signal as any).queuedMessages, bytes: (signal as any).queuedBytes };
    } finally { signal.close(); release(); (window as any).WebSocket = OriginalSocket; }
  }, kind);
  expect(result.closed).toBe(true);
  expect(result.processed).toBeLessThanOrEqual(1);
  expect(result.queued).toBe(0); expect(result.bytes).toBe(0);
  expect(result.errors).toEqual(['配对消息超出安全限制，已断开配对服务。已建立的文件直传可以继续。']);
});

test('a real replacement channel retains a pending save location and delivers one original file', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real DataChannel recovery runs in Chromium; both engines cover the state and message limits above.');
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    const Peer = RTCPeerConnection, state = window as any;
    state.__pcs = []; state.__channels = []; state.__starts = 0; state.__manifests = 0;
    state.RTCPeerConnection = class extends Peer {
      constructor(config: RTCConfiguration) {
        super(config); state.__pcs.push(this);
        this.addEventListener('datachannel', event => state.__channels.push(event.channel));
      }
    };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        if (message.type === 'file-start') state.__starts++;
        if (message.type === 'manifest' && ++state.__manifests > 1) {
          state.__releaseManifest = () => { state.__releaseManifest = undefined; send.call(this, data); };
          return;
        }
      }
      return send.call(this, data);
    } as any;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
  const receiver = await context.newPage(), errors: string[] = [];
  for (const target of [page, receiver]) target.on('pageerror', error => errors.push(error.message));
  await receiver.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: () => new Promise(resolve => { (window as any).__chooseSave = resolve; }) });
  });
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'pending-picker.txt', mimeType: 'text/plain', buffer: Buffer.from('the selected path survives recovery') });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect.poll(() => receiver.evaluate(() => typeof (window as any).__chooseSave)).toBe('function');
  await receiver.evaluate(() => { (window as any).__pcs.at(-1).close(); });
  await expect.poll(() => page.evaluate(() => !!(window as any).__releaseManifest), { timeout: 40000 }).toBe(true);
  await expect.poll(() => receiver.evaluate(() => (window as any).__channels.at(-1)?.readyState)).toBe('open');
  await receiver.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('pending-picker-result.txt', { create: true });
    (window as any).__chooseSave(handle);
  });
  await expect(receiver.locator('#status')).toHaveText('网络切换，正在恢复连接');
  await page.evaluate(() => { (window as any).__releaseManifest(); });
  await expect(receiver.locator('#status')).toHaveText('已保存到设备');
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  expect(await page.evaluate(() => (window as any).__starts)).toBe(1);
  expect(await receiver.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('pending-picker-result.txt')).getFile()).text())).toBe('the selected path survives recovery');
  expect(errors).toEqual([]);
});

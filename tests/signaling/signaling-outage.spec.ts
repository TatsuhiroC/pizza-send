import { test, expect, type Page } from '../fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function pendingInitialPairing(page: Page, service: 'signaling' | 'group') {
  await page.route('http://127.0.0.1:8787/rooms/**', route => route.fulfill({ json: route.request().method() === 'POST' ?
    { ticket: 'a'.repeat(64) } : { peerPresent: false, multi: true, inviteExpiresAt: Date.now() + 1800000, members: [] } }));
  await page.goto('./'); await page.clock.install();
  await page.evaluate(async service => {
    const state = window as any;
    state.__initialSockets = [];
    state.WebSocket = class {
      static OPEN = 1;
      readyState = 0;
      constructor() { state.__initialSockets.push(this); }
      send() {}
      close() { this.readyState = 3; }
    };
    if (service === 'signaling') {
      const { Signaling, signalKey } = await import('/src/protocol.ts');
      state.__initialClient = new Signaling(await signalKey('b'.repeat(64)), async () => {}, () => {});
      state.__initialResult = state.__initialClient.connect('http://127.0.0.1:8787', 'c'.repeat(64), 'receiver', 'd'.repeat(64));
    } else {
      const { GroupSender } = await import('/src/group.ts');
      state.__initialClient = new GroupSender({} as any, { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, [], 'b'.repeat(64), 'http://127.0.0.1:8787', 'c'.repeat(64), 'd'.repeat(64), () => {}, () => {});
      state.__initialResult = state.__initialClient.connect();
    }
    state.__initialResult = state.__initialResult.then(() => 'connected', (error: Error) => error.name);
  }, service);
  await expect.poll(() => page.evaluate(() => (window as any).__initialSockets.length)).toBe(1);
}

for (const service of ['signaling', 'group'] as const) {
  test(`cancel immediately settles a pending initial ${service} handshake and prevents retries`, async ({ page }) => {
    await pendingInitialPairing(page, service);
    const result = await page.evaluate(async () => { const state = window as any; state.__initialClient.close(false); return await state.__initialResult; });
    expect(result).toBe('AbortError'); await page.clock.fastForward(120000);
    expect(await page.evaluate(() => (window as any).__initialSockets.map((socket: any) => socket.readyState))).toEqual([3]);
  });
  if (service === 'signaling') test('the initial signaling connection respects its total deadline and closes pending sockets', async ({ page }) => {
    await pendingInitialPairing(page, service); await page.clock.fastForward(60001);
    expect(await page.evaluate(() => (window as any).__initialResult)).toBe('TimeoutError');
    const attempts = await page.evaluate(() => (window as any).__initialSockets.length);
    await page.clock.fastForward(120000);
    expect(await page.evaluate(() => (window as any).__initialSockets.length)).toBe(attempts);
    expect(await page.evaluate(() => (window as any).__initialSockets.every((socket: any) => socket.readyState === 3))).toBe(true);
    await page.evaluate(() => (window as any).__initialClient.close(false));
  });
}

test('a timed-out group notification socket preserves the invitation and retries through polling', async ({ page }) => {
  await pendingInitialPairing(page, 'group'); await page.clock.fastForward(10001);
  expect(await page.evaluate(() => (window as any).__initialResult)).toBe('connected');
  expect(await page.evaluate(() => (window as any).__initialSockets[0].readyState)).toBe(3);
  await page.clock.fastForward(1501);
  await expect.poll(() => page.evaluate(() => (window as any).__initialSockets.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__initialClient.closed)).toBe(false);
  await page.evaluate(() => (window as any).__initialClient.close(false));
});

for (const target of ['group', 'group-offline', 'sender', 'receiver'] as const) test(`initial ${target} connection failures preserve the invitation and transfer the original file`, async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real local DataChannel transfer; retry and cancellation boundaries also run in WebKit.');
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
  let root = '', failures = 0, retries = 0;
  await context.routeWebSocket(url => url.hostname === '127.0.0.1' && !url.searchParams.has('transport'), route => {
    const url = new URL(route.url()), role = url.searchParams.get('role');
    if (!root && role === 'sender') root = url.pathname;
    const matches = target.startsWith('group') ? role === 'sender' && url.pathname === root :
      target === 'sender' ? role === 'sender' && url.pathname !== root : role === 'receiver';
    if (matches && (!failures || target === 'group-offline')) { failures++; route.close({ code: 1013, reason: 'Generated temporary failure' }); }
    else { if (matches) retries++; route.connectToServer(); }
  });
  const receiver = await context.newPage(), original = Buffer.alloc(131089, 73);
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'original-after-retry.txt', mimeType: 'text/plain', buffer: original });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  const invitation = await page.locator('#share-link').inputValue();
  root = '/rooms/' + await page.evaluate(async link => (await (await import('/src/share.ts')).parseShare(new URL(link).hash)).room, invitation);
  if (target === 'group') await expect.poll(() => retries).toBe(1);
  await receiver.goto(invitation); await expect(receiver.locator('#accept-files')).toBeVisible();
  expect(failures).toBeGreaterThanOrEqual(1);
  if (target === 'group-offline') expect(retries).toBe(0);
  else { expect(failures).toBe(1); expect(retries).toBeGreaterThanOrEqual(1); }
  await expect(page.locator('#share-link')).toHaveValue(invitation);
  await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('original-after-retry.txt');
  expect(createHash('sha256').update(await readFile((await download.path())!)).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
  // A new browser can still use the same parent invitation after the failure.
  const later = await context.newPage(); await later.goto(invitation);
  await expect(later.locator('#accept-files')).toBeVisible();
  await page.locator('#cancel').click();
});

for (const role of ['sender', 'receiver'] as const) test(`a service disconnect notice preserves a healthy ${role} data channel but still recovers a broken one`, async ({ page }) => {
  await page.goto('./');
  const requests = await page.evaluate(async role => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, role, () => {});
    const pair = new AutoPair(transfer, await signalKey('a'.repeat(64)), () => {});
    let requests = 0;
    transfer.requestRecovery = () => { requests++; };
    (pair as any).offered = true;
    Object.defineProperty(transfer.pc, 'connectionState', { configurable: true, value: 'connected' });
    const channel = { readyState: 'open', close() {} }; transfer.channel = channel as any;
    try {
      await (pair as any).handle({ type: 'peer-left' });
      const healthy = requests;
      channel.readyState = 'closed';
      await (pair as any).handle({ type: 'peer-left' });
      const broken = requests; channel.readyState = 'open';
      Object.defineProperty(transfer.pc, 'connectionState', { configurable: true, value: 'failed' });
      await (pair as any).handle({ type: 'peer-left' });
      return { healthy, broken, failed: requests };
    } finally { pair.close(); transfer.close(false); }
  }, role);
  expect(requests).toEqual({ healthy: 0, broken: 1, failed: 2 });
});

test('losing only the receiver signaling socket does not restart a healthy real file transfer', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real DataChannel outages run in Chromium; both engines cover lifecycle notices above.');
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    const state = window as any, Peer = RTCPeerConnection, Socket = WebSocket;
    state.__pcs = []; state.__sockets = []; state.__bytes = 0;
    state.RTCPeerConnection = class extends Peer { constructor(config: RTCConfiguration) { super(config); state.__pcs.push(this); } };
    state.WebSocket = class extends Socket { constructor(url: string) { super(url); state.__sockets.push(this); } };
    const read = Blob.prototype.arrayBuffer, send = RTCDataChannel.prototype.send;
    Blob.prototype.arrayBuffer = async function() { if (this.size <= 1048576) await new Promise(resolve => setTimeout(resolve, 3)); return read.call(this); };
    RTCDataChannel.prototype.send = function(data: any) { if (data instanceof ArrayBuffer) state.__bytes += data.byteLength; return send.call(this, data); } as any;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
  const receiver = await context.newPage(), original = Buffer.alloc(16 * 1048576, 87);
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'signal-independent.bin', mimeType: 'application/octet-stream', buffer: original });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue()); await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect.poll(() => page.evaluate(() => (window as any).__bytes)).toBeGreaterThan(1048576);
  await receiver.evaluate(() => { for (const socket of (window as any).__sockets) socket.close(); });
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  for (const target of [page, receiver]) expect(await target.evaluate(() => (window as any).__pcs.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__bytes)).toBe(original.length);
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  const actual = await readFile((await (await pending).path())!);
  expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
});

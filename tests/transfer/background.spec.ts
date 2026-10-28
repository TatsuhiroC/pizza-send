import { test, expect, type BrowserContext, type Page } from '../fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function setup(context: BrowserContext, mode: 'normal' | 'delayed' | 'denied' | 'unsupported' = 'normal') {
  await context.addInitScript(mode => {
    const state = window as any;
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    state.__hidden = false; state.__locks = []; state.__requests = 0; state.__releases = 0;
    state.__delay = mode === 'delayed'; state.__pending = [];
    Object.defineProperty(document, 'hidden', { get: () => state.__hidden });
    Object.defineProperty(document, 'visibilityState', { get: () => state.__hidden ? 'hidden' : 'visible' });
    state.__visibility = (hidden: boolean) => { state.__hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: mode === 'unsupported' ? undefined : {
      request: async () => {
        state.__requests++;
        if (mode === 'denied') throw new DOMException('Fixture denied', 'NotAllowedError');
        if (state.__delay) await new Promise(resolve => state.__pending.push(resolve));
        const lock = new EventTarget() as any; lock.released = false;
        lock.release = async () => { if (!lock.released) { lock.released = true; state.__releases++; lock.dispatchEvent(new Event('release')); } };
        state.__locks.push(lock); return lock;
      }
    } });
  }, mode);
}
async function share(page: Page) {
  await page.locator('#file-input').setInputFiles({ name: 'awake.txt', mimeType: 'text/plain', buffer: Buffer.from('keep awake') });
  await page.locator('#start-send').click();
  await expect(page.locator('#share-box')).toBeVisible();
}

test('a cached pagehide/pageshow cycle keeps the original invitation and files; explicit end still revokes it', async ({ page, context }) => {
  await setup(context); let ends = 0, navigations = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/rooms/')) {
      try { if (request.postDataJSON()?.type === 'end') ends++; } catch {}
    }
  });
  page.on('websocket', socket => socket.on('framesent', frame => {
    if (typeof frame.payload === 'string') { try { if (JSON.parse(frame.payload).type === 'end') ends++; } catch {} }
  }));
  await page.goto('./'); await share(page);
  const invitation = await page.locator('#share-link').inputValue();
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  const status = () => page.evaluate(async invitation => {
    const { parseShare } = await import('/src/share.ts'), { randomToken } = await import('/src/protocol.ts');
    const { groupURL } = await import('/src/group.ts'), { authenticatedRequest } = await import('/src/security.ts');
    const share = await parseShare(new URL(invitation).hash);
    return (await authenticatedRequest(groupURL('http://127.0.0.1:8787', share.room, 'receiver', share.receiver, randomToken()))).status;
  }, invitation);
  await page.evaluate(() => {
    (window as any).__visibility(true);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  expect(await status()).toBe(200); expect(ends).toBe(0);
  await page.evaluate(() => {
    (window as any).__visibility(false);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.locator('#share-link')).toHaveValue(invitation);
  await expect(page.locator('#status')).toHaveText('等待接收方');
  await expect(page.locator('#awake-panel')).toHaveAttribute('data-state', 'held');
  expect(await status()).toBe(200); expect(navigations).toBe(0); expect(ends).toBe(0);
  await page.locator('#cancel').click();
  await expect.poll(status).toBe(410);
});

test('a non-cached pagehide still ends the invitation', async ({ page, context }) => {
  await setup(context); await page.goto('./'); await share(page);
  const invitation = await page.locator('#share-link').inputValue();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  const receiver = await context.newPage(); await receiver.goto(invitation);
  await expect(receiver.locator('#notice')).toContainText('已过期或发送方已结束');
  await expect(receiver.locator('#accept-files')).toBeHidden();
});

test('screen wake lock follows visibility, user choice, OS release and cancellation', async ({ page, context }, info) => {
  await setup(context); await page.goto('./');
  await expect(page.locator('#awake-panel')).toBeHidden(); await share(page);
  await expect(page.locator('#awake-hint')).toContainText('已保持屏幕常亮');
  await expect(page.getByRole('switch', { name: '保持屏幕常亮' })).toBeChecked();
  await expect(page.locator('#awake-label')).toHaveText('保持常亮');
  await expect(page.locator('#awake-hint')).toBeHidden();
  expect(await page.locator('#awake-panel').evaluate(panel => panel.parentElement!.lastElementChild === panel)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#awake-panel').scrollIntoViewIfNeeded();
  expect((await page.locator('#awake-panel').boundingBox())!.height).toBeLessThanOrEqual(56);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('awake-mobile.png') });
  await page.locator('#awake-panel').screenshot({ path: info.outputPath('awake-switch-on.png'), animations: 'disabled' });
  await page.locator('#keep-awake').uncheck();
  await expect.poll(() => page.evaluate(() => (window as any).__releases)).toBe(1);
  await expect(page.locator('#awake-hint')).toContainText('已允许自动锁屏');
  await expect(page.locator('#awake-label')).toHaveText('关闭常亮');
  await expect(page.getByRole('switch', { name: '保持屏幕常亮' })).not.toBeChecked();
  await page.locator('#awake-panel').screenshot({ path: info.outputPath('awake-switch-off.png'), animations: 'disabled' });
  await page.locator('#keep-awake').check();
  await expect.poll(() => page.evaluate(() => (window as any).__requests)).toBe(2);
  await page.evaluate(() => (window as any).__visibility(true));
  await expect.poll(() => page.evaluate(() => (window as any).__releases)).toBe(2);
  await page.evaluate(() => (window as any).__visibility(false));
  await expect.poll(() => page.evaluate(() => (window as any).__requests)).toBe(3);
  await page.evaluate(() => (window as any).__locks.at(-1).release());
  await expect(page.locator('#retry-awake')).toBeVisible();
  await page.locator('#retry-awake').click();
  await expect(page.locator('#awake-hint')).toContainText('已保持屏幕常亮');
  await page.locator('#language-toggle').click();
  await expect(page.locator('#awake-hint')).toContainText('Screen stays awake');
  await expect(page.locator('#awake-label')).toHaveText('Keep awake');
  await expect(page.getByRole('switch', { name: 'Keep screen awake' })).toBeChecked();
  await page.locator('#cancel').click();
  await expect.poll(() => page.evaluate(() => (window as any).__releases)).toBe(4);
  await expect(page.locator('#awake-panel')).toBeHidden();
  await page.evaluate(() => { (window as any).__visibility(true); (window as any).__visibility(false); });
  expect(await page.evaluate(() => (window as any).__requests)).toBe(4);
});

test('background grace is bounded, foreground failures still time out and cancellation removes the deadline', async ({ page, context }) => {
  await setup(context); await page.goto('./'); await page.clock.install();
  await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const state = window as any; state.__errors = [];
    state.__newTransfer = () => {
      const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', event => { if (event.type === 'error') state.__errors.push(event.data); });
      transfer.enableRecovery(() => {}); return transfer;
    };
    state.__visibility(true); state.__deadlineTransfer = state.__newTransfer(); state.__deadlineTransfer.pauseRecovery();
  });
  await page.clock.fastForward(120001);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
  await page.clock.fastForward(480001);
  expect(await page.evaluate(() => (window as any).__errors)).toEqual(['后台等待已超过 10 分钟，请回到双方页面重新创建传输。']);
  await page.evaluate(() => { const state = window as any; state.__visibility(false); state.__deadlineTransfer = state.__newTransfer(); state.__deadlineTransfer.pauseRecovery(); });
  await page.clock.fastForward(120001);
  expect(await page.evaluate(() => (window as any).__errors)).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).__errors[1])).toContain('已等待两分钟');
  await page.evaluate(() => { const state = window as any; const transfer = state.__newTransfer(); transfer.pauseRecovery(); transfer.close(); });
  await page.clock.fastForward(600001);
  expect(await page.evaluate(() => (window as any).__errors)).toHaveLength(2);
});

test('a late OS request is released and cannot attach to a replacement share', async ({ page, context }) => {
  await setup(context, 'delayed'); await page.goto('./'); await share(page);
  await expect.poll(() => page.evaluate(() => (window as any).__requests)).toBe(1);
  await page.locator('#cancel').click(); await share(page);
  await page.evaluate(() => { const state = window as any; state.__delay = false; state.__pending.shift()(); });
  await expect(page.locator('#awake-hint')).toContainText('已保持屏幕常亮');
  expect(await page.evaluate(() => ({ requests: (window as any).__requests, released: (window as any).__releases }))).toEqual({ requests: 2, released: 1 });
  await page.locator('#cancel').click();
  await expect.poll(() => page.evaluate(() => (window as any).__releases)).toBe(2);
});

for (const mode of ['denied', 'unsupported'] as const) test(`${mode} wake lock does not claim protection or prevent sharing`, async ({ page, context }) => {
  await setup(context, mode); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('./'); await share(page);
  await expect(page.locator('#awake-hint')).toContainText(mode === 'denied' ? '常亮暂不可用' : '不支持常亮');
  if (mode === 'unsupported') await expect(page.locator('#keep-awake')).toBeDisabled();
  else await expect(page.locator('#keep-awake')).toBeEnabled();
  if (mode === 'denied') await expect(page.locator('#retry-awake')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#cancel').click();
});

test('a background recipient leaving clears its notice without releasing another recipient’s wake lock', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real multi-recipient DataChannels run in Chromium.');
  await setup(context);
  await context.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
  await page.goto('./'); await share(page);
  const link = await page.locator('#share-link').inputValue();
  const first = await context.newPage(), second = await context.newPage();
  for (const receiver of [first, second]) {
    await receiver.goto(link); await expect(receiver.locator('#accept-files')).toBeVisible();
    await expect(receiver.getByRole('switch', { name: '保持屏幕常亮' })).toBeChecked();
    expect(await receiver.locator('#awake-panel').evaluate(panel => panel.parentElement!.lastElementChild === panel)).toBe(true);
  }
  await expect(page.locator('.recipient-row')).toHaveCount(2);
  await first.evaluate(() => (window as any).__visibility(true));
  await expect(page.locator('#background-note')).toBeVisible();
  await first.locator('#cancel').click();
  await expect(page.locator('.recipient-row[data-phase="left"]')).toHaveCount(1);
  await expect(page.locator('#background-note')).toBeHidden();
  await expect(page.locator('#awake-hint')).toContainText('已保持屏幕常亮');
  expect(await page.evaluate(() => (window as any).__releases)).toBe(0);
  await second.locator('#accept-files').click();
  await expect(second.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await expect(page.locator('#awake-panel')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__releases)).toBe(1);
  await page.locator('#cancel').click();
});

async function transferFixture(context: BrowserContext) {
  await setup(context);
  await context.addInitScript(() => {
    const state = window as any, Peer = RTCPeerConnection, Socket = WebSocket;
    state.__pcs = []; state.__sockets = []; state.__starts = []; state.__sent = 0; state.__hold = false; state.__offset = 0;
    const now = Date.now; Date.now = () => now() + state.__offset;
    state.RTCPeerConnection = class extends Peer { constructor(config: RTCConfiguration) { super(config); state.__pcs.push(this); } };
    state.WebSocket = class extends Socket { constructor(url: string, protocols?: string | string[]) { super(url, protocols); state.__sockets.push(this); } };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (data instanceof ArrayBuffer) state.__sent += data.byteLength;
      else if (typeof data === 'string' && JSON.parse(data).type === 'file-start') state.__starts.push(JSON.parse(data));
      return send.call(this, data);
    } as any;
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function() {
      if (this.size <= 1048576) { while (state.__hold) await new Promise(resolve => setTimeout(resolve, 20)); await new Promise(resolve => setTimeout(resolve, 2 * Math.ceil(this.size / 32768))); }
      return read.call(this);
    };
    const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    const timers = new Map<number, () => void>();
    state.setTimeout = (fn: () => void, delay: number, ...args: any[]) => {
      let id: number; id = timeout(() => { timers.delete(id); fn(...args); }, delay);
      if (delay === 120000) timers.set(id, () => { clear(id); timers.delete(id); fn(...args); });
      return id;
    };
    state.clearTimeout = (id: number) => { timers.delete(id); clear(id); };
    state.__expireRecovery = () => { for (const fn of [...timers.values()]) fn(); };
    state.__timerCount = () => timers.size;
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
}

for (const background of ['sender', 'receiver'] as const) test(`${background} returns from cached background after the ordinary recovery deadline and resumes original bytes`, async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real DataChannel transfers run in Chromium; UI and lock lifecycle also run in WebKit.');
  await transferFixture(context); const receiver = await context.newPage();
  const diagnostics: unknown[] = [];
  for (const p of [page, receiver]) {
    p.on('response', response => { if (response.status() >= 400) diagnostics.push({ status: response.status(), method: response.request().method(), path: new URL(response.url()).pathname.replace(/[a-f0-9]{64}/g, '[room]') }); });
    p.on('pageerror', error => diagnostics.push({ error: error.message }));
  }
  const buffer = Buffer.alloc(8 * 1048576, 79);
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'background-original.bin', mimeType: 'application/octet-stream', buffer });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue()); await receiver.locator('#accept-files').click();
  await expect.poll(() => page.evaluate(() => (window as any).__sent)).toBeGreaterThan(1048576);
  await page.evaluate(() => { (window as any).__hold = true; });
  for (const p of [page, receiver]) await p.evaluate(async () => {
    const { AutoPair } = await import('/src/protocol.ts'); const prototype = AutoPair.prototype as any, recover = prototype.recover;
    prototype.recover = function() { (window as any).__pair = this; return recover.call(this); };
  });
  const hidden = background === 'sender' ? page : receiver, other = background === 'sender' ? receiver : page;
  await hidden.evaluate(() => {
    (window as any).__visibility(true);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expect(other.locator('#background-note')).toBeVisible();
  for (const p of [page, receiver]) await p.evaluate(() => {
    const state = window as any; state.__cutPC = state.__pcs.at(-1); state.__cutSockets = [...state.__sockets];
  });
  await context.setOffline(true);
  for (const p of [page, receiver]) await p.evaluate(() => {
    const state = window as any; state.__cutPC.close(); for (const socket of state.__cutSockets) if (socket.url.includes('/rooms/')) socket.close();
  });
  for (const p of [page, receiver]) await expect.poll(() => p.evaluate(() => (window as any).__timerCount())).toBeGreaterThan(0);
  for (const p of [page, receiver]) await p.evaluate(() => { const state = window as any; state.__offset = 3 * 60000; state.__expireRecovery(); });
  await expect(receiver.locator('#notice')).not.toContainText('已等待两分钟');
  await expect(page.locator('.recipient-row[data-phase="error"]')).toHaveCount(0);
  await hidden.evaluate(() => {
    (window as any).__visibility(false);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await context.setOffline(false); await page.evaluate(() => { (window as any).__hold = false; });
  try { await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备', { timeout: 30000 }); }
  catch (error) {
    for (const p of [page, receiver]) diagnostics.push(await p.evaluate(() => {
      const state = window as any, pair = state.__pair, transfer = pair?.transfer;
      return { status: document.getElementById('status')?.textContent, notice: document.getElementById('notice')?.textContent, recipients: document.getElementById('recipients')?.textContent, starts: state.__starts, pcs: state.__pcs.map((pc: RTCPeerConnection) => [pc.connectionState, pc.signalingState]), sockets: state.__sockets.map((ws: WebSocket) => ws.readyState), pair: pair && { negotiating: pair.negotiating, epoch: pair.epoch, closed: pair.closed, elapsed: Date.now() - pair.lastAttempt, signalClosed: pair.signal.closed, connecting: !!pair.signal.connecting }, transfer: transfer && { stopped: transfer.stopped, recovering: transfer.recovering, generation: transfer.generation, hidden: transfer.localHidden, peerHidden: transfer.peerHidden, grace: transfer.backgroundDeadline - Date.now() } };
    }));
    console.log('Background recovery diagnostics', JSON.stringify(diagnostics)); throw error;
  }
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  expect(await page.evaluate(() => (window as any).__starts.some((s: any) => s.offset > 0))).toBe(true);
  await expect(page.locator('#awake-panel')).toBeHidden(); await expect(receiver.locator('#awake-panel')).toBeHidden();
  await expect(receiver.locator('#background-note')).toBeHidden();
  await expect(receiver.locator('#notice')).toBeHidden();
  const download = receiver.waitForEvent('download'); await receiver.locator('.download-file').click(); const file = await download;
  expect(file.suggestedFilename()).toBe('background-original.bin');
  expect(createHash('sha256').update(await readFile((await file.path())!)).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'));
  for (const p of [page, receiver]) expect(await p.evaluate(() => (window as any).__locks.every((lock: any) => lock.released))).toBe(true);
  await page.locator('#cancel').click();
});

test('compact wake switch supports keyboard, remembers the choice and fits a narrow English layout', async ({ page, context }) => {
  await setup(context); await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('./'); await share(page);
  const control = page.getByRole('switch', { name: '保持屏幕常亮' });
  await control.focus(); await page.keyboard.press('Space');
  await expect(page.locator('#awake-label')).toHaveText('关闭常亮');
  await expect(control).not.toBeChecked();
  await page.locator('#language-toggle').click();
  await expect(page.locator('#awake-label')).toHaveText('Keep awake off');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // A wider system font exposes the enlarged hero's overflow on Linux WebKit.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const widerFont = await page.addStyleTag({ content: ':root{font-family:Verdana,sans-serif}' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await widerFont.evaluate(node => node.remove());
  await page.locator('#cancel').click();
  await page.reload(); await share(page);
  const restored = page.getByRole('switch', { name: 'Keep screen awake' });
  await expect(restored).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).__requests)).toBe(0);
  await restored.check();
  await expect(page.locator('#awake-panel')).toHaveAttribute('data-state', 'held');
  await expect(page.locator('#awake-label')).toHaveText('Keep awake');
  await page.locator('#cancel').click();
});

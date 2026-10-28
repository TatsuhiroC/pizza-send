import { test, expect, type BrowserContext, type Page, type WebSocketRoute } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { shareFragment } from '../src/share';
const settings = { signalUrl: 'http://127.0.0.1:8787', iceServers: [], memoryLimitBytes: 268435456 };
const generated = { name: '兼容性-generated.txt', mimeType: 'text/plain', buffer: Buffer.from('Generated content: authenticated encrypted relay.\n'.repeat(7000)) };
async function config(page: Page) { await page.route('**/app.config.json', route => route.fulfill({ json: settings })); }
async function relay(context: BrowserContext) {
  const sockets = new Map<string, WebSocketRoute>(); let frames = 0;
  await context.route(settings.signalUrl + '/rooms/**', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON()?.type === 'stream-connect') {
      expect(request.headers().authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
      await route.fulfill({ json: { ticket: 'e'.repeat(64) } });
    } else await route.fallback();
  });
  await context.routeWebSocket(url => url.hostname === '127.0.0.1' && url.searchParams.get('transport') === 'stream', socket => {
    const url = new URL(socket.url()), session = url.searchParams.get('session')!, role = url.searchParams.get('role')!;
    expect(url.searchParams.has('token')).toBe(false);
    const opposite = session + (role === 'sender' ? 'receiver' : 'sender'); sockets.set(session + role, socket);
    socket.onMessage(data => {
      if (typeof data === 'string') { expect(JSON.parse(data).type).toBe('credit'); return; }
      frames++; expect(data.includes(generated.buffer.subarray(0, 40))).toBe(false); sockets.get(opposite)?.send(data);
    });
    if (sockets.has(opposite)) for (const peer of [socket, sockets.get(opposite)!]) peer.send(JSON.stringify({ type: 'stream-ready' }));
  });
  return {
    frames: () => frames,
    opened: () => sockets.size,
    dropSender: async () => {
      const sending = [...sockets.entries()].filter(([key]) => key.endsWith('sender'));
      await sending[sending.length - 1][1].close({ code: 1012, reason: 'Generated reconnection test' });
    }
  };
}

test('missing newer abort APIs keep authenticated pairing, deadlines, and source checks working', async ({ page }) => {
  await config(page); await page.goto('./');
  await page.route('https://fixture.invalid/**', route => {
    expect(new URL(route.request().url()).searchParams.has('token')).toBe(false);
    expect(route.request().headers().authorization).toBe('Bearer generated-credential');
    return route.fulfill({ json: { ok: true } });
  });
  const result = await page.evaluate(async () => {
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, value: undefined });
    const { groupRequest } = await import('/src/group.ts');
    const { checkSources } = await import('/src/source-files.ts');
    const { fetchWithTimeout } = await import('/src/request-timeout.ts');
    const payload = await groupRequest('https://fixture.invalid/rooms/generated?token=generated-credential');
    await checkSources([new File(['generated'], 'generated.txt')], () => true, new AbortController().signal);
    const native = window.fetch;
    window.fetch = (_input, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason)));
    try {
      let timeout = '', bodyTimeout = '';
      try { await fetchWithTimeout('/never', {}, 10); } catch (error) { timeout = (error as Error).name; }
      window.fetch = async (_input, options) => new Response(new ReadableStream({ start(controller) {
        options!.signal!.addEventListener('abort', () => controller.error(options!.signal!.reason));
      } }));
      try { await fetchWithTimeout('/stalled-json', {}, 10, response => response.json()); } catch (error) { bodyTimeout = (error as Error).name; }
      return { payload, timeout, bodyTimeout };
    }
    finally { window.fetch = native; }
  });
  expect(result).toEqual({ payload: { ok: true }, timeout: 'TimeoutError', bodyTimeout: 'TimeoutError' });
});

test('caller cancellation does not retry pairing and expired request timers are removed', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { retryPairingRequest } = await import('/src/security.ts');
    const { fetchWithTimeout } = await import('/src/request-timeout.ts');
    const native = window.fetch; let calls = 0, successfulSignal: AbortSignal;
    window.fetch = async (_input, options) => { calls++; options!.signal!.throwIfAborted(); successfulSignal = options!.signal!; return new Response('{}'); };
    const controller = new AbortController(); controller.abort();
    let cancelled = '';
    try { await retryPairingRequest(location.origin, { signal: controller.signal }); } catch (error) { cancelled = (error as Error).name; }
    await fetchWithTimeout(location.origin, {}, 10); await new Promise(resolve => setTimeout(resolve, 30));
    window.fetch = native;
    return { calls, cancelled, timerStillActive: successfulSignal!.aborted };
  });
  expect(result).toEqual({ calls: 2, cancelled: 'AbortError', timerStillActive: false });
});

test('a system-camera invitation arriving in an existing tab starts receiving once', async ({ page }) => {
  await config(page); let requests = 0;
  await page.route(settings.signalUrl + '/rooms/**', route => { requests++; return route.fulfill({ status: 410 }); });
  await page.goto('./'); await page.locator('#file-input').setInputFiles(generated); await expect(page.locator('#start-send')).toBeEnabled();
  const fragment = shareFragment('11'.repeat(32));
  await page.evaluate(fragment => { location.hash = fragment; }, fragment);
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator('#receive-code')).toHaveValue(new RegExp('#' + fragment.replace('.', '\\.')));
  await expect(page.locator('#notice')).toContainText('分享链接已过期');
  expect(requests).toBe(1);
});

test('an invitation with a missing fragment explains the loss and never sends a secret in HTTP', async ({ page }) => {
  await config(page); let requests = 0;
  await page.route(settings.signalUrl + '/rooms/**', route => { requests++; return route.fulfill({ status: 410 }); });
  await page.goto('./?receive=1');
  await expect(page.locator('#receive-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#notice')).toContainText('分享链接缺少配对信息');
  expect(requests).toBe(0);
});

test('configuration failure preserves the complete invitation visibly for retry', async ({ page }) => {
  await page.route('**/app.config.json', route => route.fulfill({ status: 503 }));
  await page.goto('./?receive=1#' + shareFragment('22'.repeat(32)));
  await expect(page.locator('#receive-code')).toHaveValue(page.url());
  await expect(page.locator('#notice')).toContainText('连接配置加载失败');
  await expect(page.locator('#retry-config')).toBeVisible();
});

test('a browser without cryptography explains the problem while retaining its invitation', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window.crypto, 'subtle', { configurable: true, value: undefined }));
  await page.goto('./?receive=1#' + shareFragment('33'.repeat(32)));
  await expect(page.locator('#receive-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#receive-code')).toHaveValue(page.url());
  await expect(page.locator('#notice')).toContainText('缺少安全传输能力');
  await expect(page.locator('#connect-receive')).toBeDisabled();
});

test('late ICE on a closed direct connection is ignored, while real candidate errors still surface', async ({ page }) => {
  await page.goto('./');
  const nativeAvailable = await page.evaluate(() => {
    let peer: RTCPeerConnection | undefined;
    try { peer = new RTCPeerConnection({ iceServers: [] }); peer.createDataChannel('capability-check').close(); return true; }
    catch { return false; }
    finally { peer?.close(); }
  });
  test.skip(!nativeAvailable, 'This engine cannot create native WebRTC data channels; encrypted relay is tested separately.');
  const result = await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const settings = { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 };
    const sender = new Transfer(settings, 'sender', () => {}), receiver = new Transfer(settings, 'receiver', () => {});
    const pair = new AutoPair(receiver, await signalKey('44'.repeat(32)), () => {});
    try {
      await receiver.answer(await sender.offer(true), true);
      const candidate = { candidate: 'candidate:invalid' };
      const native = receiver.pc.addIceCandidate;
      receiver.pc.addIceCandidate = async () => { throw new DOMException('Invalid candidate fixture', 'OperationError'); };
      let invalid = '';
      try { await (pair as any).handle({ type: 'candidates', epoch: 0, candidates: [candidate] }, true); } catch (error) { invalid = (error as Error).name; }
      receiver.pc.addIceCandidate = native; receiver.pc.close();
      await (pair as any).handle({ type: 'candidates', epoch: 0, candidates: [null] }, true);
      return { invalid, queued: (pair as any).remoteCandidates.length };
    } finally { pair.close(); sender.close(false); receiver.close(false); }
  });
  expect(result).toEqual({ invalid: 'OperationError', queued: 0 });
});

test('blocked application scripts leave readable startup help instead of an empty document', async ({ page }) => {
  await page.route(url => url.pathname === '/src/main.ts', route => route.abort());
  await page.goto('./');
  await expect(page.locator('#app')).toContainText('完整分享链接');
  await expect(page.locator('#app')).toContainText('updated browser');
});

test('relay-only negotiation rejects unauthenticated capabilities and times out an outdated peer clearly', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined }));
  await config(page); await page.goto('./'); await page.clock.install();
  await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const state = window as any; state.__compatErrors = [];
    const transfer = state.__compatTransfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', event => { if (event.type === 'error') state.__compatErrors.push(event.data); });
    const pair = state.__compatPair = new AutoPair(transfer, await signalKey('55'.repeat(32)), () => {}, '55'.repeat(32));
    pair.signal.send = async () => {};
    await pair.handle({ type: 'transport-capabilities', v: 1, direct: false, streamSupport: 1, quickRelaySupport: 1 });
    if (pair.streamFallback.supported) throw Error('Unauthenticated capability accepted');
    await pair.handle({ type: 'signal-ready', peerPresent: true });
  });
  await page.clock.fastForward(15001);
  expect(await page.evaluate(() => (window as any).__compatErrors)).toEqual([expect.stringContaining('双方刷新网页')]);
  await page.evaluate(() => { (window as any).__compatPair.close(); (window as any).__compatTransfer.close(false); });
});

test('relay-only connection failure has a deadline even when no native ICE timeout exists', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: undefined }));
  await config(page); await page.goto('./'); await page.clock.install();
  await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const state = window as any; state.__deadlineErrors = [];
    const transfer = state.__deadlineTransfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', event => { if (event.type === 'error') state.__deadlineErrors.push(event.data); });
    const pair = state.__deadlinePair = new AutoPair(transfer, await signalKey('66'.repeat(32)), () => {}, '66'.repeat(32));
    pair.signal.send = async () => {}; pair.streamFallback.monitor = () => {};
    await pair.handle({ type: 'transport-capabilities', v: 1, direct: false, streamSupport: 1, quickRelaySupport: 1 }, true);
  });
  await page.clock.fastForward(60001);
  expect(await page.evaluate(() => (window as any).__deadlineErrors)).toEqual([expect.stringContaining('加密转发未能建立')]);
  await page.evaluate(() => { (window as any).__deadlinePair.close(); (window as any).__deadlineTransfer.close(false); });
});

for (const unavailable of ['sender', 'receiver', 'both', 'constructor-denied', 'data-channel-denied'] as const) test(`encrypted file relay works when native WebRTC is unavailable on ${unavailable}`, async ({ page, context }) => {
  const receiver = await context.newPage(), errors: string[] = [];
  for (const current of [page, receiver]) {
    current.on('pageerror', error => errors.push(error.message));
    await current.addInitScript(() => {
      Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
      Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, value: undefined });
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    });
  }
  if (unavailable === 'data-channel-denied') for (const current of [page, receiver]) await current.addInitScript(() => {
    if (typeof HTMLDialogElement !== 'undefined') Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: undefined });
  });
  for (const current of unavailable === 'both' ? [page, receiver] : unavailable === 'receiver' ? [receiver] : [page]) {
    await current.addInitScript(mode => {
      const Native = RTCPeerConnection;
      const value = mode === 'constructor-denied' ? function() { throw new DOMException('Disabled by browser', 'NotSupportedError'); } :
        mode === 'data-channel-denied' ? class extends Native { createDataChannel(): RTCDataChannel { throw new DOMException('Data channels disabled', 'NotSupportedError'); } } : undefined;
      Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value });
    }, unavailable);
  }
  if (unavailable === 'both') await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function() { if (this.size <= 32768) await new Promise(resolve => setTimeout(resolve, 8)); return read.call(this); };
  });
  const forwarded = await relay(context);
  const payload = unavailable === 'both' ? { ...generated, buffer: Buffer.from(generated.buffer.toString().repeat(24)) } : generated;
  await config(page); await page.goto('./'); await page.locator('#file-input').setInputFiles(payload);
  await page.locator('#start-send').click(); await expect(page.locator('#share-qr')).toBeVisible();
  const url = await page.locator('#share-link').inputValue();
  expect(new URL(url).searchParams.get('receive')).toBe('1');
  expect(new URL(url).searchParams.has('key')).toBe(false);
  await config(receiver); await receiver.goto(url);
  await expect(receiver.locator('#accept-files')).toBeVisible({ timeout: 20000 });
  // The URL is scrubbed only after the file manifest actually arrives.
  expect(new URL(receiver.url()).hash).toBe('');
  expect(new URL(receiver.url()).searchParams.has('receive')).toBe(false);
  await receiver.locator('#accept-files').click();
  if (unavailable === 'both') {
    await expect.poll(async () => Number(await receiver.locator('#progress').getAttribute('value'))).toBeGreaterThan(0);
    await forwarded.dropSender();
    await expect.poll(() => forwarded.opened()).toBeGreaterThan(2);
  }
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await expect(receiver.locator('#route-controls [data-route="direct"]')).toBeDisabled();
  await expect(receiver.locator('#route-controls .route-hint')).toContainText('端到端加密');
  expect(forwarded.frames()).toBeGreaterThan(0);
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(generated.name);
  const output = await readFile((await download.path())!);
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  expect(hash(output)).toBe(hash(payload.buffer)); expect(errors).toEqual([]);
  await page.locator('#cancel').click();
});

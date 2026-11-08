import { test, expect, type BrowserContext, type Page, type Request } from '../fixtures';
import jsQR from 'jsqr';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const api = 'http://127.0.0.1:8787';
const file = { name: 'share-ready.txt', mimeType: 'text/plain', buffer: Buffer.from('A published invitation must not wait for its sender notification socket.') };

async function setup(context: BrowserContext) {
  await context.addInitScript(signal => {
    localStorage.setItem('pizza-send-signal', signal);
    localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  }, api);
}

async function holdSenderRequest(page: Page, phase: 'member-state' | 'socket-ticket', fail = false) {
  let unblock!: () => void, entered!: () => void, completed!: () => void, first = true;
  let parentPath: string | undefined;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const finished = new Promise<void>(resolve => { completed = resolve; });
  await page.route(api + '/rooms/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!parentPath && url.searchParams.get('role') === 'sender' && request.method() === 'GET') parentPath = url.pathname;
    const matching = url.searchParams.get('role') === 'sender' &&
      (phase === 'member-state' ? request.method() === 'GET' : url.pathname === parentPath && request.method() === 'POST' && request.postDataJSON()?.type === 'connect');
    if (!matching || !first) return route.fallback();
    const finish = (candidate: Request) => {
      if (candidate !== request) return;
      page.off('requestfinished', finish); page.off('requestfailed', finish); completed();
    };
    page.on('requestfinished', finish); page.on('requestfailed', finish);
    first = false; entered(); await gate;
    if (fail) return route.fulfill({ status: 503, body: 'Fixture unavailable', headers: { 'access-control-allow-origin': new URL(page.url()).origin } });
    await route.fallback();
  });
  return { blocked, unblock, finished, get path() { return parentPath; } };
}

async function create(page: Page) {
  await page.goto('./');
  await page.locator('#file-input').setInputFiles(file);
  await page.locator('#start-send').click();
}

async function visibleInvitation(page: Page) {
  await expect(page.locator('#share-box')).toBeVisible({ timeout: 1000 });
  await expect(page.locator('#share-qr')).toBeVisible({ timeout: 1000 });
  await expect(page.locator('#status')).toHaveText('等待接收方');
  await expect(page.locator('#cancel')).toHaveText('结束分享');
  const link = await page.locator('#share-link').inputValue();
  const pixels = await page.locator('#share-qr').evaluate(canvas => {
    const qr = canvas as HTMLCanvasElement;
    return { width: qr.width, height: qr.height, data: Array.from(qr.getContext('2d')!.getImageData(0, 0, qr.width, qr.height).data) };
  });
  expect(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data).toBe(link);
  return link;
}

for (const phase of ['member-state', 'socket-ticket'] as const) {
  test(`registered share shows its usable link and QR before ${phase} completes`, async ({ page, context }) => {
    await setup(context);
    const held = await holdSenderRequest(page, phase);
    try {
      await create(page); await held.blocked;
      await visibleInvitation(page);
    } finally {
      held.unblock(); await page.locator('#cancel').click();
    }
  });
}

test('a delayed notification failure preserves the invitation and polling recovery', async ({ page, context, browserName }) => {
  await setup(context);
  const held = await holdSenderRequest(page, 'socket-ticket', true);
  try {
    await create(page); await held.blocked;
    const invitation = await visibleInvitation(page);
    const retry = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === held.path && new URL(response.url()).searchParams.get('role') === 'sender');
    held.unblock();
    expect((await retry).status()).toBe(200);
    expect(await visibleInvitation(page)).toBe(invitation);
    await expect(page.locator('#notice')).toBeHidden();
    if (browserName === 'chromium') {
      const receiver = await context.newPage(); await receiver.goto(invitation);
      await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
      await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
      const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(file.name);
      expect(await readFile((await download.path())!)).toEqual(file.buffer);
    }
  } finally {
    held.unblock(); await page.locator('#cancel').click();
  }
});

test('an old notification request cannot replace or remove a second share', async ({ page, context }) => {
  await setup(context);
  const held = await holdSenderRequest(page, 'socket-ticket', true);
  try {
    await create(page); await held.blocked;
    const first = await visibleInvitation(page);
    await page.locator('#cancel').click();
    await page.locator('#start-send').click();
    const second = await visibleInvitation(page);
    expect(second).not.toBe(first);
    held.unblock();
    // Finish the old HTTP failure before checking the current session again.
    await held.finished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(page.locator('#share-link')).toHaveValue(second);
    await visibleInvitation(page);
    await expect(page.locator('#notice')).toBeHidden();
  } finally {
    held.unblock(); await page.locator('#cancel').click();
  }
});

test('an early completed recipient does not end a share whose notification socket is still opening', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real multi-recipient WebRTC runs in Chromium.');
  await setup(context);
  await page.addInitScript(() => {
    const Socket = window.WebSocket, state = window as any;
    state.__openedSenderPaths = [];
    window.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const endpoint = new URL(String(url), location.href);
        if (endpoint.searchParams.get('role') === 'sender') this.addEventListener('open', () => state.__openedSenderPaths.push(endpoint.pathname));
      }
    };
  });
  const state = await holdSenderRequest(page, 'member-state');
  const socket = await holdSenderRequest(page, 'socket-ticket');
  try {
    await create(page); await state.blocked;
    const link = await visibleInvitation(page), receiver = await context.newPage();
    const joined = receiver.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'join');
    await receiver.goto(link); await joined;
    state.unblock(); await socket.blocked;
    await expect(receiver.locator('#accept-files')).toBeVisible();
    await receiver.locator('#accept-files').click();
    await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
    await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
    // The parent notification stream may open after the initial file connection
    // has already closed successfully. A later recipient must still be served.
    socket.unblock(); await socket.finished;
    await expect.poll(() => page.evaluate(path => (window as any).__openedSenderPaths.includes(path), socket.path)).toBe(true);
    const later = await context.newPage();
    await later.goto(link);
    await expect(later.locator('#accept-files')).toBeVisible();
    await later.locator('#accept-files').click();
    await expect(later.locator('#status')).toHaveText('文件已收到，请保存到设备');
    const pending = later.waitForEvent('download'); await later.locator('.download-file').first().click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(file.name);
    expect(await readFile((await download.path())!)).toEqual(file.buffer);
    await expect(page.locator('#share-link')).toHaveValue(link);
  } finally {
    state.unblock(); socket.unblock(); await page.locator('#cancel').click();
  }
});

test('a recipient joining before the sender notification socket opens still receives original bytes', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real WebRTC is covered in Chromium; invitation timing and cancellation run in WebKit.');
  await setup(context);
  const held = await holdSenderRequest(page, 'socket-ticket');
  try {
    await create(page); await held.blocked;
    const link = await visibleInvitation(page), receiver = await context.newPage();
    const joined = receiver.waitForResponse(response => response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'join');
    await receiver.goto(link); await joined;
    held.unblock();
    await expect(receiver.locator('#accept-files')).toBeVisible();
    await receiver.locator('#accept-files').click();
    await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
    const pending = receiver.waitForEvent('download');
    await receiver.locator('.download-file').first().click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(file.name);
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    expect(digest(await readFile((await download.path())!))).toBe(digest(file.buffer));
  } finally {
    held.unblock(); await page.locator('#cancel').click();
  }
});

test('a committed creation whose reply is lost retries the same room and produces a usable invitation', async ({ page, context, browserName }, info) => {
  await setup(context); let count = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bodies: any[] = [], statuses: number[] = [];
  await page.route(api + '/rooms', async route => {
    count++; bodies.push(route.request().postDataJSON());
    const response = await route.fetch({ headers: { ...route.request().headers(), 'cf-connecting-ip': 'lost-creation-' + info.testId } });
    statuses.push(response.status());
    if (count === 1) await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.goto('./'); await page.clock.install();
    await page.locator('#file-input').setInputFiles(file); await page.locator('#start-send').click();
    await expect.poll(() => statuses.length).toBe(1); expect(statuses[0]).toBe(201);
    await page.clock.fastForward(16000);
    await expect(page.locator('#status')).toHaveText('配对服务响应较慢，正在重试…');
    await page.clock.fastForward(1100);
    await visibleInvitation(page);
    expect(count).toBe(2); expect(statuses).toEqual([201, 200]); expect(bodies[1]).toEqual(bodies[0]);
    const link = await page.locator('#share-link').inputValue();
    expect(await page.evaluate(async ({ link, creationToken }) => {
      const { parseShare } = await import('/src/share.ts');
      return (await parseShare(new URL(link).hash)).secret !== creationToken;
    }, { link, creationToken: bodies[0].creationToken })).toBe(true);
    release();
    if (browserName === 'chromium') {
      const receiver = await context.newPage(); await receiver.goto(link);
      await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
      await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
      const downloading = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe(file.name);
      expect(createHash('sha256').update(await readFile((await download.path())!)).digest('hex')).toBe(createHash('sha256').update(file.buffer).digest('hex'));
    }
  } finally { release(); if (await page.locator('#cancel').isVisible()) await page.locator('#cancel').click(); }
});

test('persistent creation timeouts stop after one retry and preserve the file selection', async ({ page, context }) => {
  await setup(context); let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(api + '/rooms', async route => { calls++; await gate; await route.abort().catch(() => {}); });
  try {
    await page.goto('./'); await page.clock.install();
    await page.locator('#file-input').setInputFiles(file); await page.locator('#start-send').click();
    await expect.poll(() => calls).toBe(1);
    await page.clock.fastForward(16000);
    await expect(page.locator('#status')).toHaveText('配对服务响应较慢，正在重试…');
    await page.clock.fastForward(1100); await expect.poll(() => calls).toBe(2);
    await page.clock.fastForward(14000);
    await expect(page.locator('#notice')).toHaveText('未能及时连接配对服务，文件尚未开始传输。请稍后重试。');
    await expect(page.locator('#status')).toHaveText('连接未完成');
    await expect(page.locator('#start-send')).toBeEnabled(); await expect(page.locator('#files')).toContainText(file.name);
    await page.clock.fastForward(60000); expect(calls).toBe(2);
    await expect(page.locator('#share-box')).toBeHidden();
  } finally { release(); }
});

test('cancel aborts a pending creation and its late response cannot replace a new invitation', async ({ page, context }, info) => {
  await setup(context); let release!: () => void, first: any, second: any;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(api + '/rooms', async route => {
    const body = route.request().postDataJSON();
    const response = await route.fetch({ headers: { ...route.request().headers(), 'cf-connecting-ip': 'cancel-creation-' + info.testId } });
    if (!first) { first = body; await gate; } else second = body;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await create(page); await expect.poll(() => !!first).toBe(true);
    // Observe cleanup rather than probing the sender API: a GET with a new
    // client would bind that client and race the very cleanup being tested.
    const ended = page.waitForResponse(response => new URL(response.url()).pathname === '/rooms/' + first.room && response.request().method() === 'POST' && response.request().postDataJSON()?.type === 'end');
    await page.locator('#cancel').click(); await expect(page.locator('#session-panel')).toBeHidden();
    expect((await ended).status()).toBe(200);
    await page.locator('#start-send').click(); const invitation = await visibleInvitation(page);
    expect(second.room).not.toBe(first.room); expect(second.creationToken).not.toBe(first.creationToken);
    release(); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    await expect(page.locator('#share-link')).toHaveValue(invitation); await expect(page.locator('#notice')).toBeHidden();
  } finally { release(); if (await page.locator('#cancel').isVisible()) await page.locator('#cancel').click(); }
});

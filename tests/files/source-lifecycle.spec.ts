import { test, expect, type BrowserContext } from '../fixtures';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function setup(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  });
}

test('10 GiB file selection reports actual sizes and shares the full manifest without buffering the file', async ({ page, context }) => {
  await setup(context);
  const dir = await mkdtemp(join(tmpdir(), 'pizza-folder-size-')), size = 10 * 1073741824 + 192;
  const handle = await open(join(dir, 'movie.mp4'), 'w');
  try { await handle.truncate(size); await handle.write(Buffer.from('tail'), 0, 4, size - 4); } finally { await handle.close(); }
  await writeFile(join(dir, 'notes.txt'), 'notes');
  try {
    await page.goto('./'); await page.locator('#file-input').setInputFiles([join(dir, 'movie.mp4'), join(dir, 'notes.txt')]);
    await expect(page.locator('#files .file-row')).toHaveCount(2);
    await expect(page.locator('#selection-summary')).toHaveText('2 个文件 · 10.00 GB');
    await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
    const receiver = await context.newPage(); await receiver.goto(await page.locator('#share-link').inputValue());
    await expect(receiver.locator('#accept-files')).toBeVisible();
    await expect(receiver.locator('#incoming-files')).toContainText('10.00 GB');
    await page.locator('#cancel').click();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unreadable 192-byte selection never publishes a broken sharing link', async ({ page, context }) => {
  await setup(context); let shares = 0;
  page.on('request', r => { if (new URL(r.url()).pathname === '/rooms' && r.method() === 'POST') shares++; });
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function() { return this.size === 192 ? Promise.reject(new DOMException('Missing original', 'NotFoundError')) : read.call(this); };
  });
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'missing.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(192) });
  await page.locator('#start-send').click();
  await expect(page.locator('#notice')).toContainText('无法读取原文件');
  await expect(page.locator('#share-box')).toBeHidden(); expect(shares).toBe(0);
  await expect(page.locator('#start-send')).toBeEnabled();
});

for (const dropFinalControl of [false, true]) test(`a source disappearing after sharing reports a read failure even with ${dropFinalControl ? 'lost' : 'delivered'} final data-channel control`, async ({ page, context }) => {
  await setup(context);
  await page.addInitScript(dropFinalControl => {
    if (dropFinalControl) {
      const send = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function(data: any) {
        if (typeof data === 'string' && JSON.parse(data).reason === 'source-unavailable') return;
        return send.call(this, data);
      } as any;
    }
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function() { return (window as any).__missingSource && this.size <= 32768 ? Promise.reject(new DOMException('Missing original', 'NotFoundError')) : read.call(this); };
  }, dropFinalControl);
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'source.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(512 * 1024) });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  const receiver = await context.newPage(); await receiver.goto(await page.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible();
  await page.evaluate(() => { (window as any).__missingSource = true; });
  await receiver.locator('#accept-files').click();
  await expect(page.locator('.recipient-message')).toContainText('无法读取原文件');
  await expect(receiver.locator('#notice')).toContainText('发送方无法读取原文件');
  await expect(receiver.locator('.download-file')).toHaveCount(0);
});

test('sender ETA shows remaining time while the receiver is still receiving', async ({ page, context }) => {
  await setup(context);
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function() { if (this.size <= 32768) await new Promise(r => setTimeout(r, 12)); return read.call(this); };
  });
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'eta.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(8 * 1048576) });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  const receiver = await context.newPage(); await receiver.goto(await page.locator('#share-link').inputValue()); await receiver.locator('#accept-files').click();
  await expect(page.locator('#remaining')).toHaveText(/\d+ (秒|分钟)/);
  await expect(page.locator('.recipient-detail')).toContainText(/\d+ (秒|分钟)/);
  await page.locator('#language-toggle').click(); await expect(page.locator('#remaining')).toHaveText(/\d+(s| min)/);
  await page.locator('#cancel').click();
});

test('one interrupted pairing request retries the same session and connects without another scan', async ({ page, context }) => {
  await setup(context); await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('original') });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    const fetch = window.fetch.bind(window); let failures = 0;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname.startsWith('/rooms/') && (!init?.method || init.method === 'GET') && failures++ === 0) return Promise.reject(new DOMException('Transient abort', 'AbortError'));
      return fetch(input, init);
    };
  });
  await receiver.goto(await page.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible(); await expect(receiver.locator('#notice')).toBeHidden();
  await expect(page.locator('.recipient-row')).toHaveCount(1);
  await receiver.locator('#accept-files').click(); await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await page.locator('#cancel').click();
});

test('camera frame follows actual source proportions and stays centered within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { (window as any).__cameraReady = resolve; });
  });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__cameraReady)).toBe('function');
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d')!; context.fillRect(0, 0, canvas.width, canvas.height);
    (window as any).__cameraCanvas = canvas; (window as any).__cameraReady(canvas.captureStream(10));
  });
  await expect(page.locator('#scan-video')).toHaveAttribute('data-ready', 'true');
  for (const [width, height] of [[1920, 1080], [720, 1280], [640, 480]]) {
    await page.evaluate(async ([width, height]) => {
      // A new stream gives deterministic intrinsic dimensions; resizing an existing
      // canvas track can keep its original capture resolution in Chromium.
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d')!.fillStyle = width === 720 ? '#214b3b' : '#452b20';
      canvas.getContext('2d')!.fillRect(0, 0, width, height);
      const video = document.getElementById('scan-video') as HTMLVideoElement;
      (video.srcObject as MediaStream).getTracks().forEach(track => track.stop());
      (window as any).__cameraCanvas = canvas;
      video.srcObject = canvas.captureStream(10);
      await video.play();
    }, [width, height]);
    await expect.poll(() => page.locator('#scan-video').evaluate(v => (v as HTMLVideoElement).videoWidth)).toBe(width);
    await expect.poll(async () => {
      const box = (await page.locator('.scan-frame').boundingBox())!;
      return Math.abs(box.width / box.height - width / height);
    }).toBeLessThan(.005);
    for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 640 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => {
        const box = (await page.locator('#scan-dialog').boundingBox())!;
        return Math.abs(box.y + box.height / 2 - viewport.height / 2);
      }).toBeLessThan(2);
      const box = (await page.locator('.scan-frame').boundingBox())!;
      const dialog = (await page.locator('#scan-dialog').boundingBox())!;
      expect(Math.abs(box.width / box.height - width / height)).toBeLessThan(.005);
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
      expect(dialog.y).toBeGreaterThanOrEqual(15);
      expect(dialog.y + dialog.height).toBeLessThanOrEqual(viewport.height - 15);
    }
  }
  await page.locator('#scan-video').evaluate(node => ((node as HTMLVideoElement).srcObject as MediaStream).getTracks().forEach(track => track.stop()));
  await page.locator('#close-scanner').click();
  await expect(page.locator('#scan-video')).not.toHaveAttribute('data-ready', 'true');
});

test('camera placeholder cannot be resized by intrinsic video dimensions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Fixture denied', 'NotAllowedError'); }; });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await expect(page.locator('#scan-again')).toBeVisible();
  const before = (await page.locator('.scan-frame').boundingBox())!;
  for (const [width, height] of [[1920, 1080], [720, 1280], [640, 480]]) {
    await page.locator('#scan-video').evaluate((node, [width, height]) => { const video = node as HTMLVideoElement; video.width = width; video.height = height; }, [width, height]);
    const after = (await page.locator('.scan-frame').boundingBox())!;
    expect(Math.abs(before.height - after.height)).toBeLessThan(1); expect(Math.abs(before.y - after.y)).toBeLessThan(1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#close-scanner').click();
});


test('switching roles during a pending source check never starts an unexpected share', async ({ page, context }) => {
  await setup(context); let shares = 0;
  page.on('request', r => { if (new URL(r.url()).pathname === '/rooms' && r.method() === 'POST') shares++; });
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function() {
      const blob = this;
      return new Promise(resolve => { (window as any).__finishSourceCheck = async () => resolve(await read.call(blob)); });
    };
  });
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('local source') });
  await page.locator('#start-send').click(); await expect(page.locator('#start-send')).toHaveText('检查文件…');
  await page.locator('#receive-tab').click();
  await page.evaluate(() => (window as any).__finishSourceCheck());
  await expect(page.locator('#start-send-label')).toHaveText('创建传输');
  await expect(page.locator('#receive-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#session-panel')).toBeHidden(); expect(shares).toBe(0);
});


test('source failure notification has a deadline and cancellation clears its delayed result', async ({ page }) => {
  await page.goto('./'); await page.clock.install();
  await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const state = window as any; state.__failureEvents = [];
    state.__failingTransfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', event => state.__failureEvents.push(event));
    state.__failingTransfer.enableSourceFailure(() => new Promise(() => {}));
    state.__failingTransfer.fail('source fixture', true);
  });
  await page.clock.fastForward(1100);
  expect(await page.evaluate(() => (window as any).__failureEvents.filter((e: any) => e.type === 'error').map((e: any) => e.data))).toEqual(['source fixture']);
  expect(await page.evaluate(() => (window as any).__failingTransfer.stopped)).toBe(true);
  await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const state = window as any; state.__failureEvents = [];
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', event => state.__failureEvents.push(event));
    transfer.enableSourceFailure(() => new Promise(() => {})); transfer.fail('cancelled fixture', true); transfer.close(false);
  });
  await page.clock.fastForward(1100);
  expect(await page.evaluate(() => (window as any).__failureEvents)).toEqual([]);
});

test('only an authenticated peer can supply the new source-failure signal', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey, randomToken } = await import('/src/protocol.ts');
    const events: any[] = [], transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', event => events.push(event));
    const pair = new AutoPair(transfer, await signalKey(randomToken()), () => {});
    try {
      await (pair as any).handle({ type: 'source-unavailable' }, false);
      const ignored = !transfer.stopped && events.length === 0;
      await (pair as any).handle({ type: 'source-unavailable' }, true);
      return { ignored, error: events.find(e => e.type === 'error')?.data };
    } finally { pair.close(); transfer.close(false); }
  });
  expect(result.ignored).toBe(true); expect(result.error).toContain('发送方无法读取原文件');
});

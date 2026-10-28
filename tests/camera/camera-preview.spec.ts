import { test, expect } from '../fixtures';
import { needsFramePreview } from '../../src/camera-preview';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';

const iosAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1';

test('frame preview targets mobile Apple WebKit including desktop-mode iPad without affecting desktop Chrome', () => {
  expect(needsFramePreview(iosAgent, 'iPhone', 5)).toBe(true);
  expect(needsFramePreview(iosAgent.replace('Version/27.0', 'CriOS/155.0'), 'iPhone', 5)).toBe(true);
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15';
  expect(needsFramePreview(mac, 'MacIntel', 5)).toBe(true);
  expect(needsFramePreview(mac, 'MacIntel', 0)).toBe(false);
  expect(needsFramePreview(mac.replace('Version/27.0', 'Chrome/155'), 'MacIntel', 0)).toBe(false);
  expect(needsFramePreview('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/155', 'Linux arm', 5)).toBe(false);
});

async function appleIdentity(page: import('@playwright/test').Page) {
  await page.addInitScript(agent => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: agent });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'iPhone' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  }, iosAgent);
}

for (const slowDecoder of [false, true]) test(`iPhone frame preview preserves pixels and updates while native video is mis-scaled; slow decoder ${slowDecoder}`, async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Synthetic real canvas streams are exercised in Chromium.');
  await appleIdentity(page); await page.setViewportSize({ width: 390, height: 844 });
  let release!: () => void, decoderRequested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (slowDecoder) await page.route(url => /\/jsqr\.js$/i.test(url.pathname), async route => { decoderRequested = true; await gate; await route.continue(); });
  await page.addInitScript(() => {
    const state = window as any; state.__calls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      state.__calls++; const source = document.createElement('canvas'); source.width = 480; source.height = 640;
      const ctx = source.getContext('2d')!; ctx.fillStyle = '#2244ee'; ctx.fillRect(0, 0, 480, 640);
      for (const [color, x, y] of [['#ff0000', 0, 0], ['#00ff00', .8, 0], ['#0000ff', 0, .8], ['#ffff00', .8, .8]] as const) {
        ctx.fillStyle = color; ctx.fillRect(x * 480, y * 640, 96, 128);
      }
      state.__source = source; state.__track = undefined; const stream = source.captureStream(30); state.__track = stream.getVideoTracks()[0]; return stream;
    };
  });
  try {
    await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
    const preview = page.locator('#scan-preview'); await expect(preview).toHaveAttribute('data-ready', 'true');
    const pixels = () => preview.evaluate(node => {
      const canvas = node as HTMLCanvasElement, ctx = canvas.getContext('2d')!;
      return [[.1, .1], [.9, .1], [.1, .9], [.9, .9]].map(([x, y]) => [...ctx.getImageData(x * canvas.width, y * canvas.height, 1, 1).data].slice(0, 3));
    });
    if (slowDecoder) await expect.poll(() => decoderRequested).toBe(true);
    const originalPixels = await pixels(), expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    originalPixels.forEach((color, index) => color.forEach((channel, component) => expect(Math.abs(channel - expected[index][component])).toBeLessThanOrEqual(2)));
    await page.locator('#scan-video').evaluate(node => { (node as HTMLElement).style.transform = 'scale(1.8)'; });
    expect(await pixels()).toEqual(originalPixels);
    await expect.poll(async () => {
      const box = (await page.locator('.scan-frame').boundingBox())!;
      return Math.abs(box.width / box.height - .75);
    }).toBeLessThan(.005);
    // Inspect the displayed frame edges, not just the canvas backing bitmap:
    // all four corner markers must fill the view despite native video scaling.
    const screenshot = await page.locator('.scan-frame').screenshot();
    const displayed = await page.evaluate(async png => {
      const image = new Image(); image.src = 'data:image/png;base64,' + png; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      return [[.1, .1], [.9, .1], [.1, .9], [.9, .9]].map(([x, y]) => [...ctx.getImageData(Math.round(x * image.width), Math.round(y * image.height), 1, 1).data].slice(0, 3));
    }, screenshot.toString('base64'));
    displayed.forEach((color, index) => color.forEach((channel, component) => expect(Math.abs(channel - expected[index][component])).toBeLessThan(12)));
    expect(await page.locator('.scan-frame').evaluate(frame => new Promise<number>(resolve => {
      let changes = 0; const observer = new ResizeObserver(() => changes++); observer.observe(frame);
      setTimeout(() => { observer.disconnect(); resolve(changes); }, 300);
    }))).toBeLessThanOrEqual(2);
    expect(await preview.evaluate(node => {
      const box = node.getBoundingClientRect(); return document.elementFromPoint(box.x + 5, box.y + box.height / 2)?.id;
    })).toBe('scan-preview');
    await page.evaluate(() => {
      const source = (window as any).__source as HTMLCanvasElement, ctx = source.getContext('2d')!;
      ctx.fillStyle = '#aa44cc'; ctx.fillRect(0, 0, source.width, source.height);
    });
    await expect.poll(async () => (await pixels())[0].every((channel, index) => Math.abs(channel - [170, 68, 204][index]) <= 2)).toBe(true);
    expect(await page.evaluate(() => (window as any).__calls)).toBe(1);
    await page.locator('#close-scanner').click();
    await expect(preview).toBeHidden();
    expect(await preview.evaluate(node => ({ width: (node as HTMLCanvasElement).width, height: (node as HTMLCanvasElement).height }))).toEqual({ width: 0, height: 0 });
    expect(await page.evaluate(() => (window as any).__track.readyState)).toBe('ended');
    release();
    await page.locator('#open-scanner').click(); await expect(preview).toHaveAttribute('data-ready', 'true');
    expect(await page.evaluate(() => (window as any).__calls)).toBe(2); await page.locator('#close-scanner').click();
  } finally { release(); }
});

test('iPhone preview rendering remains bounded on a 4K source and clears synchronously', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Real canvas captureStream is covered in Chromium.');
  await appleIdentity(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const source = document.createElement('canvas'); source.width = 3840; source.height = 2160;
      source.getContext('2d')!.fillRect(0, 0, 3840, 2160); (window as any).__source = source; return source.captureStream(30);
    };
  });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await expect(page.locator('#scan-preview')).toHaveAttribute('data-ready', 'true');
  expect(await page.locator('#scan-preview').evaluate(node => [(node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height])).toEqual([960, 540]);
  await page.evaluate(() => document.getElementById('close-scanner')!.click());
  expect(await page.locator('#scan-preview').evaluate(node => (node as HTMLCanvasElement).width)).toBe(0);
});

test('iPhone cannot silently stay blank when its canvas renderer is unavailable', async ({ page }) => {
  await appleIdentity(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args: any[]) { return this.id === 'scan-preview' ? null : (original as any).apply(this, args); } as any;
    const track = { stop() { (window as any).__stopped = true; } };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: async () => [], getUserMedia: async () => ({ getTracks: () => [track] })
    } });
  });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await expect(page.locator('#scan-again')).toBeVisible(); await expect(page.locator('#scan-preview')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__stopped)).toBe(true);
  await page.locator('#close-scanner').click();
});

test('real QR video through the iPhone display path pairs and delivers the original file', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'Real WebRTC transfer is covered in Chromium.');
  test.setTimeout(45000);
  await context.addInitScript(() => {
    // Exercise browser downloads here; the native mobile share sheet has its own suite.
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  });
  const original = Buffer.from('iPhone frame display keeps QR pairing and original bytes.');
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'frame-preview.txt', mimeType: 'text/plain', buffer: original });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  const link = await page.locator('#share-link').inputValue();
  const receiver = await context.newPage(); await appleIdentity(receiver); await receiver.goto('./');
  const image = await QRCode.toDataURL(link, { width: 480, margin: 4 });
  await receiver.evaluate(async image => {
    const bitmap = new Image(); bitmap.src = image; await bitmap.decode();
    navigator.mediaDevices.getUserMedia = async () => {
      const source = document.createElement('canvas'); source.width = source.height = 480; source.getContext('2d')!.drawImage(bitmap, 0, 0);
      (window as any).__source = source; const stream = source.captureStream(10); (window as any).__track = stream.getVideoTracks()[0]; return stream;
    };
    (window as any).__usedFrames = false;
    new MutationObserver(() => { if (document.getElementById('scan-preview')?.dataset.ready === 'true') (window as any).__usedFrames = true; }).observe(document.getElementById('scan-preview')!, { attributes: true });
  }, image);
  await receiver.locator('#receive-tab').click(); await receiver.locator('#open-scanner').click();
  await expect(receiver.locator('#scan-dialog')).toBeHidden(); await expect(receiver.locator('#accept-files')).toBeVisible();
  expect(await receiver.evaluate(() => (window as any).__usedFrames)).toBe(true);
  expect(await receiver.evaluate(() => (window as any).__track.readyState)).toBe('ended');
  await receiver.locator('#accept-files').click(); await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const download = receiver.waitForEvent('download', { timeout: 15000 }); await receiver.locator('.download-file:visible').first().click();
  const received = await readFile((await (await download).path())!);
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex'); expect(hash(received)).toBe(hash(original));
  expect(await receiver.locator('#scan-preview').evaluate(node => (node as HTMLCanvasElement).width)).toBe(0);
  await page.locator('#cancel').click();
});

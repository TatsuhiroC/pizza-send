import { test, expect } from '../fixtures';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('clicking the upload area opens the multiple-file picker directly and appends originals', async ({ page, context, browserName }) => {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  });
  await page.goto('./');
  const contents = new Map([['single.txt', 'first'], ['second.txt', 'second'], ['last.txt', 'third']]);
  const first = page.waitForEvent('filechooser'); await page.locator('#drop-zone').click();
  const picker = await first; expect(picker.isMultiple()).toBe(true);
  await picker.setFiles(['single.txt', 'second.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(contents.get(name)!) })));
  await expect(page.locator('#files .file-row')).toHaveCount(2);
  await expect(page.locator('#source-dialog, #folder-input, #choose-files, #choose-folder')).toHaveCount(0);
  const last = page.waitForEvent('filechooser'); await page.locator('#drop-zone').click();
  await (await last).setFiles({ name: 'last.txt', mimeType: 'text/plain', buffer: Buffer.from(contents.get('last.txt')!) });
  await expect(page.locator('#files .file-row')).toHaveCount(3);
  if (browserName === 'webkit') return;
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  const receiver = await context.newPage(); await receiver.goto(await page.locator('#share-link').inputValue()); await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const saved = new Set<string>();
  for (const button of await receiver.locator('.download-file').all()) {
    const download = receiver.waitForEvent('download'); await button.click(); const file = await download, name = file.suggestedFilename();
    expect(contents.has(name)).toBe(true); expect(saved.has(name)).toBe(false); saved.add(name);
    const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
    expect(hash(await readFile((await file.path())!))).toBe(hash(Buffer.from(contents.get(name)!)));
  }
  expect(saved.size).toBe(3); await page.locator('#cancel').click();
});

test('direct file entry fits a narrow phone, translates and allows selecting the same file again', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.goto('./');
  const original = { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep') };
  for (let count = 1; count <= 2; count++) {
    const choosing = page.waitForEvent('filechooser'); await page.locator('#drop-zone').click();
    await (await choosing).setFiles(original);
    await expect(page.locator('#files .file-row')).toHaveCount(count);
  }
  await expect(page.locator('#drop-zone')).not.toHaveAttribute('aria-haspopup', 'dialog');
  await page.locator('#language-toggle').click();
  await expect(page.locator('#drop-zone')).toContainText('click to choose');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('direct-selection-mobile.png') });
  await expect(page.locator('#clear-files')).toHaveText('Clear selected files');
  const bounds = (await page.locator('#clear-files').boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.locator('#clear-files').click();
  await expect(page.locator('#files .file-row')).toHaveCount(0);
  await expect(page.locator('#clear-files')).toBeHidden(); await expect(page.locator('#start-send')).toBeDisabled();
  expect(await page.locator('#file-input').inputValue()).toBe('');
  const again = page.waitForEvent('filechooser'); await page.locator('#drop-zone').click(); await (await again).setFiles(original);
  await expect(page.locator('#files strong')).toHaveText('keep.txt');
});

test('scanner is centered on phones and desktop through permission errors, translation and viewport changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as any).__cameraCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => { (window as any).__cameraCalls++; return new Promise((_, reject) => { (window as any).__denyCamera = reject; }); }
    } });
  });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  const centered = async () => {
    const box = (await page.locator('#scan-dialog').boundingBox())!, viewport = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(1);
    expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(1);
    expect(box.y).toBeGreaterThanOrEqual(15);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 15);
  };
  await centered();
  // Duplicate openings while permission is pending must share the existing request.
  await page.evaluate(() => { document.getElementById('open-scanner')!.click(); document.getElementById('open-scanner')!.click(); });
  await expect.poll(() => page.evaluate(() => (window as any).__cameraCalls)).toBe(1);
  await page.evaluate(() => (window as any).__denyCamera(new DOMException('Denied', 'NotAllowedError')));
  await expect(page.locator('#scan-again')).toBeVisible();
  for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 640 }, { width: 320, height: 740 }, { width: 1280, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.getElementById('language-toggle')!.click());
    await centered();
  }
  await page.locator('#close-scanner').click();
});

test('live camera preview is visible before a slow QR decoder finishes loading', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'A real fake-device video stream is covered by Chromium.');
  let release!: () => void, requested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => /\/jsqr\.js$/i.test(url.pathname), async route => { requested = true; await gate; await route.continue(); });
  await page.addInitScript(() => {
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as any).__cameraCalls = 0;
    navigator.mediaDevices.getUserMedia = async constraints => { (window as any).__cameraCalls++; return get(constraints); };
  });
  try {
    await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator('#scan-video')).toHaveAttribute('data-ready', 'true');
    const preview = await page.locator('#scan-video').evaluate(node => ({ ready: (node as HTMLVideoElement).readyState, opacity: getComputedStyle(node).opacity, transition: getComputedStyle(node).transitionProperty, width: (node as HTMLVideoElement).videoWidth }));
    expect(preview.ready).toBeGreaterThanOrEqual(2); expect(preview.width).toBeGreaterThan(0); expect(preview.opacity).toBe('1'); expect(preview.transition).not.toContain('opacity');
    expect(await page.evaluate(() => (window as any).__cameraCalls)).toBe(1);
    await page.evaluate(() => document.getElementById('open-scanner')!.click());
    expect(await page.evaluate(() => (window as any).__cameraCalls)).toBe(1);
    await page.locator('#close-scanner').click(); release();
    await expect(page.locator('#scan-video')).not.toHaveAttribute('data-ready', 'true');
    expect(await page.locator('#scan-video').evaluate(node => (node as HTMLVideoElement).srcObject)).toBeNull();
  } finally { release(); }
});

test('scanner pins a recognized physical rear lens before its only capture request', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as any; state.__captureRequests = []; state.__enumerations = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: async () => { state.__enumerations++; return [
        { kind: 'videoinput', label: 'Back Triple Camera', deviceId: 'virtual' },
        { kind: 'videoinput', label: 'Front Camera', deviceId: 'front' },
        { kind: 'videoinput', label: '后置摄像头', deviceId: 'physical' }
      ]; },
      getUserMedia: async (constraints: MediaStreamConstraints) => { state.__captureRequests.push(constraints); throw new DOMException('Fixture busy', 'NotReadableError'); }
    } });
  });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await expect(page.locator('#scan-again')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__captureRequests)).toEqual([{ audio: false, video: { deviceId: { exact: 'physical' } } }]);
  expect(await page.evaluate(() => (window as any).__enumerations)).toBe(1);
  await page.locator('#close-scanner').click();
});

test('closing while camera enumeration is pending cannot start capture later', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as any; state.__captureCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: () => new Promise(resolve => { state.__finishEnumeration = resolve; }),
      getUserMedia: async () => { state.__captureCalls++; throw new Error('Must not capture'); }
    } });
  });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__finishEnumeration)).toBe(true);
  await page.locator('#close-scanner').click();
  await page.evaluate(async () => { (window as any).__finishEnumeration([{ kind: 'videoinput', label: 'Back Camera', deviceId: 'rear' }]); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(await page.evaluate(() => (window as any).__captureCalls)).toBe(0);
});


test('retired diagnostic query flags cannot switch the normal scanner into a comparison view', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => { throw new DOMException('Fixture denied', 'NotAllowedError'); }
    } });
  });
  for (const flag of ['1', '2']) {
    await page.goto('./?camera-debug=' + flag); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
    await expect(page.locator('#scan-again')).toBeVisible();
    await expect(page.locator('.camera-debug, #camera-reference, .camera-view-label')).toHaveCount(0);
    await expect(page.locator('.scan-frame video')).toHaveCount(1);
    await page.locator('#close-scanner').click();
  }
});

test('camera proportions fit the viewport in both languages and persist after capture stops', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => new Promise(() => {}); });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  for (const [width, height] of [[480, 640], [1280, 720]]) {
    await page.locator('#scan-video').evaluate((node, [width, height]) => {
      Object.defineProperties(node, { videoWidth: { configurable: true, value: width }, videoHeight: { configurable: true, value: height } });
      node.dispatchEvent(new Event('resize'));
    }, [width, height]);
    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 640 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      for (let language = 0; language < 2; language++) {
        await page.evaluate(() => document.getElementById('language-toggle')!.click());
        await expect.poll(async () => {
          const frame = (await page.locator('.scan-frame').boundingBox())!;
          const dialog = (await page.locator('#scan-dialog').boundingBox())!;
          return Math.abs(frame.width / frame.height - width / height) < .005
            && Math.abs(dialog.x + dialog.width / 2 - viewport.width / 2) < 2
            && Math.abs(dialog.y + dialog.height / 2 - viewport.height / 2) < 2
            && dialog.y >= 15 && dialog.y + dialog.height <= viewport.height - 15;
        }).toBe(true);
      }
    }
  }
  const before = (await page.locator('.scan-frame').boundingBox())!;
  await page.locator('#scan-video').evaluate(node => {
    Object.defineProperties(node, { videoWidth: { configurable: true, value: 0 }, videoHeight: { configurable: true, value: 0 } });
    node.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const after = (await page.locator('.scan-frame').boundingBox())!;
    return Math.abs(after.height - before.height) + Math.abs(after.width - before.width);
  }).toBeLessThan(1);
  await page.locator('#close-scanner').click();
});

test('portrait and landscape previews retain all four corners and the success still uses the same framing', async ({ page, browserName }, info) => {
  test.skip(browserName === 'webkit', 'Canvas captureStream is exercised in Chromium; WebKit covers layout separately.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1280;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const [color, x, y] of [['#ff0000', 0, 0], ['#00ff00', .8, 0], ['#0000ff', 0, .8], ['#ffff00', .8, .8]] as const) {
        ctx.fillStyle = color; ctx.fillRect(x * canvas.width, y * canvas.height, canvas.width * .2, canvas.height * .2);
      }
      (window as any).__previewCanvas = canvas;
      return canvas.captureStream(10);
    };
  });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await expect(page.locator('#scan-video')).toHaveAttribute('data-ready', 'true');
  for (const mode of ['portrait', 'landscape', 'success'] as const) {
    if (mode === 'landscape') await page.evaluate(async () => {
      const old = (window as any).__previewCanvas as HTMLCanvasElement, canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720; canvas.getContext('2d')!.drawImage(old, 0, 0, canvas.width, canvas.height);
      const video = document.getElementById('scan-video') as HTMLVideoElement;
      (video.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      (window as any).__previewCanvas = canvas; video.srcObject = canvas.captureStream(10); await video.play();
    });
    if (mode === 'success') await page.evaluate(() => {
      const video = document.getElementById('scan-video') as HTMLVideoElement, still = document.getElementById('scan-freeze') as HTMLCanvasElement;
      still.width = video.videoWidth; still.height = video.videoHeight; still.getContext('2d')!.drawImage(video, 0, 0); still.hidden = false;
      (video.srcObject as MediaStream).getTracks().forEach(track => track.stop()); video.pause(); video.srcObject = null;
    });
    if (mode !== 'success') await expect.poll(() => page.locator('#scan-video').evaluate(el => (el as HTMLVideoElement).videoWidth)).toBe(mode === 'portrait' ? 720 : 1280);
    await expect.poll(async () => {
      const box = (await page.locator('.scan-frame').boundingBox())!;
      return Math.abs(box.width / box.height - (mode === 'portrait' ? 720 / 1280 : 1280 / 720));
    }).toBeLessThan(.005);
    const screenshot = await page.locator('.scan-frame').screenshot({ path: info.outputPath(`camera-${mode}.png`) });
    const colors = await page.evaluate(async ({ screenshot, portrait }) => {
      const image = new Image(); image.src = 'data:image/png;base64,' + screenshot; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
      const ratio = portrait ? 720 / 1280 : 1280 / 720;
      if (Math.abs(image.width - image.height * ratio) > 1 + ratio) throw Error('Preview does not match camera proportions');
      return [[.1, .1], [.9, .1], [.1, .9], [.9, .9]].map(([u, v]) => [...ctx.getImageData(Math.round(u * image.width), Math.round(v * image.height), 1, 1).data].slice(0, 3));
    }, { screenshot: screenshot.toString('base64'), portrait: mode === 'portrait' });
    const expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    colors.forEach((color, index) => color.forEach((channel, component) => expect(Math.abs(channel - expected[index][component]), mode + ' visible corner').toBeLessThan(12)));
  }
  await page.locator('#scan-video').evaluate(el => ((el as HTMLVideoElement).srcObject as MediaStream | null)?.getTracks().forEach(t => t.stop()));
  await page.locator('#close-scanner').click();
});

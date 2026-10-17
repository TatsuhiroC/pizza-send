import { test, expect } from './fixtures';
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
  await expect(page.locator('#folder-note')).toContainText('Extract it after receiving');
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

test('camera position survives permission errors, retry controls, translation and viewport height changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as any).__cameraCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => { (window as any).__cameraCalls++; return new Promise((_, reject) => { (window as any).__denyCamera = reject; }); }
    } });
  });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  const before = (await page.locator('.scan-frame').boundingBox())!;
  // Duplicate openings while permission is pending must share the existing request.
  await page.evaluate(() => { document.getElementById('open-scanner')!.click(); document.getElementById('open-scanner')!.click(); });
  await expect.poll(() => page.evaluate(() => (window as any).__cameraCalls)).toBe(1);
  await page.evaluate(() => (window as any).__denyCamera(new DOMException('Denied', 'NotAllowedError')));
  await expect(page.locator('#scan-again')).toBeVisible();
  for (const height of [844, 740, 640]) {
    await page.setViewportSize({ width: 390, height });
    await page.evaluate(() => document.getElementById('language-toggle')!.click());
    const after = (await page.locator('.scan-frame').boundingBox())!;
    for (const value of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(before[value] - after[value]), value).toBeLessThan(1);
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

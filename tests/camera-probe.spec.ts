import { test, expect } from './fixtures';

test('comparison draws the same live stream, reports changing zoom and redacts device identifiers', async ({ page, browserName }, info) => {
  test.skip(browserName === 'webkit', 'Real canvas captureStream is covered in Chromium.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const state = window as any; state.__calls = 0; state.__zoom = 1;
    navigator.mediaDevices.getUserMedia = async () => {
      state.__calls++;
      const source = document.createElement('canvas'); source.width = 480; source.height = 640;
      const ctx = source.getContext('2d')!; ctx.fillStyle = '#2244ee'; ctx.fillRect(0, 0, 480, 640);
      state.__source = source; const stream = source.captureStream(15), track = stream.getVideoTracks()[0];
      state.__track = track;
      const settings = track.getSettings.bind(track);
      Object.defineProperty(track, 'getSettings', { value: () => ({ ...settings(), zoom: state.__zoom, deviceId: 'private-device-id', groupId: 'private-group-id' }) });
      Object.defineProperty(track, 'getCapabilities', { value: () => ({ zoom: { min: 1, max: 4, step: .1 }, focusMode: ['continuous'], deviceId: 'private-device-id' }) });
      return stream;
    };
  });
  await page.goto('./?camera-debug=2'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await expect(page.locator('#camera-reference')).toBeVisible();
  await expect.poll(() => page.locator('#camera-reference').evaluate(el => (el as HTMLCanvasElement).width)).toBe(480);
  const report = async () => JSON.parse(await page.locator('.camera-debug pre').textContent() || '{}');
  await expect.poll(async () => (await report()).comparison.samples.at(-1)?.settings.zoom).toBe(1);
  expect(await page.evaluate(() => (window as any).__calls)).toBe(1);
  expect(await page.locator('#camera-reference').evaluate(el => [...(el as HTMLCanvasElement).getContext('2d')!.getImageData(100, 100, 1, 1).data])).toEqual([34, 68, 238, 255]);
  await page.evaluate(() => { (window as any).__zoom = 1.7; });
  await expect.poll(async () => (await report()).comparison.samples.at(-1)?.settings.zoom).toBe(1.7);
  const data = await report();
  expect(data.comparison.capabilities).toEqual({ zoom: { min: 1, max: 4, step: .1 }, focusMode: ['continuous'] });
  expect(data.previews).toBe(1); expect(data.namedRearSelected).toBe(false); expect(data.requestedDeviceMatched).toBeNull();
  expect(JSON.stringify(data)).not.toMatch(/private-device-id|private-group-id|deviceId|groupId/);
  const native = (await page.locator('#scan-video').boundingBox())!, reference = (await page.locator('#camera-reference').boundingBox())!;
  expect(Math.abs(native.width - reference.width)).toBeLessThan(1); expect(Math.abs(native.height - reference.height)).toBeLessThan(1);
  expect(reference.x).toBeCloseTo(native.x + native.width, 0);
  await page.screenshot({ path: info.outputPath('camera-comparison-mobile.png') });
  await page.locator('#close-scanner').click();
  await expect.poll(() => page.locator('#camera-reference').evaluate(el => (el as HTMLCanvasElement).width)).toBe(0);
  expect(await page.evaluate(() => (window as any).__track.readyState)).toBe('ended');
  const stopped = await page.locator('.camera-debug pre').textContent(); await page.waitForTimeout(350);
  expect(await page.locator('.camera-debug pre').textContent()).toBe(stopped);
  await page.locator('#open-scanner').click();
  await expect.poll(() => page.locator('#camera-reference').evaluate(el => (el as HTMLCanvasElement).width)).toBe(480);
  expect(await page.evaluate(() => (window as any).__calls)).toBe(2);
  await page.locator('#close-scanner').click();
});

test('canceling while the optional comparison loads cannot open the camera later', async ({ page }) => {
  let release!: () => void, requested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname.includes('camera-probe'), async route => { requested = true; await gate; await route.continue(); });
  await page.addInitScript(() => {
    (window as any).__calls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: async () => [],
      getUserMedia: async () => { (window as any).__calls++; throw new DOMException('Fixture', 'NotAllowedError'); }
    } });
  });
  try {
    await page.goto('./?camera-debug=2');
    expect(requested).toBe(false);
    await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
    await expect.poll(() => requested).toBe(true);
    await page.locator('#close-scanner').click(); release();
    await expect(page.locator('#camera-reference')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).__calls)).toBe(0);
    await page.locator('#open-scanner').click(); await expect(page.locator('#scan-again')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__calls)).toBe(1);
    await page.locator('#close-scanner').click();
  } finally { release(); }
});

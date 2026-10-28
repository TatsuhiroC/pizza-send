import { test, expect } from '../fixtures';
import QRCode from 'qrcode';

const text = 'https://pizzasend.dpdns.org/test/#2.' + 'A'.repeat(43);

for (const position of ['center', 'off-center'] as const) test(`a stationary dense QR is decoded without moving the ${position} camera frame`, async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Real canvas camera streams run in Chromium.');
  test.setTimeout(30000);
  await page.goto('./');
  const qr = await QRCode.toDataURL(text, { width: 164, margin: 4 });
  const initial = await page.evaluate(async ({ qr, position }) => {
    const { CameraScanner } = await import('/src/scanner.ts');
    const decode = (await import('/node_modules/.vite/deps/jsqr.js')).default;
    const bitmap = new Image(); bitmap.src = qr; await bitmap.decode();
    const source = document.createElement('canvas'); source.width = 1920; source.height = 1080;
    const ctx = source.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, source.width, source.height);
    ctx.drawImage(bitmap, position === 'center' ? 878 : 1250, 458);
    const old = document.createElement('canvas'); old.width = 640; old.height = 360;
    old.getContext('2d')!.drawImage(source, 0, 0, old.width, old.height);
    const image = old.getContext('2d')!.getImageData(0, 0, old.width, old.height);
    const oldResult = decode(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
    const state = window as any; state.__found = []; state.__errors = []; state.__cameraRequests = 0;
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async () => { state.__cameraRequests++; const stream = source.captureStream(0); state.__track = stream.getVideoTracks()[0]; state.__ticker = setInterval(() => (state.__track as CanvasCaptureMediaStreamTrack).requestFrame(), 50); return stream; };
    const video = document.createElement('video'); video.style.cssText = 'position:fixed;top:0;left:0;width:192px;height:108px'; document.body.append(video);
    state.__scanner = new CameraScanner(video, async (value: string) => { state.__found.push(value); clearInterval(state.__ticker); return true; }, (error: string) => state.__errors.push(error));
    await state.__scanner.start();
    return oldResult?.data ?? null;
  }, { qr, position });
  expect(initial).toBeNull(); // Reproduce the old whole-frame-only resolution loss.
  await expect.poll(() => page.evaluate(() => (window as any).__found), { timeout: 5000 }).toEqual([text]);
  expect(await page.evaluate(() => ({ calls: (window as any).__cameraRequests, errors: (window as any).__errors, state: (window as any).__track.readyState }))).toEqual({ calls: 1, errors: [], state: 'ended' });
});

test('a transient first-frame read failure retries the same stationary stream instead of stopping scanning', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Real canvas camera streams run in Chromium.');
  test.setTimeout(30000);
  await page.goto('./');
  const qr = await QRCode.toDataURL(text, { width: 320, margin: 4 });
  await page.evaluate(async qr => {
    const { CameraScanner } = await import('/src/scanner.ts');
    const bitmap = new Image(); bitmap.src = qr; await bitmap.decode();
    const source = document.createElement('canvas'); source.width = 480; source.height = 640;
    source.getContext('2d')!.fillStyle = 'white'; source.getContext('2d')!.fillRect(0, 0, 480, 640);
    source.getContext('2d')!.drawImage(bitmap, 80, 160);
    const state = window as any; state.__found = []; state.__errors = []; state.__reads = 0; state.__cameraRequests = 0;
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args: any[]) {
      if (++state.__reads === 1) throw new DOMException('First frame unavailable', 'InvalidStateError');
      return (read as any).apply(this, args);
    };
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async () => { state.__cameraRequests++; const stream = source.captureStream(0); state.__track = stream.getVideoTracks()[0]; state.__ticker = setInterval(() => (state.__track as CanvasCaptureMediaStreamTrack).requestFrame(), 50); return stream; };
    const video = document.createElement('video'); video.style.cssText = 'position:fixed;top:0;left:0;width:192px;height:108px'; document.body.append(video);
    state.__scanner = new CameraScanner(video, async (value: string) => { state.__found.push(value); clearInterval(state.__ticker); return true; }, (error: string) => state.__errors.push(error));
    await state.__scanner.start();
  }, qr);
  await expect.poll(() => page.evaluate(() => (window as any).__found), { timeout: 5000 }).toEqual([text]);
  expect(await page.evaluate(() => ({ calls: (window as any).__cameraRequests, errors: (window as any).__errors, state: (window as any).__track.readyState }))).toEqual({ calls: 1, errors: [], state: 'ended' });
});

import { test, expect, type BrowserContext } from '../fixtures';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function setup(context: BrowserContext, memory: boolean) {
  await context.addInitScript(memory => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    if (memory) Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  }, memory);
}

for (const memory of [false, true]) test(`${memory ? 'memory' : 'disk'} downloads preserve original extensions, MIME types and playable bytes`, async ({ page, context }) => {
  await setup(context, memory);
  const receiver = await context.newPage(); await page.goto('./');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const files = [
    { name: '原图.png', mimeType: '', expectedType: 'image/png', buffer: Buffer.from(png, 'base64') },
    { name: '电影.mp4', mimeType: 'application/octet-stream', expectedType: 'video/mp4', buffer: await readFile('tests/fixtures/download-preview.mp4') },
    { name: '说明.txt', mimeType: 'text/plain', expectedType: 'text/plain', buffer: Buffer.from('A small file stays a text file.') },
    { name: 'original.bin', mimeType: 'application/octet-stream', expectedType: 'application/octet-stream', buffer: Buffer.from([0, 255, 3, 9]) },
    { name: 'unknown.custom', mimeType: '', expectedType: '', buffer: Buffer.from([0, 1, 2, 3]) }
  ];
  await page.locator('#file-input').setInputFiles(files.map(({ expectedType: _, ...file }) => file));
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  if (!memory) await receiver.reload();
  await expect(receiver.locator('.download-file')).toHaveCount(files.length);
  for (const file of files) {
    const link = receiver.locator(`.download-file[download="${file.name}"]`);
    const type = await link.evaluate(async anchor => (await fetch((anchor as HTMLAnchorElement).href)).headers.get('content-type') || '');
    expect(type).toBe(file.expectedType);
    const pending = receiver.waitForEvent('download'); await link.click(); const download = await pending;
    expect(download.suggestedFilename()).toBe(file.name);
    expect(digest(await readFile((await download.path())!))).toBe(digest(file.buffer));
  }
  const preview = await receiver.evaluate(async () => {
    const image = new Image(); image.src = (document.querySelector('a[download="原图.png"]') as HTMLAnchorElement).href;
    await image.decode();
    const video = document.createElement('video'); video.src = (document.querySelector('a[download="电影.mp4"]') as HTMLAnchorElement).href;
    await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(Error('Video not playable')); });
    return { imageWidth: image.naturalWidth, videoWidth: video.videoWidth, duration: video.duration };
  });
  expect(preview.imageWidth).toBe(2); expect(preview.videoWidth).toBe(32); expect(preview.duration).toBeGreaterThan(0);
});

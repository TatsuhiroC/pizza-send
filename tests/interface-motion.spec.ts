import { test, expect } from './fixtures';
import QRCode from 'qrcode';
import { shareFragment } from '../src/share';
test.use({ trace: 'retain-on-failure' });

test('glass filename overlay dismisses outside, retains inside interaction, and restores focus', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('./');
  const name = '假日照片与朋友一起去海边看日落'.repeat(5) + '.jpg';
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'image/jpeg', buffer: Buffer.from('filename fixture') });
  const opener = page.locator('#files .filename-button'); await opener.click();
  await expect(page.locator('#full-filename')).toHaveText(name);
  await page.locator('#full-filename').click(); await expect(page.locator('#filename-dialog')).toBeVisible();
  const surface = await page.locator('.filename-surface').boundingBox();
  expect(surface!.width).toBeLessThan(390);
  // Selecting text and releasing outside must not accidentally dismiss it.
  await page.mouse.move(surface!.x + 20, surface!.y + 70); await page.mouse.down();
  await page.mouse.move(4, 4); await page.mouse.up();
  await expect(page.locator('#filename-dialog')).toBeVisible();
  await page.screenshot({ path: info.outputPath('filename-glass-mobile.png') });
  await page.mouse.click(4, 4); await expect(page.locator('#filename-dialog')).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click(); await page.keyboard.press('Escape');
  await expect(page.locator('#filename-dialog')).toBeHidden(); await expect(opener).toBeFocused();
});

test('canceling scan success prevents a delayed connection and permits scanning again', async ({ page }) => {
  test.setTimeout(45000);
  await page.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied for fixture', 'NotAllowedError'); };
  });
  let connections = 0;
  page.on('request', request => { if (new URL(request.url()).port === '8787' && new URL(request.url()).pathname.startsWith('/rooms/')) connections++; });
  await page.goto('./'); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  const link = 'http://127.0.0.1:5173/#' + shareFragment('11'.repeat(32));
  const image = { name: 'share.png', mimeType: 'image/png', buffer: await QRCode.toBuffer(link, { width: 480, margin: 4 }) };
  const uploadImage = () => page.evaluate(({ name, mimeType, base64 }) => {
    const input = document.getElementById('qr-image-input') as HTMLInputElement;
    const files = new DataTransfer();
    files.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, { type: mimeType }));
    input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { name: image.name, mimeType: image.mimeType, base64: image.buffer.toString('base64') });
  // Cancel at the actual success event. A remote automation click can arrive
  // after this short-lived dialog has already closed, especially in WebKit.
  const canceledSuccess = page.evaluate(() => new Promise<string>(resolve => {
    const success = document.getElementById('scan-success')!;
    const observer = new MutationObserver(() => {
      if (success.hidden) return;
      const message = document.getElementById('scan-status')!.textContent!;
      observer.disconnect(); document.getElementById('close-scanner')!.click(); resolve(message);
    });
    observer.observe(success, { attributes: true, attributeFilter: ['hidden'] });
  }));
  await uploadImage();
  expect(await canceledSuccess).toContain('扫描成功');
  await expect(page.locator('#scan-dialog')).toBeHidden();
  await page.waitForTimeout(950);
  expect(connections).toBe(0); await expect(page.locator('#session-panel')).toBeHidden();
  await page.locator('#open-scanner').click(); await expect(page.locator('#scan-success')).toBeHidden();
  await uploadImage(); await expect(page.locator('#scan-success')).toBeVisible();
  await expect(page.locator('#scan-dialog')).toBeHidden(); await expect(page.locator('#session-panel')).toBeVisible();
  await expect.poll(() => connections).toBeGreaterThan(0);
  await expect(page.locator('#receive-entry')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('连接未完成');
  await expect(page.locator('#status')).toBeInViewport({ ratio: 1 });
  expect(await page.locator('#scan-freeze').evaluate(el => (el as HTMLCanvasElement).width)).toBe(0);
});

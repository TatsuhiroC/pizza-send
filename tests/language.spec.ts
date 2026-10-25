import { test, expect } from './fixtures';

test('compact language switch translates the full page, preserves files and remembers the choice', async ({ page }, info) => {
  await page.goto('./');
  const toggle = page.locator('#language-toggle');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#start-send')).toContainText('Start sharing');
  await page.locator('.faq > summary').click();
  await page.locator('.settings > summary').click();
  await expect(page.locator('.faq')).toContainText('Can I send large files?');
  await expect(page.locator('#receive-code')).toHaveAttribute('placeholder', /Paste a PizzaSend/);
  const untranslated = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelector('#language-toggle')?.remove();
    return clone.textContent?.match(/[\u4e00-\u9fff]+/g) || [];
  });
  expect(untranslated).toEqual([]);
  await page.locator('#file-input').setInputFiles({ name: '直接送达.txt', mimeType: 'text/plain', buffer: Buffer.from('unchanged content') });
  await expect(page.locator('#files strong')).toHaveText('直接送达.txt');
  await expect(page.locator('#selection-summary')).toContainText('1 file');
  await toggle.click();
  await expect(page.locator('#selection-summary')).toContainText('1 个文件');
  await expect(page.locator('#files strong')).toHaveText('直接送达.txt');
  await toggle.click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('PizzaSend · File transfer');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: info.outputPath('pizza-send-english.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await toggle.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(70);
    expect(bounds!.height).toBeLessThanOrEqual(32);
    await page.screenshot({ path: info.outputPath(`pizza-send-english-${width}.png`) });
    const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({ tag: e.tagName, id: e.id, class: e.className, right: e.getBoundingClientRect().right })));
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('switching while paired preserves the session and translates completion and downloads', async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: '文件送到.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2 * 1024 * 1024, 7) });
  await page.locator('#start-send').click();
  await expect(page.locator('#share-box')).toBeVisible();
  const link = await page.locator('#share-link').inputValue();
  await page.locator('#language-toggle').click();
  await expect(page.locator('#status')).toHaveText('Waiting for receiver');
  expect(await page.locator('#share-link').inputValue()).toBe(link);
  await expect(page.locator('.remove-file')).toBeDisabled();
  const receiver = await context.newPage();
  await receiver.goto(link);
  await expect(receiver.locator('#accept-files')).toBeVisible();
  await expect(receiver.locator('html')).toHaveAttribute('lang', 'en');
  await expect(receiver.locator('#save-note')).toContainText('Files are written to this device’s disk');
  await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('Files received. Save to your device.');
  await expect(receiver.locator('.download-file')).toHaveText('Save to device');
  await receiver.locator('#language-toggle').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await expect(receiver.locator('.download-file')).toHaveText('保存到设备');
  await expect(receiver.locator('#connection-path')).toContainText('DTLS 加密');
  await receiver.locator('#language-toggle').click();
  await expect(receiver.locator('#connection-path')).toContainText('DTLS encrypted');
});

import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
async function initialize(page: any, mode = 'success') {
  await page.goto('./');
  return page.evaluate(async (mode: string) => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Safari/604.1' });
    const s = window as any; s.__activation = []; s.__files = []; s.__blobReads = 0;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: mode === 'missing' ? undefined : () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: mode === 'missing' ? undefined : (data: ShareData) => {
      s.__activation.push(navigator.userActivation?.isActive); s.__files = data.files;
      return mode === 'pending' ? new Promise(resolve => s.__done = resolve) : Promise.resolve();
    } });
    const fetchFile = fetch.bind(window);
    window.fetch = (input, options) => {
      if (String(input).startsWith('blob:')) { s.__blobReads++; if (mode === 'preparing') return new Promise(resolve => s.__finishRead = () => resolve(new Response(new Blob(['image-0'], { type: 'image/png' })))); }
      return fetchFile(input, options);
    };
    const root = document.createElement('div'); root.innerHTML = '<button id="probe-all"></button><p id="probe-note"></p><dialog id="probe-dialog"><p id="probe-name"></p><p id="probe-progress"></p><a id="probe-next"></a><button id="probe-close">Close</button></dialog><p id="probe-feedback"></p>'; document.body.append(root);
    const el = (id: string) => document.getElementById(id) as any;
    const { MobileBatchSave } = await import('/src/mobile-save.ts');
    s.__requests = [];
    s.__controller = new MobileBatchSave({ button: el('probe-all'), note: el('probe-note'), dialog: el('probe-dialog'), next: el('probe-next'), filename: el('probe-name'), progress: el('probe-progress'), close: el('probe-close'),
      requested: (items: any[]) => s.__requests.push(...items.map(f => f.key)), retain: () => {}, feedback: (text: string) => el('probe-feedback').textContent = text });
    el('probe-all').onclick = () => s.__controller.open();
    s.__items = Array.from({ length: 3 }, (_, i) => ({ key: String(i), name: `image-${i}.png`, type: 'image/png', size: 7, url: URL.createObjectURL(new Blob(['image-' + i], { type: 'image/png' })) }));
    if (mode === 'large') s.__items[0].size = 65 * 1048576;
    s.__controller.update(s.__items, 1);
  }, mode);
}
test('prepared files reach the system in one live gesture with exact names, bytes and count', async ({ page }) => {
  await initialize(page); await expect(page.locator('#probe-all')).toHaveText('保存全部'); await page.locator('#probe-all').click();
  const result = await page.evaluate(async () => { const s = window as any; return { activation: s.__activation, requests: s.__requests, files: await Promise.all(s.__files.map(async (f: File) => [f.name, f.type, await f.text()])) }; });
  expect(result.activation).toEqual([true]); expect(result.requests).toEqual(['0', '1', '2']);
  expect(result.files).toEqual(Array.from({ length: 3 }, (_, i) => [`image-${i}.png`, 'image/png', `image-${i}`]));
});
test('unsupported file sharing uses three explicit gestures and never downloads later files automatically', async ({ page }) => {
  await initialize(page, 'missing'); await page.locator('#probe-all').click(); await expect(page.locator('#probe-dialog')).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await expect(page.locator('#probe-next')).toHaveAttribute('download', `image-${i}.png`);
    const pending = page.waitForEvent('download'); await page.locator('#probe-next').click(); const downloaded = await pending;
    expect(downloaded.suggestedFilename()).toBe(`image-${i}.png`); expect((await readFile((await downloaded.path())!)).toString()).toBe(`image-${i}`);
  }
  await expect(page.locator('#probe-dialog')).toBeHidden(); expect(await page.evaluate(() => (window as any).__requests)).toEqual(['0', '1', '2']);
});
test('large batches skip preparation and retain the individual download route', async ({ page }) => {
  await initialize(page, 'large'); await expect(page.locator('#probe-all')).toHaveText('逐个保存'); expect(await page.evaluate(() => (window as any).__blobReads)).toBe(0);
  await page.locator('#probe-all').click(); await expect(page.locator('#probe-dialog')).toBeVisible();
});
test('canceling preparation rejects a late file read without changing the new context', async ({ page }) => {
  await initialize(page, 'preparing'); await expect(page.locator('#probe-all')).toBeDisabled();
  await page.evaluate(() => (window as any).__controller.cancel()); await page.evaluate(() => (window as any).__finishRead());
  await expect(page.locator('#probe-all')).toHaveText('逐个保存'); expect(await page.evaluate(() => (window as any).__requests)).toEqual([]);
});
test('closing a sequential dialog stops its queue, and reopening uses the correct first filename', async ({ page }) => {
  await initialize(page, 'missing'); await page.locator('#probe-all').click(); await page.locator('#probe-close').click(); await expect(page.locator('#probe-dialog')).toBeHidden();
  await page.locator('#probe-all').click(); await expect(page.locator('#probe-next')).toHaveAttribute('download', 'image-0.png');
});
test('late system completion after cancel cannot produce old save markers', async ({ page }) => {
  await initialize(page, 'pending'); await expect(page.locator('#probe-all')).toHaveText('保存全部'); await page.locator('#probe-all').click();
  await page.evaluate(() => { const s = window as any; s.__controller.cancel(); s.__done(); });
  expect(await page.evaluate(() => (window as any).__requests)).toEqual([]); await expect(page.locator('#probe-feedback')).toBeEmpty();
});

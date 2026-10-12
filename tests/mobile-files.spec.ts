import { test, expect, type Page, type Locator } from './fixtures';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function preview(page: Page, button: Locator, name: string) {
  await button.click(); await expect(page.locator('#filename-dialog')).toBeVisible();
  await expect(page.locator('#full-filename')).toHaveText(name); await fits(page);
  await page.keyboard.press('Escape'); await expect(page.locator('#filename-dialog')).toBeHidden();
  await expect(button).toBeFocused();
}
for (const memory of [false, true]) test(`${memory ? 'memory' : 'disk'} long filenames fit mobile, open in a dialog, and download unchanged`, async ({ page, context }, info) => {
  await context.addInitScript(memory => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    if (memory) Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  }, memory);
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto('./');
  const files = [
    { name: 'VeryLongUnbrokenFilename'.repeat(7) + '.txt', mimeType: 'text/plain', buffer: Buffer.from('original long-name file') },
    { name: '手机电影超长名称'.repeat(8) + '.mp4', mimeType: 'video/mp4', buffer: Buffer.from('original Unicode-name file') }
  ];
  await page.locator('#file-input').setInputFiles(files); await fits(page);
  const selected = page.locator('#files .filename-button').first();
  expect(await selected.locator('strong').evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis')).toBe(true);
  await preview(page, selected, files[0].name);
  await page.locator('#language-toggle').click(); await selected.click();
  await expect(page.locator('#filename-heading')).toHaveText('Full filename');
  await expect(page.locator('#full-filename')).toHaveText(files[0].name);
  await page.locator('#close-filename').click(); await expect(selected).toBeFocused();
  await page.locator('#language-toggle').click(); await page.locator('#start-send').click();
  await expect(page.locator('#share-box')).toBeVisible(); await fits(page);
  const receiver = await context.newPage(); await receiver.setViewportSize({ width: 320, height: 844 });
  await receiver.goto(await page.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible(); await fits(receiver);
  await preview(receiver, receiver.locator('#incoming-files .filename-button').first(), files[0].name);
  await receiver.locator('#accept-files').click(); await expect(receiver.locator('#status')).toHaveText('传输完成，原样送达。');
  await fits(page); await fits(receiver);
  await preview(receiver, receiver.locator('#current-file'), files[1].name);
  const names = receiver.locator(memory ? '#downloads .filename-button' : '#stored-files .filename-button');
  let downloads = 0; receiver.on('download', () => downloads++);
  const first = await names.first().textContent(); await preview(receiver, names.first(), first!); expect(downloads).toBe(0);
  expect(await names.first().evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).whiteSpace === 'nowrap')).toBe(true);
  await receiver.screenshot({ path: info.outputPath('long-filenames-320.png'), fullPage: true });
  for (const file of files) {
    const pending = receiver.waitForEvent('download'); await receiver.locator(`a[download="${file.name}"]`).click(); const download = await pending;
    expect(download.suggestedFilename()).toBe(file.name); expect(digest(await readFile((await download.path())!))).toBe(digest(file.buffer));
  }
  await receiver.locator('#language-toggle').click(); await fits(receiver);
  await expect(receiver.locator('.download-file').first()).toHaveText('Save');
  await preview(receiver, names.first(), first!);
});

test('temporary files show latest completion first across batches; saving preserves order and the top cleanup clears all', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto('./');
  const data = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/received-storage.ts')!.name;
    const s = await import(url), hash = '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a';
    // This batch starts first but its next file completes after a newer batch.
    const slow = (await s.createTemporarySession(2))!;
    await s.beginTemporaryFile(slow, { id: 0, name: 'first.txt', size: 1, type: 'text/plain' });
    await s.writeTemporaryFile(slow, 0, new Uint8Array([1]).buffer); await s.finishTemporaryFile(slow, hash);
    const newer = (await s.createTemporarySession(1))!;
    await s.beginTemporaryFile(newer, { id: 0, name: 'second.txt', size: 1, type: 'text/plain' });
    await s.writeTemporaryFile(newer, 0, new Uint8Array([1]).buffer); await s.finishTemporaryFile(newer, hash); await s.completeTemporarySession(newer);
    await s.beginTemporaryFile(slow, { id: 1, name: 'last-completed.txt', size: 1, type: 'text/plain' });
    await s.writeTemporaryFile(slow, 0, new Uint8Array([1]).buffer); await s.finishTemporaryFile(slow, hash); await s.completeTemporarySession(slow);
    return { url, slow, newer };
  });
  const names = page.locator('#stored-files .filename-button');
  await expect(names).toHaveText(['last-completed.txt', 'second.txt', 'first.txt']);
  const records = await page.evaluate(async url => (await import(url)).listTemporaryFiles(), data.url);
  expect(records.every(file => Number.isSafeInteger(file.receivedAt))).toBe(true);
  const clear = page.locator('#clear-stored'); await expect(clear).toHaveCount(1);
  const bounds = await clear.boundingBox(), first = await names.first().boundingBox();
  expect(bounds!.height).toBeGreaterThanOrEqual(44); expect(bounds!.y + bounds!.height).toBeLessThan(first!.y);
  expect(await clear.evaluate(el => getComputedStyle(el).borderStyle)).toBe('solid'); await fits(page);
  const pending = page.waitForEvent('download'); await page.locator('a[download="first.txt"]').click(); await pending;
  await expect(names).toHaveText(['last-completed.txt', 'second.txt', 'first.txt']);
  await page.reload(); await expect(names).toHaveText(['last-completed.txt', 'second.txt', 'first.txt']);
  // Older records without the new timestamp remain compatible and use batch time.
  await page.evaluate(async ({ slow, newer }) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('pizzasend-received-v1');
    for (const [id, time] of [[slow, Date.now() - 2000], [newer, Date.now() - 1000]] as const) {
      const dir = await root.getDirectoryHandle(id);
      for (const name of ['index-a.json', 'index-b.json']) {
        const handle = await dir.getFileHandle(name), index = JSON.parse(await (await handle.getFile()).text());
        index.createdAt = time; for (const entry of index.files) delete entry.receivedAt;
        const stream = await handle.createWritable(); await stream.write(JSON.stringify(index)); await stream.close();
      }
    }
  }, data);
  await page.reload(); await expect(names).toHaveText(['second.txt', 'last-completed.txt', 'first.txt']);
  await page.locator('#language-toggle').click(); await fits(page);
  await expect(clear).toHaveText('Saved · clear all temporary files');
  await page.locator('#stored-panel').screenshot({ path: info.outputPath('top-cleanup-320.png') });
  await clear.click(); await expect(page.locator('#cleanup-name')).toContainText('3 files'); await page.locator('#keep-stored').click();
  await expect(names).toHaveCount(3);
  await clear.click(); await page.locator('#confirm-cleanup').click(); await expect(page.locator('#cleanup-dialog')).toBeHidden();
  await expect(names).toHaveCount(0);
});

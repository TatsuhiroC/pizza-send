import { test, expect, type BrowserContext, type Page } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
async function setup(context: BrowserContext, memory = false) {
  await context.addInitScript(memory => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    if (memory) Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined, configurable: true });
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function() { if (this.size <= 32768) await new Promise(r => setTimeout(r, 5)); return read.call(this); };
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  }, memory);
}
async function begin(sender: Page, receiver: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await sender.goto('./'); await sender.locator('#file-input').setInputFiles(files); await sender.locator('#start-send').click();
  await expect(sender.locator('#share-qr')).toBeVisible(); await receiver.goto(await sender.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
}
for (const memory of [false, true]) test(`${memory ? 'memory' : 'disk'} reception reveals a usable save action in the mobile viewport and preserves the direct download gesture`, async ({ page, context }, info) => {
  await setup(context, memory);
  const receiver = await context.newPage(); await receiver.setViewportSize({ width: 320, height: 640 });
  const buffer = Buffer.alloc(4 * 1048576, 47), file = { name: '还需要保存到设备.mp4', mimeType: 'video/mp4', buffer };
  await begin(page, receiver, [file]);
  await expect(receiver.locator('#save-panel')).toBeHidden();
  await receiver.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const save = receiver.locator('#save-panel .download-file'); await expect(save).toHaveCount(1);
  await expect(save).toHaveText('保存到设备');
  await expect.poll(() => save.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
  await expect(receiver.locator('#save-heading')).toBeFocused();
  await expect(receiver.locator('#download-all')).toBeHidden();
  const layout = await receiver.evaluate(() => ({ save: document.getElementById('save-panel')!.getBoundingClientRect().bottom, progress: document.getElementById('progress-box')!.getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth }));
  expect(layout.save).toBeLessThanOrEqual(layout.progress); expect(layout.overflow).toBe(false);
  await expect(receiver.locator('#save-retention')).toContainText(memory ? '刷新或关闭页面会丢失' : '10 分钟');
  await receiver.locator('#session-panel').screenshot({ path: info.outputPath('mobile-save-' + (memory ? 'memory' : 'disk') + '.png') });
  const pending = receiver.waitForEvent('download'); await save.click(); const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe(file.name);
  expect(createHash('sha256').update(await readFile((await downloaded.path())!)).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'));
  await expect(receiver.locator('#save-feedback')).toContainText('已发起保存，请确认浏览器的下载提示');
  await expect(receiver.locator('#status')).toHaveText('已发起保存，请确认下载提示');
  await expect(receiver.locator('#status')).not.toHaveText('已保存到设备');
  await receiver.locator('#language-toggle').click(); await expect(save).toHaveText('Save to device');
  await expect(receiver.locator('#save-feedback')).toContainText('Confirm your browser');
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('multiple files get separate prominent actions; a cancelled download is only marked requested, and clearing removes current actions', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage(); await receiver.setViewportSize({ width: 320, height: 640 });
  await begin(page, receiver, [
    { name: '第一份.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024) },
    { name: '第二份.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024, 1) }
  ]);
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const saves = receiver.locator('#save-panel .download-file'); await expect(saves).toHaveCount(2);
  await expect(saves).toHaveText(['保存到设备', '保存到设备']);
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  let downloads = 0; receiver.on('download', () => downloads++);
  // Browsers do not reveal whether the user accepts their download prompt.
  await saves.first().evaluate(a => a.addEventListener('click', e => e.preventDefault(), { once: true }));
  await saves.first().click(); await expect(receiver.locator('#save-panel .save-request-state')).toHaveCount(1);
  await expect(receiver.locator('#save-feedback')).toContainText('请确认浏览器的下载提示');
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备'); expect(downloads).toBe(0);
  await receiver.locator('#clear-stored').click(); await receiver.locator('#confirm-cleanup').click();
  await expect(saves).toHaveCount(0); await expect(receiver.locator('#save-empty')).toBeVisible();
  await expect(receiver.locator('#save-empty')).toContainText('如未保存');
});
test('native disk reception reports saved only after the writer closes, without asking to save again', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    (window as any).__writerClosed = false;
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('native-save-flow.txt', { create: true });
      return { createWritable: async () => {
        const stream = await handle.createWritable();
        return { write: (data: any) => stream.write(data), close: async () => { await stream.close(); (window as any).__writerClosed = true; }, abort: () => stream.abort() };
      } };
    } });
  });
  await begin(page, receiver, [{ name: 'original.txt', mimeType: 'text/plain', buffer: Buffer.from('already on disk') }]);
  await expect(receiver.locator('#status')).toHaveText('已保存到设备');
  expect(await receiver.evaluate(() => (window as any).__writerClosed)).toBe(true);
  await expect(receiver.locator('#save-panel')).toBeHidden(); await expect(receiver.locator('.download-file')).toHaveCount(0);
  expect(await receiver.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('native-save-flow.txt')).getFile()).text())).toBe('already on disk');
});
for (const memory of [false, true]) test(`${memory ? 'memory' : 'disk'} Download all uses original files without a folder picker and keeps individual saving available`, async ({ page, context }, info) => {
  await setup(context, memory);
  const receiver = await context.newPage(); await receiver.setViewportSize({ width: 320, height: 844 });
  await receiver.addInitScript(() => {
    (window as any).__pickerCalls = 0;
    const rejectPicker = async () => { (window as any).__pickerCalls++; throw new Error('Multi-file reception must not open a picker'); };
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: rejectPicker });
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: rejectPicker });
  });
  const files = [
    { name: '原文件.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(4096, 71) },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    ...Array.from({ length: memory ? 1 : 98 }, (_, i) => ({ name: 'file-' + i + '.txt', mimeType: 'text/plain', buffer: Buffer.from('file content ' + i) }))
  ];
  await begin(page, receiver, files);
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  expect(await receiver.evaluate(() => (window as any).__pickerCalls)).toBe(0);
  const all = receiver.locator('#download-all'), saves = receiver.locator('#save-panel .download-file');
  await expect(all).toBeVisible(); await expect(all).toHaveText('下载全部'); await expect(saves).toHaveCount(files.length);
  await receiver.locator('#language-toggle').click(); await expect(all).toHaveText('Download all');
  await expect(receiver.locator('#download-all-note')).toContainText('Allow multiple downloads');
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await receiver.locator('#save-heading').scrollIntoViewIfNeeded();
  await receiver.screenshot({ path: info.outputPath('download-all-' + (memory ? 'memory' : 'disk') + '.png') });
  const downloads: any[] = []; receiver.on('download', download => downloads.push(download));
  await all.click();
  await expect.poll(() => downloads.length, { timeout: 35000 }).toBe(files.length);
  expect(downloads.map(download => download.suggestedFilename()).sort()).toEqual(files.map(file => file.name).sort());
  for (const download of downloads) {
    const original = files.find(file => file.name === download.suggestedFilename())!;
    expect(createHash('sha256').update(await readFile((await download.path())!)).digest('hex')).toBe(createHash('sha256').update(original.buffer).digest('hex'));
  }
  await expect(receiver.locator('#save-feedback')).toContainText(`Downloads requested for ${files.length} files`);
  await expect(receiver.locator('#status')).not.toHaveText('Saved to your device');
  await expect(saves).toHaveCount(files.length);
  // A separate user click can save a file again if the browser blocked it in the batch.
  const firstName = await saves.first().locator('..').locator('.filename-button').textContent();
  const repeated = receiver.waitForEvent('download'); await saves.first().click();
  expect((await repeated).suggestedFilename()).toBe(firstName);
  if (!memory) {
    await receiver.locator('#clear-stored').click(); await receiver.locator('#confirm-cleanup').click();
    await expect(all).toBeHidden(); await expect(saves).toHaveCount(0);
  }
});
for (const action of ['reset', 'cleanup']) test(`Download all stops pending batches after ${action}`, async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  await begin(page, receiver, Array.from({ length: 12 }, (_, i) => ({ name: `cancel-${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`file ${i}`) })));
  await expect(receiver.locator('#download-all')).toBeVisible();
  const downloads: any[] = []; receiver.on('download', download => downloads.push(download));
  await receiver.locator('#download-all').click();
  await expect(receiver.locator('#download-all')).toBeDisabled();
  await expect.poll(() => downloads.length).toBe(5);
  if (action === 'reset') await receiver.locator('#cancel').click();
  else { await receiver.locator('#clear-stored').click(); await receiver.locator('#confirm-cleanup').click(); }
  if (action === 'reset') await expect(receiver.locator('#save-panel')).toBeHidden();
  else await expect(receiver.locator('#save-empty')).toBeVisible();
  // Observe beyond the next batch's delay: cancelled work must not download stale files.
  await receiver.waitForTimeout(1500);
  expect(downloads).toHaveLength(5);
  await expect(receiver.locator('#download-all')).toBeHidden();
});
test('completion waits for an open filename dialog and reveals saving after it closes, without following later resets', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage(); await receiver.setViewportSize({ width: 320, height: 640 });
  await begin(page, receiver, [{ name: '传输中查看名称.txt', mimeType: 'text/plain', buffer: Buffer.alloc(4 * 1048576) }]);
  await receiver.locator('#incoming-files .filename-button').click(); await expect(receiver.locator('#filename-dialog')).toBeVisible();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await expect(receiver.locator('#filename-dialog')).toBeVisible(); await expect(receiver.locator('#close-filename')).toBeFocused();
  await receiver.locator('#close-filename').click(); await expect(receiver.locator('#save-heading')).toBeFocused();
  await receiver.locator('#cancel').click(); await expect(receiver.locator('#save-panel')).toBeHidden();
  await expect(receiver.locator('#session-panel')).toBeHidden();
});

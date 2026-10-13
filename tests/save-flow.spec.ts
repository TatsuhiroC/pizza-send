import { test, expect, type BrowserContext, type Page } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
async function setup(context: BrowserContext, memory = false) {
  await context.addInitScript(memory => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
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
test('native multi-file reception explains the subfolder restriction before picking, allows cancellation and preserves existing files', async ({ page, context }, info) => {
  await setup(context);
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    (window as any).__folderChoices = [];
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async (options: any) => {
      const choices = (window as any).__folderChoices;
      choices.push(options);
      if (choices.length === 1) throw new DOMException('Cancelled by user', 'AbortError');
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('native-multiple', { create: true });
      const existing = await directory.getFileHandle('first.txt', { create: true });
      const writer = await existing.createWritable(); await writer.write('keep existing'); await writer.close();
      return directory;
    } });
  });
  await page.goto('./');
  await page.locator('#file-input').setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first received') },
    { name: '第二份.txt', mimeType: 'text/plain', buffer: Buffer.from('second received') }
  ]);
  await page.locator('#start-send').click();
  await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue());
  const accept = receiver.locator('#accept-files'), note = receiver.locator('#save-note');
  await expect(accept).toHaveText('选择子文件夹并接收');
  await expect(note).toBeVisible(); await expect(note).toContainText('浏览器不允许直接选择');
  expect(await receiver.evaluate(() => (window as any).__folderChoices.length)).toBe(0);
  expect(await note.evaluate(el => el.getBoundingClientRect().bottom <= document.getElementById('accept-files')!.getBoundingClientRect().top)).toBe(true);
  await receiver.locator('#language-toggle').click();
  await expect(accept).toHaveText('Choose a subfolder and receive');
  await expect(note).toContainText('Downloads, Desktop or Documents themselves');
  await receiver.setViewportSize({ width: 320, height: 844 });
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await receiver.locator('#receive-view').screenshot({ path: info.outputPath('native-folder-guidance.png') });
  await accept.click();
  await expect(accept).toBeEnabled(); await expect(receiver.locator('#progress-box')).toBeHidden();
  await accept.click();
  await expect(receiver.locator('#status')).toHaveText('Saved to your device');
  await expect(receiver.locator('#save-panel')).toBeHidden();
  expect(await receiver.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('native-multiple');
    const contents = await Promise.all(['first.txt', '1-first.txt', '第二份.txt'].map(async name => (await (await directory.getFileHandle(name)).getFile()).text()));
    return { contents, choices: (window as any).__folderChoices };
  })).toEqual({ contents: ['keep existing', 'first received', 'second received'], choices: [
    { id: 'pizza-send-receive-folder', mode: 'readwrite' }, { id: 'pizza-send-receive-folder', mode: 'readwrite' }
  ] });
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

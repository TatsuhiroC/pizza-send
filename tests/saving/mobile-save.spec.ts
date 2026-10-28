import { test, expect, type BrowserContext, type Page } from '../fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup(context: BrowserContext, memory: boolean, mode: 'success' | 'cancel' | 'missing' | 'denied' | 'pending' = 'success') {
  await context.addInitScript(({ memory, mode }) => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    if (memory) Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined });
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', configurable: true });
    const state = window as any; state.__shares = []; state.__shareActive = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: mode === 'missing' ? undefined : (data: ShareData) => !!data.files?.length });
    Object.defineProperty(navigator, 'share', { configurable: true, value: mode === 'missing' ? undefined : (data: ShareData) => {
      state.__shares.push(data.files); state.__shareActive.push(navigator.userActivation.isActive);
      if (!navigator.userActivation.isActive) return Promise.reject(new DOMException('Gesture missing', 'NotAllowedError'));
      if (mode === 'cancel') return Promise.reject(new DOMException('User canceled', 'AbortError'));
      if (mode === 'denied') return Promise.reject(new DOMException('Unavailable', 'NotAllowedError'));
      if (mode === 'pending') return new Promise(resolve => state.__finishShare = resolve);
      return Promise.resolve();
    } });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  }, { memory, mode });
}
async function receive(sender: Page, receiver: Page, count = 3) {
  await sender.goto('./');
  const pictures = await sender.evaluate(() => ['red', 'green', 'blue'].map(color => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4; const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 4, 4);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  const files = pictures.slice(0, count).map((data, i) => ({ name: `原图 ${i + 1}.png`, mimeType: '', buffer: Buffer.from(data, 'base64') }));
  await sender.locator('#file-input').setInputFiles(files); await sender.locator('#start-send').click(); await expect(sender.locator('#share-qr')).toBeVisible();
  await receiver.goto(await sender.locator('#share-link').inputValue()); await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await expect(receiver.locator('#save-panel .download-file')).toHaveCount(count); return files;
}
for (const memory of [false, true]) test(`${memory ? 'memory' : 'disk'} iPhone saves three original images in one activated system request`, async ({ page, context }, info) => {
  await setup(context, memory); const receiver = await context.newPage(); await receiver.setViewportSize({ width: 320, height: 844 });
  const files = await receive(page, receiver), downloads: unknown[] = []; receiver.on('download', d => downloads.push(d));
  await expect(receiver.locator('#download-all')).toHaveText('保存全部'); await expect(receiver.locator('#download-all')).toBeEnabled();
  await receiver.locator('#save-heading').scrollIntoViewIfNeeded(); await receiver.screenshot({ path: info.outputPath('iphone-save-all.png') });
  await receiver.locator('#download-all').click();
  await expect(receiver.locator('#save-feedback')).toContainText('3 个文件交给系统');
  const exported = await receiver.evaluate(async () => {
    const s = window as any;
    return { calls: s.__shares.length, active: s.__shareActive, files: await Promise.all(s.__shares[0].map(async (f: File) => ({ name: f.name, type: f.type, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) }))) };
  });
  expect(exported.calls).toBe(1); expect(exported.active).toEqual([true]); expect(exported.files).toHaveLength(3); expect(downloads).toHaveLength(0);
  for (const f of exported.files) { expect(f.type).toBe('image/png'); expect(digest(Buffer.from(f.bytes))).toBe(digest(files.find(item => item.name === f.name)!.buffer)); }
  await expect(receiver.locator('#status')).not.toHaveText('已保存到设备');
  await receiver.locator('#language-toggle').click(); await expect(receiver.locator('#download-all')).toHaveText('Save all');
  await expect(receiver.locator('#download-all-note')).toContainText('Save to Files'); expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
for (const mode of ['missing', 'denied'] as const) test(`iPhone ${mode} batch API falls back to one original file per user click`, async ({ page, context }) => {
  await setup(context, false, mode); const receiver = await context.newPage(); await receiver.setViewportSize({ width: 320, height: 844 });
  const files = await receive(page, receiver); await expect(receiver.locator('#download-all')).toBeEnabled(); await receiver.locator('#download-all').click();
  await expect(receiver.locator('#batch-save-dialog')).toBeVisible();
  const downloads: any[] = []; receiver.on('download', d => downloads.push(d));
  expect(downloads).toHaveLength(0);
  for (let i = 0; i < 3; i++) {
    const next = receiver.locator('#batch-save-next'); await expect(next).toHaveText(`保存第 ${i + 1} 个文件（共 3 个）`);
    const filename = await next.getAttribute('download'), pending = receiver.waitForEvent('download'); await next.click(); const result = await pending;
    expect(result.suggestedFilename()).toBe(filename); expect(digest(await readFile((await result.path())!))).toBe(digest(files.find(f => f.name === filename)!.buffer));
    expect(downloads).toHaveLength(i + 1);
  }
  await expect(receiver.locator('#batch-save-dialog')).toBeHidden(); await expect(receiver.locator('#save-feedback')).toContainText('逐个发起 3 个文件');
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('canceling system save keeps all original actions without triggering fallback downloads', async ({ page, context }) => {
  await setup(context, true, 'cancel'); const receiver = await context.newPage(); await receive(page, receiver);
  await expect(receiver.locator('#download-all')).toHaveText('保存全部'); const downloads: unknown[] = []; receiver.on('download', d => downloads.push(d));
  await receiver.locator('#download-all').click(); await expect(receiver.locator('#save-feedback')).toContainText('已取消批量保存');
  await expect(receiver.locator('#download-all')).toBeEnabled(); await expect(receiver.locator('#batch-save-dialog')).toBeHidden(); await expect(receiver.locator('.save-request-state')).toHaveCount(0);
  await expect(receiver.locator('#save-panel .download-file')).toHaveCount(3); expect(downloads).toHaveLength(0);
});
test('late system-save completion cannot mark a reset session as saved', async ({ page, context }) => {
  await setup(context, false, 'pending'); const receiver = await context.newPage(); await receive(page, receiver);
  await expect(receiver.locator('#download-all')).toHaveText('保存全部'); await receiver.locator('#download-all').click(); await expect(receiver.locator('#download-all')).toBeDisabled();
  await receiver.locator('#cancel').click(); await receiver.evaluate(() => (window as any).__finishShare());
  await expect(receiver.locator('#save-panel')).toBeHidden(); await expect(receiver.locator('.save-request-state')).toHaveCount(0);
});

for (const memory of [false, true]) test(`${memory ? 'memory' : 'disk'} iPhone can choose just one image from a received batch`, async ({ page, context }) => {
  await setup(context, memory); const receiver = await context.newPage(); const files = await receive(page, receiver);
  const link = receiver.locator('#save-panel .download-file').nth(1); await expect(link).not.toHaveAttribute('aria-disabled', 'true');
  const name = await link.getAttribute('download'); const downloads: any[] = []; receiver.on('download', d => downloads.push(d)); await link.click();
  await expect(receiver.locator('#save-feedback')).toContainText('已将文件交给系统');
  const result = await receiver.evaluate(async () => { const s = window as any; return { active: s.__shareActive, calls: s.__shares.length, files: await Promise.all(s.__shares[0].map(async (f: File) => ({ name: f.name, type: f.type, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) }))) }; });
  expect(result.active).toEqual([true]); expect(result.calls).toBe(1); expect(result.files).toHaveLength(1); expect(result.files[0].name).toBe(name); expect(result.files[0].type).toBe('image/png');
  expect(digest(Buffer.from(result.files[0].bytes))).toBe(digest(files.find(f => f.name === name)!.buffer)); expect(downloads).toHaveLength(0);
  await expect(receiver.locator('.save-request-state')).toHaveCount(1); await expect(receiver.locator('.save-request-state')).toHaveText('已交给系统，请确认保存结果');
});
test('single-file reception and retained files after a reload both use the system panel', async ({ page, context }) => {
  await setup(context, false); const receiver = await context.newPage(); await receive(page, receiver, 1);
  await expect(receiver.locator('#download-all')).toBeHidden(); const link = receiver.locator('#save-panel .download-file'); await expect(link).not.toHaveAttribute('aria-disabled', 'true'); await link.click();
  await expect(receiver.locator('#status')).toHaveText('已交给系统，请确认保存结果');
  await receiver.goto('./'); const retained = receiver.locator('#stored-files .download-file'); await expect(retained).toHaveCount(1); await expect(retained).not.toHaveAttribute('aria-disabled', 'true'); await retained.click();
  await expect(receiver.locator('#notice')).toHaveText('已将文件交给系统，请确认保存完成后再清理暂存。');
  expect(await receiver.evaluate(() => { const s = window as any; return s.__shares.map((files: File[]) => files.map(f => f.name)); })).toEqual([['原图 1.png']]);
});

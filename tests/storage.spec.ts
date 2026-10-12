import { test, expect, chromium, type BrowserContext, type Page } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function setup(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  });
}
async function begin(sender: Page, receiver: Page, payload: any) {
  await sender.goto('./'); await sender.locator('#file-input').setInputFiles(payload); await sender.locator('#start-send').click();
  await expect(sender.locator('#share-box')).toBeVisible(); await receiver.goto(await sender.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
}
async function completed(receiver: Page) { await expect(receiver.locator('#status')).toHaveText('传输完成，原样送达。'); }
async function downloaded(receiver: Page, index = 0) {
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').nth(index).click();
  return await pending;
}
async function clear(receiver: Page, index = 0) {
  await receiver.locator('.cleanup-stored').nth(index).click(); await expect(receiver.locator('#cleanup-dialog')).toBeVisible();
  await receiver.locator('#confirm-cleanup').click(); await expect(receiver.locator('#cleanup-dialog')).toBeHidden();
}

test('duplicate names, empty and Unicode files survive refresh; confirmed cleanup keeps the downloaded copy', async ({ page, context }, info) => {
  await setup(context); const receiver = await context.newPage();
  const payload = [{ name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('first copy') },
    { name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('second copy') },
    { name: '空文件🍕.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }];
  await begin(page, receiver, payload); await completed(receiver); await receiver.reload();
  await expect(receiver.locator('.download-file')).toHaveCount(3);
  for (const [index, file] of payload.entries()) expect(sha(await readFile((await (await downloaded(receiver, index)).path())!))).toBe(sha(file.buffer));
  const download = await downloaded(receiver), saved = info.outputPath('saved-copy.txt'); await download.saveAs(saved);
  await receiver.locator('.cleanup-stored').first().click(); await receiver.locator('#keep-stored').click();
  await expect(receiver.locator('.download-file')).toHaveCount(3);
  await clear(receiver); await expect(receiver.locator('.download-file')).toHaveCount(2);
  expect((await readFile(saved)).toString()).toBe('first copy');
  await receiver.reload(); await expect(receiver.locator('.download-file')).toHaveCount(2);
  await receiver.goto('about:blank'); await receiver.goBack(); await expect(receiver.locator('.download-file')).toHaveCount(2);
  await receiver.locator('#language-toggle').click(); await expect(receiver.locator('.cleanup-stored').first()).toHaveText('Saved · clear temporary copy');
  await receiver.setViewportSize({ width: 320, height: 844 });
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await receiver.screenshot({ path: info.outputPath('temporary-storage-english-mobile.png'), fullPage: true });
  await clear(receiver); await clear(receiver); await expect(receiver.locator('#stored-panel')).toBeHidden();
});

test('another tab cannot touch an active writer; reopening recovers completed files and removes interrupted leftovers', async ({ page, context }) => {
  await page.goto('./');
  const expected = sha(Buffer.alloc(32768, 19));
  const session = await page.evaluate(async expected => {
    const s = await import('/src/received-storage.ts'); const id = await s.createTemporarySession(65536); if (!id) throw Error('OPFS unavailable');
    await s.beginTemporaryFile(id, { id: 0, name: 'preserved.bin', size: 32768, type: '' });
    await s.writeTemporaryFile(id, 0, new Uint8Array(32768).fill(19).buffer); await s.finishTemporaryFile(id, expected);
    await s.beginTemporaryFile(id, { id: 1, name: 'interrupted.bin', size: 32768, type: '' });
    await s.writeTemporaryFile(id, 0, new Uint8Array(16384).fill(9).buffer); return id;
  }, expected);
  const observer = await context.newPage(); await observer.goto('./'); await expect(observer.locator('#stored-busy')).toBeVisible();
  // A successful second write proves the observer did not delete or unlock the active file.
  await page.evaluate(async id => { const s = await import('/src/received-storage.ts'); await s.writeTemporaryFile(id, 16384, new Uint8Array(8192).fill(9).buffer); }, session);
  await page.close(); await observer.reload(); await expect(observer.locator('.download-file')).toHaveCount(1);
  expect(sha(await readFile((await (await downloaded(observer)).path())!))).toBe(expected);
  const partial = await observer.evaluate(async id => {
    const root = await navigator.storage.getDirectory(), dir = await (await root.getDirectoryHandle('pizzasend-received-v1')).getDirectoryHandle(id);
    try { await dir.getFileHandle('file-1.bin'); return true; } catch { return false; }
  }, session);
  expect(partial).toBe(false); await clear(observer);
});

test('quota refusal can be retried without leaking a session or falsely starting reception', async ({ page, context }) => {
  await setup(context); const receiver = await context.newPage();
  await receiver.route('**/src/storage-worker.ts*', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: 'const estimate = navigator.storage.estimate.bind(navigator.storage); let attempts = 0; navigator.storage.estimate = () => ++attempts === 1 ? Promise.resolve({quota: 1, usage: 1}) : estimate();\n' + await response.text() });
  });
  await begin(page, receiver, { name: 'retry.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1048576, 3) });
  await expect(receiver.locator('#notice')).toContainText('暂存空间不足'); await expect(receiver.locator('#accept-files')).toBeEnabled();
  await expect(receiver.locator('.download-file')).toHaveCount(0);
  await receiver.locator('#accept-files').click(); await completed(receiver); await expect(receiver.locator('#notice')).toBeHidden();
  expect(sha(await readFile((await (await downloaded(receiver)).path())!))).toBe(sha(Buffer.alloc(1048576, 3)));
});

test('disk write failure rejects unsaved bytes and cleans the incomplete temporary file', async ({ page, context }) => {
  await setup(context); const receiver = await context.newPage();
  await receiver.route('**/src/storage-worker.ts*', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: 'const write = FileSystemSyncAccessHandle.prototype.write; FileSystemSyncAccessHandle.prototype.write = function(data, options) { if (data.byteLength === 32768 && options.at === 32768) throw new DOMException("fixture disk full", "QuotaExceededError"); return write.call(this, data, options); };\n' + await response.text() });
  });
  await begin(page, receiver, { name: 'disk-full.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1048576, 8) });
  await expect(receiver.locator('#status')).toHaveText('传输未完成'); await expect(receiver.locator('#notice')).toContainText('暂存空间不足');
  await expect(receiver.locator('.download-file')).toHaveCount(0);
  await expect.poll(() => receiver.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle('pizzasend-received-v1');
    let count = 0; for await (const [, entry] of dir.entries()) if (entry.kind === 'directory') count++; return count;
  })).toBe(0);
});

test('failed integrity of a later file preserves earlier verified temporary downloads', async ({ page, context }) => {
  await setup(context);
  await page.addInitScript(() => {
    let corrupt = false; const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (typeof data === 'string' && data.includes('"type":"file-start"')) corrupt = JSON.parse(data).id === 1;
      if (corrupt && data instanceof ArrayBuffer) { corrupt = false; new Uint8Array(data)[0] ^= 1; }
      return send.call(this, data);
    } as any;
  });
  const receiver = await context.newPage();
  await begin(page, receiver, [{ name: 'good.txt', mimeType: 'text/plain', buffer: Buffer.from('keep this verified file') }, { name: 'bad.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1048576, 3) }]);
  await expect(receiver.locator('#notice')).toContainText('完整性校验失败'); await expect(receiver.locator('.download-file')).toHaveCount(1);
  expect((await readFile((await (await downloaded(receiver)).path())!)).toString()).toBe('keep this verified file');
  await receiver.reload(); await expect(receiver.locator('.download-file')).toHaveCount(1);
});

test('browsers without disk storage retain a bounded memory fallback', async ({ page, context }) => {
  await setup(context); const receiver = await context.newPage();
  await receiver.addInitScript(() => Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined }));
  await receiver.route('**/app.config.json', route => route.fulfill({ json: { memoryLimitBytes: 1048576 } }));
  await begin(page, receiver, { name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1048576) });
  await expect(receiver.locator('#notice')).toContainText('当前接收上限为 1.0 MB'); await expect(receiver.locator('.download-file')).toHaveCount(0);
});

const diskTest = test.extend({ context: async ({}, use, info) => {
  const profile = await mkdtemp(join(tmpdir(), 'pizza-send-opfs-profile-'));
  const context = await chromium.launchPersistentContext(profile, { ...info.project.use.launchOptions, headless: true, baseURL: info.project.use.baseURL, acceptDownloads: true });
  try { await use(context); } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
} });
diskTest('512 MiB receives through the production worker without a picker or full-file memory conversion', async ({ page, context }) => {
  test.setTimeout(360000); await setup(context);
  const dir = await mkdtemp(join(tmpdir(), 'pizza-send-opfs-fixture-')), path = join(dir, '512MiB.bin');
  const block = Buffer.alloc(1048576); for (let i = 0; i < block.length; i++) block[i] = i % 251;
  const expected = createHash('sha256'), fixture = await open(path, 'w');
  try { for (let i = 0; i < 512; i++) { await fixture.write(block); expected.update(block); } } finally { await fixture.close(); }
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function() { if (this.size > 1048576) throw Error('Full-file memory conversion is forbidden in this test'); return read.call(this); };
  });
  try {
    await begin(page, receiver, path);
    await expect(receiver.locator('#status')).toHaveText('传输完成，原样送达。', { timeout: 300000 });
    const download = await downloaded(receiver), file = (await download.path())!, actual = createHash('sha256');
    for await (const chunk of createReadStream(file)) actual.update(chunk);
    expect(actual.digest('hex')).toBe(expected.digest('hex'));
    await clear(receiver); await expect(receiver.locator('#stored-panel')).toBeHidden();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

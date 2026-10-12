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
async function clear(receiver: Page) {
  await receiver.locator('#clear-stored').click(); await expect(receiver.locator('#cleanup-dialog')).toBeVisible();
  await receiver.locator('#confirm-cleanup').click(); await expect(receiver.locator('#cleanup-dialog')).toBeHidden();
}

test('duplicate names, empty and Unicode files survive refresh; one cleanup button clears all and keeps the downloaded copy', async ({ page, context }, info) => {
  await setup(context); const receiver = await context.newPage();
  const payload = [{ name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('first copy') },
    { name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('second copy') },
    { name: '空文件🍕.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }];
  await begin(page, receiver, payload); await completed(receiver); await receiver.reload();
  await expect(receiver.locator('.download-file')).toHaveCount(3);
  for (const [index, file] of [...payload].reverse().entries()) expect(sha(await readFile((await (await downloaded(receiver, index)).path())!))).toBe(sha(file.buffer));
  const download = await downloaded(receiver, 2), saved = info.outputPath('saved-copy.txt'); await download.saveAs(saved);
  await expect(receiver.locator('.cleanup-stored')).toHaveCount(1);
  await receiver.locator('#clear-stored').click(); await expect(receiver.locator('#cleanup-name')).toContainText('3 个文件');
  await receiver.locator('#keep-stored').click();
  await expect(receiver.locator('.download-file')).toHaveCount(3);
  await receiver.reload(); await expect(receiver.locator('.download-file')).toHaveCount(3);
  await receiver.goto('about:blank'); await receiver.goBack(); await expect(receiver.locator('.download-file')).toHaveCount(3);
  await receiver.locator('#language-toggle').click(); await expect(receiver.locator('#clear-stored')).toHaveText('Saved · clear all temporary files');
  await receiver.setViewportSize({ width: 320, height: 844 });
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await receiver.screenshot({ path: info.outputPath('temporary-storage-english-mobile.png'), fullPage: true });
  await clear(receiver); await expect(receiver.locator('#stored-panel')).toBeHidden();
  await expect(receiver.locator('.download-file')).toHaveCount(0);
  expect((await readFile(saved)).toString()).toBe('first copy');
  await receiver.reload(); await expect(receiver.locator('#stored-panel')).toBeHidden();
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

test('bulk cleanup spans completed sessions and leaves an unfinished writer usable', async ({ page }) => {
  await page.goto('./');
  const active = await page.evaluate(async () => {
    // Reuse the page's module, including Vite's development update query, so
    // this fixture and the UI share the same worker and session locks.
    const url = (performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/received-storage.ts')!).name;
    const s = await import(url);
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const hash = (data: Uint8Array) => Array.from(sha256(data), b => b.toString(16).padStart(2, '0')).join('');
    for (let index = 0; index < 2; index++) {
      const id = (await s.createTemporarySession(4))!;
      await s.beginTemporaryFile(id, { id: 0, name: 'batch-' + index + '.bin', size: 4, type: '' });
      const data = new Uint8Array(4).fill(index);
      await s.writeTemporaryFile(id, 0, data.slice().buffer); await s.finishTemporaryFile(id, hash(data));
      await s.completeTemporarySession(id);
    }
    const id = (await s.createTemporarySession(32768))!;
    await s.beginTemporaryFile(id, { id: 0, name: 'still-receiving.bin', size: 32768, type: '' });
    await s.writeTemporaryFile(id, 0, new Uint8Array(16384).fill(7).buffer);
    return { id, url };
  });
  await expect(page.locator('.download-file')).toHaveCount(2);
  await expect(page.locator('.cleanup-stored')).toHaveCount(1);
  await clear(page); await expect(page.locator('.download-file')).toHaveCount(0);
  await page.evaluate(async ({ id, url }) => {
    const s = await import(url);
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    await s.writeTemporaryFile(id, 16384, new Uint8Array(16384).fill(7).buffer);
    const hash = Array.from(sha256(new Uint8Array(32768).fill(7)), b => b.toString(16).padStart(2, '0')).join('');
    await s.finishTemporaryFile(id, hash); await s.completeTemporarySession(id);
  }, active);
  await expect(page.locator('.download-file')).toHaveCount(1);
  expect(sha(await readFile((await (await downloaded(page)).path())!))).toBe(sha(Buffer.alloc(32768, 7)));
  await clear(page); await expect(page.locator('#stored-panel')).toBeHidden();
});

test('partly failed bulk cleanup retries remaining files without touching the downloaded copy', async ({ page, context }, info) => {
  await setup(context); const receiver = await context.newPage();
  await receiver.route('**/src/storage-worker.ts*', async route => {
    const response = await route.fetch();
    const body = 'const remove = FileSystemDirectoryHandle.prototype.removeEntry; let failed = false; FileSystemDirectoryHandle.prototype.removeEntry = function(name, options) { if (name === "file-1.bin" && !failed) { failed = true; throw new DOMException("fixture deletion failed", "NoModificationAllowedError"); } return remove.call(this, name, options); };\n' + await response.text();
    await route.fulfill({ response, body });
  });
  await begin(page, receiver, [0, 1, 2].map(index => ({ name: 'file-' + index + '.txt', mimeType: 'text/plain', buffer: Buffer.from('file ' + index) })));
  await completed(receiver); await expect(receiver.locator('.download-file')).toHaveCount(3);
  const download = await downloaded(receiver, 2), saved = info.outputPath('saved-copy.txt'); await download.saveAs(saved);
  await receiver.locator('#clear-stored').click(); await receiver.locator('#confirm-cleanup').click();
  await expect(receiver.locator('#cleanup-error')).toBeVisible();
  await expect(receiver.locator('#cleanup-name')).toContainText('2 个文件');
  await expect(receiver.locator('.download-file')).toHaveCount(2);
  await receiver.locator('#confirm-cleanup').click(); await expect(receiver.locator('#cleanup-dialog')).toBeHidden();
  await expect(receiver.locator('#stored-panel')).toBeHidden();
  expect((await readFile(saved)).toString()).toBe('file 0');
  await receiver.reload(); await expect(receiver.locator('.download-file')).toHaveCount(0);
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

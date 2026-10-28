import { isolateLocalRequests, test as base, expect, type Page } from '../fixtures';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// WebKit's ephemeral automation contexts reject OPFS getDirectory(). Use a
// disposable persistent profile to exercise actual disk writes in this engine.
const test = base.extend({
  context: async ({ context, browserName, playwright }, use, info) => {
    if (browserName !== 'webkit') { await use(context); return; }
    const profile = await mkdtemp(join(tmpdir(), 'pizza-archive-webkit-'));
    const persistent = await playwright.webkit.launchPersistentContext(profile, { baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173', locale: 'zh-CN', acceptDownloads: true });
    try { await isolateLocalRequests(persistent, info.testId); await use(persistent); } finally { await persistent.close(); await rm(profile, { recursive: true, force: true }); }
  }
});

type Entry = { path: string; text?: string; size?: number };
async function drop(page: Page, roots: { name: string; entries: Entry[] }[], plain = false) {
  await page.evaluate(({ roots, plain }) => {
    function directory(name: string, entries: Entry[], parent = ''): any {
      const prefix = parent + name + '/';
      const children = entries.filter(entry => entry.path.startsWith(prefix) && entry.path !== prefix && !entry.path.slice(prefix.length).replace(/\/$/, '').includes('/')).map(entry => {
        const child = entry.path.slice(prefix.length).replace(/\/$/, '');
        if (entry.path.endsWith('/')) return directory(child, entries, prefix);
        const file = new File([entry.size ? new Uint8Array(entry.size) : entry.text || ''], child, { type: 'text/plain', lastModified: 1700000000000 });
        return { name: child, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(file) };
      });
      let batch = 0;
      return { name, isFile: false, isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(batch++ ? [] : children) }) };
    }
    const items = roots.map(root => ({ kind: 'file', webkitGetAsEntry: () => directory(root.name, root.entries), getAsFile: () => null }));
    const file = new File(['standalone'], '单独的文件.txt', { type: 'text/plain' });
    const nativeEntries: any[] = items;
    if (plain) nativeEntries.push({ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file });
    const dataTransfer = new DataTransfer();
    if (plain) dataTransfer.items.add(file);
    Object.defineProperty(dataTransfer, 'items', { value: nativeEntries });
    document.getElementById('drop-zone')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, { roots, plain });
}
async function archiveBatches(page: Page) {
  return page.evaluate(async () => {
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('pizzasend-source-archives-v1');
      const entries: string[] = [];
      for await (const name of root.keys()) entries.push(name);
      return entries;
    } catch { return []; }
  });
}
const folder = { name: '番茄炒鸡蛋', entries: [
  { path: '番茄炒鸡蛋/番茄.txt', text: '番茄🍅\n' }, { path: '番茄炒鸡蛋/鸡蛋.txt', text: '鸡蛋🥚\n' },
  { path: '番茄炒鸡蛋/配料/' }, { path: '番茄炒鸡蛋/配料/番茄.txt', text: '同名不同内容' }, { path: '番茄炒鸡蛋/空文件夹/' }
] };

test('dropped folders become separate STORE ZIPs; receiving and extracting preserves roots, nesting, empty folders and hashes', async ({ page, context, browserName }) => {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  });
  await page.goto('./');
  await drop(page, [folder, { name: '另一个空目录', entries: [] }], true);
  await expect(page.locator('#files .file-row')).toHaveCount(3);
  await expect(page.locator('#files strong')).toHaveText(['番茄炒鸡蛋.zip', '另一个空目录.zip', '单独的文件.txt']);
  await expect(page.locator('#start-send')).toBeEnabled();
  await expect(page.locator('#archive-progress')).toBeHidden();
  expect(await archiveBatches(page)).toHaveLength(1);
  // Another visit must not clean up an actively selected archive in this tab.
  const observer = await context.newPage(); await observer.goto('./');
  await observer.evaluate(() => import('/src/folder-archive.ts').then(module => module.cleanupSourceArchives()));
  expect(await archiveBatches(page)).toHaveLength(1); await observer.close();
  if (browserName === 'webkit') {
    // Exercise the real disk-backed archive in this engine without relying on
    // the headless WebKit implementation's unreliable multi-peer loopback ICE.
    const data = await page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('pizzasend-source-archives-v1');
      const id = (await root.keys().next()).value!;
      const file = await (await (await root.getDirectoryHandle(id)).getFileHandle('0.zip')).getFile();
      const { ZipReader, BlobReader, TextWriter } = await import('/node_modules/@zip.js/zip.js/lib/zip-core-custom.js');
      const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
      const result = [];
      for (const entry of await reader.getEntries()) result.push({ name: entry.filename, text: entry.directory ? null : await entry.getData!(new TextWriter()) });
      await reader.close(); return result;
    });
    expect(data.map(entry => entry.name)).toEqual(['番茄炒鸡蛋/', ...folder.entries.map(entry => entry.path)]);
    expect(data.find(entry => entry.name === '番茄炒鸡蛋/配料/番茄.txt')!.text).toBe('同名不同内容');
  } else {
    await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
    const receiver = await context.newPage(); await receiver.goto(await page.locator('#share-link').inputValue()); await receiver.locator('#accept-files').click();
    await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
    const names: string[] = [];
    for (const button of await receiver.locator('.download-file').all()) {
      const downloading = receiver.waitForEvent('download'); await button.click(); const download = await downloading;
      names.push(download.suggestedFilename()); const path = (await download.path())!;
      if (download.suggestedFilename() === '单独的文件.txt') { expect((await readFile(path)).toString()).toBe('standalone'); continue; }
      // Python's standard ZIP implementation is independent of the writer.
      const entries = JSON.parse(execFileSync('python3', ['-c', 'import zipfile,json,hashlib,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps([{ "name":i.filename,"method":i.compress_type,"sha":hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]))', path], { encoding: 'utf8' }));
      const expected = download.suggestedFilename() === '番茄炒鸡蛋.zip' ? ['番茄炒鸡蛋/', ...folder.entries.map(entry => entry.path)] : ['另一个空目录/'];
      expect(entries.map((entry: any) => entry.name)).toEqual(expected);
      for (const entry of entries) {
        expect(entry.method).toBe(0);
        const original = folder.entries.find(original => original.path === entry.name)?.text || '';
        expect(entry.sha).toBe(createHash('sha256').update(original).digest('hex'));
      }
    }
    expect(names.sort()).toEqual(['番茄炒鸡蛋.zip', '另一个空目录.zip', '单独的文件.txt'].sort());
    await page.locator('#cancel').click();
  }
  await page.locator('#clear-files').click();
  await expect(page.locator('#files .file-row')).toHaveCount(0);
  await expect(page.locator('#start-send')).toBeDisabled();
  await expect.poll(() => archiveBatches(page)).toHaveLength(0);
});

test('cancelling a later archive batch preserves existing selections and releases partial storage', async ({ page }) => {
  await page.goto('./'); await drop(page, [folder]); await expect(page.locator('#files strong')).toHaveText('番茄炒鸡蛋.zip');
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  await page.route('**/folder-archive-worker.ts*', async route => { await gate; await route.continue(); });
  try {
    await drop(page, [{ name: '取消这个', entries: [{ path: '取消这个/large.bin', size: 4 * 1048576 }] }]);
    await expect(page.locator('#cancel-packaging')).toBeVisible(); await expect(page.locator('#start-send')).toBeDisabled();
    await page.locator('#cancel-packaging').click();
    await expect(page.locator('#cancel-packaging')).toBeHidden(); await expect(page.locator('#start-send')).toBeEnabled();
    await expect(page.locator('#files strong')).toHaveText('番茄炒鸡蛋.zip'); expect(await archiveBatches(page)).toHaveLength(1);
  } finally { release(); }
  await page.locator('.remove-file').click(); await expect.poll(() => archiveBatches(page)).toHaveLength(0);
});

test('unsupported folder storage fails clearly without flattening folders or losing existing files', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined }));
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('keep') });
  await drop(page, [folder]);
  await expect(page.locator('#notice')).toContainText('请先在系统中压缩文件夹');
  await expect(page.locator('#files strong')).toHaveText('keep.txt'); await expect(page.locator('#start-send')).toBeEnabled();
});

test('abandoned sender archives are cleaned on the next visit', async ({ page, context }) => {
  await page.goto('./'); await drop(page, [folder]); await expect(page.locator('#files strong')).toHaveText('番茄炒鸡蛋.zip');
  expect(await archiveBatches(page)).toHaveLength(1); await page.close();
  const next = await context.newPage(); await next.goto('./');
  await expect.poll(() => archiveBatches(next)).toHaveLength(0);
});

test('clearing all files also cancels pending packaging without reviving the old selection', async ({ page }) => {
  await page.goto('./'); await drop(page, [folder]); await expect(page.locator('#files strong')).toHaveText('番茄炒鸡蛋.zip');
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
  await page.route('**/folder-archive-worker.ts*', async route => { await gate; await route.continue(); });
  try {
    await drop(page, [{ name: '后来的文件夹', entries: [] }]);
    await expect(page.locator('#cancel-packaging')).toBeVisible(); await page.locator('#clear-files').click();
    await expect(page.locator('#cancel-packaging')).toBeHidden(); await expect(page.locator('#files .file-row')).toHaveCount(0);
    await expect(page.locator('#start-send')).toBeDisabled(); await expect.poll(() => archiveBatches(page)).toHaveLength(0);
  } finally { release(); }
});

test('ZIP64 directory offsets are not truncated beyond 4 GiB', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { ZipWriter, ZipReader, Uint8ArrayReader, configure } = await import('/node_modules/@zip.js/zip.js/lib/zip-core-custom.js');
    configure({ useWebWorkers: false });
    const chunks: Uint8Array[] = [];
    // Start after 4 GiB without allocating that prefix: validate the writer's
    // 64-bit directory records independently of physical storage capacity.
    const writer = new ZipWriter({ size: 4294967300, writable: new WritableStream({ write(chunk) { chunks.push(chunk); } }) }, { level: 0 });
    await writer.add('番茄炒鸡蛋/', undefined, { directory: true }); await writer.close();
    const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
    const entries = await reader.getEntries(); await reader.close();
    // Readers normalize a missing self-extracting prefix. Inspect the stored
    // ZIP64 field itself to verify the original absolute offset was preserved.
    const view = new DataView(bytes.buffer);
    let offset = 0;
    for (let index = 0; index + 46 <= bytes.length; index++) if (view.getUint32(index, true) === 0x02014b50) {
      const extra = index + 46 + view.getUint16(index + 28, true);
      for (let at = extra; at < extra + view.getUint16(index + 30, true); at += 4 + view.getUint16(at + 2, true)) if (view.getUint16(at, true) === 1) {
        let field = at + 4;
        if (view.getUint32(index + 24, true) === 0xffffffff) field += 8;
        if (view.getUint32(index + 20, true) === 0xffffffff) field += 8;
        if (view.getUint32(index + 42, true) === 0xffffffff) offset = Number(view.getBigUint64(field, true));
      }
    }
    return { zip64: entries[0].zip64, offset };
  });
  expect(result.zip64).toBe(true); expect(result.offset).toBeGreaterThan(4294967295);
});

test('real archive worker reads and writes an 8 MiB source in bounded chunks', async ({ page }) => {
  await page.route('**/folder-archive-worker.ts*', async route => {
    const response = await route.fetch();
    const instrumentation = `
      let maxRead = 0, readBytes = 0, maxWrite = 0;
      const read = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function() { maxRead = Math.max(maxRead, this.size); readBytes += this.size; return read.call(this); };
      const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
      FileSystemFileHandle.prototype.createSyncAccessHandle = async function() {
        const handle = await open.call(this);
        return { write(bytes, options) { maxWrite = Math.max(maxWrite, bytes.length); return handle.write(bytes, options); }, flush() { handle.flush(); }, close() { handle.close(); } };
      };
      const post = globalThis.postMessage.bind(globalThis);
      globalThis.postMessage = data => { if (data.type === 'done') Object.assign(data, { maxRead, readBytes, maxWrite }); post(data); };
    `;
    await route.fulfill({ response, body: instrumentation + await response.text() });
  });
  await page.goto('./');
  const result = await page.evaluate(() => new Promise<any>((resolve, reject) => {
    const worker = new Worker('/src/folder-archive-worker.ts', { type: 'module' });
    let result: any;
    worker.onerror = error => { worker.terminate(); reject(Error(error.message)); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'error') { worker.terminate(); reject(Error('Archive failed: ' + data.reason)); }
      if (data.type === 'done') { result = { maxRead: data.maxRead, readBytes: data.readBytes, maxWrite: data.maxWrite, size: data.files[0].size }; worker.postMessage({ type: 'release', index: 0 }); }
      if (data.type === 'released') { worker.terminate(); resolve(result); }
    };
    worker.postMessage({ type: 'pack', id: crypto.randomUUID(), folders: [{ kind: 'folder', name: '大文件夹', entries: [
      { path: '大文件夹/' }, { path: '大文件夹/电影.bin', file: new File([new Uint8Array(8 * 1048576)], '电影.bin') }
    ] }] });
  }));
  expect(result.readBytes).toBe(8 * 1048576); expect(result.maxRead).toBeGreaterThan(0);
  expect(result.maxRead).toBeLessThanOrEqual(262144); expect(result.maxWrite).toBeLessThanOrEqual(262144);
  expect(result.size).toBeGreaterThan(8 * 1048576); await expect.poll(() => archiveBatches(page)).toHaveLength(0);
});

test('insufficient archive quota fails before sending and removes the partial batch', async ({ page }) => {
  await page.route('**/folder-archive-worker.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `Object.defineProperty(navigator.storage, 'estimate', { value: async () => ({ quota: 1, usage: 0 }) });\n` + await response.text() });
  });
  await page.goto('./'); await drop(page, [folder]);
  await expect(page.locator('#notice')).toContainText('本机空间不足');
  await expect(page.locator('#files .file-row')).toHaveCount(0); await expect(page.locator('#start-send')).toBeDisabled();
  await expect.poll(() => archiveBatches(page)).toHaveLength(0);
});

test('a browser exposing OPFS but denying access gives the manual-ZIP fallback', async ({ page }) => {
  await page.route('**/folder-archive-worker.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `Object.defineProperty(navigator.storage, 'getDirectory', { value: async () => { throw new DOMException('Storage blocked', 'UnknownError'); } });\n` + await response.text() });
  });
  await page.goto('./'); await drop(page, [folder]);
  await expect(page.locator('#notice')).toContainText('请先在系统中压缩文件夹');
  await expect(page.locator('#files .file-row')).toHaveCount(0); await expect(page.locator('#cancel-packaging')).toBeHidden();
});

test('unsafe archive paths and conflicting names are rejected without publishing a partial archive', async ({ page }) => {
  await page.goto('./');
  const failures = await page.evaluate(async () => {
    const { packageSources } = await import('/src/folder-archive.ts');
    const cases = ['../escape.txt', 'root/../escape.txt', 'root/dir\\escape.txt', 'C:/escape.txt', 'root/stream:content.txt', 'root/duplicate.txt'];
    const rejected: boolean[] = [];
    for (const path of cases) {
      const entries = [{ path: 'root/' }, { path, file: new File(['first'], 'first.txt') }];
      if (path === 'root/duplicate.txt') entries.push({ path, file: new File(['second'], 'second.txt') });
      try { await packageSources([{ kind: 'folder', name: 'root', entries }], () => {}); rejected.push(false); }
      catch { rejected.push(true); }
    }
    return rejected;
  });
  expect(failures).toEqual(Array(6).fill(true)); await expect.poll(() => archiveBatches(page)).toHaveLength(0);
});

test('cancel while a native directory read is pending releases the picker and ignores the late callback', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    const folder = { name: 'slow-folder', isDirectory: true, isFile: false, createReader: () => ({ readEntries(resolve: (entries: any[]) => void) { (window as any).__finishDirectory = resolve; } }) };
    Object.defineProperty(dataTransfer, 'items', { value: [{ kind: 'file', webkitGetAsEntry: () => folder }] });
    document.getElementById('drop-zone')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishDirectory)).toBe('function');
  await page.locator('#cancel-packaging').click();
  await expect(page.locator('#drop-zone')).toBeEnabled({ timeout: 2000 });
  await expect(page.locator('#archive-progress')).toBeHidden();
  await page.evaluate(() => {
    (window as any).__finishDirectory([{ name: 'late.txt', isFile: true, file() { (window as any).__lateFileRead = true; } }]);
  });
  await page.locator('#file-input').setInputFiles({ name: 'fresh.txt', mimeType: 'text/plain', buffer: Buffer.from('fresh selection') });
  await expect(page.locator('#files strong')).toHaveText('fresh.txt');
  expect(await page.evaluate(() => !!(window as any).__lateFileRead)).toBe(false);
  expect(await archiveBatches(page)).toHaveLength(0);
});

for (const name of ['n'.repeat(255), '猫'.repeat(85)]) test(`long folder names produce a portable ZIP download name while preserving the original root (${name[0]})`, async ({ page }) => {
  await page.goto('./');
  await drop(page, [{ name, entries: [{ path: name + '/original.txt', text: 'original contents' }] }]);
  await expect(page.locator('#files .file-row')).toHaveCount(1, { timeout: 3000 });
  const exported = await page.locator('#files strong').textContent();
  expect(exported).toMatch(/\.zip$/); expect(new TextEncoder().encode(exported!).length).toBeLessThanOrEqual(240);
  const names = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('pizzasend-source-archives-v1');
    const id = (await root.keys().next()).value!;
    const file = await (await (await root.getDirectoryHandle(id)).getFileHandle('0.zip')).getFile();
    const { ZipReader, BlobReader } = await import('/node_modules/@zip.js/zip.js/lib/zip-core-custom.js');
    const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
    try { return (await reader.getEntries()).map(entry => entry.filename); } finally { await reader.close(); }
  });
  expect(names).toEqual([name + '/', name + '/original.txt']);
  await page.locator('#clear-files').click(); await expect.poll(() => archiveBatches(page)).toHaveLength(0);
});

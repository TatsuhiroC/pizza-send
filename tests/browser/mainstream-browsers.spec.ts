import { isolateLocalRequests, test as base, expect } from '../fixtures';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Historical Safari behavior is simulated explicitly; this is not an old
// Safari binary. Persistent WebKit profiles allow real OPFS writes underneath.
const test = base.extend({ context: async ({ context, browserName, playwright }, use, info) => {
  if (browserName !== 'webkit') { await use(context); return; }
  const profile = await mkdtemp(join(tmpdir(), 'pizzasend-mainstream-'));
  const persistent = await playwright.webkit.launchPersistentContext(profile, {
    baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173', locale: 'zh-CN', acceptDownloads: true
  });
  try { await isolateLocalRequests(persistent, info.testId); await use(persistent); } finally { await persistent.close(); await rm(profile, { recursive: true, force: true }); }
} });
test.beforeEach(async ({ context }) => {
  await context.route('**/app.config.json', route => route.fulfill({ json: { signalUrl: '', iceServers: [], memoryLimitBytes: 268435456 } }));
});

const oldSafariStorage = `
Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: undefined });
const proto = FileSystemSyncAccessHandle.prototype;
for (const name of ['flush', 'getSize', 'truncate', 'close']) {
  const native = proto[name];
  proto[name] = async function(...args) {
    await new Promise(resolve => setTimeout(resolve, 8));
    return native.apply(this, args);
  };
}
`;

test('Safari-style asynchronous storage controls and missing quota estimates preserve verified files across reopen', async ({ page }) => {
  await page.route('**/src/storage-worker.ts*', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: oldSafariStorage + await response.text() });
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const s = await import('/src/received-storage.ts');
    const bytes = new Uint8Array(3 * 1048576 + 17).map((_, i) => i % 251);
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    const session = await s.createTemporarySession(bytes.length);
    if (!session) throw Error('OPFS probe rejected older asynchronous controls');
    await s.beginTemporaryFile(session, { id: 0, name: '完整名称🍕.mp4', size: bytes.length, type: 'video/mp4' });
    for (let at = 0; at < bytes.length; at += 65536) await s.writeTemporaryFile(session, at, bytes.slice(at, at + 65536).buffer);
    await s.finishTemporaryFile(session, expected); await s.completeTemporarySession(session);
    // Also discard a partially written file: close must finish before deletion.
    const partial = (await s.createTemporarySession(8))!;
    await s.beginTemporaryFile(partial, { id: 0, name: 'partial', size: 8, type: '' });
    await s.writeTemporaryFile(partial, 0, new Uint8Array(4).buffer); await s.discardTemporaryPartial(partial);
    s.suspendTemporaryStorage();
    const files = await s.listTemporaryFiles();
    const file = files.find(file => file.session === session)!;
    const downloaded = await (await fetch(await s.temporaryURL(file))).arrayBuffer();
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', downloaded)), b => b.toString(16).padStart(2, '0')).join('');
    await s.deleteTemporaryFile(file);
    return { expected, actual, size: downloaded.byteLength, name: file.info.name, remaining: (await s.listTemporaryFiles()).length };
  });
  expect(result.actual).toBe(result.expected); expect(result.size).toBe(3 * 1048576 + 17);
  expect(result.name).toBe('完整名称🍕.mp4'); expect(result.remaining).toBe(0); expect(errors).toEqual([]);
});

test('folder archive closes asynchronous handles before delivering the complete snapshot', async ({ page }) => {
  await page.route('**/src/folder-archive-worker.ts*', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: oldSafariStorage + await response.text() });
  });
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { packageSources, stopSourceArchives } = await import('/src/folder-archive.ts');
    const [archive] = await packageSources([{ kind: 'folder', name: 'dinner', entries: [
      { path: 'dinner/' }, { path: 'dinner/tomato.txt', file: new File(['tomato'], 'tomato.txt') }, { path: 'dinner/empty/' }
    ] }], () => {});
    const data = btoa(String.fromCharCode(...new Uint8Array(await archive.arrayBuffer())));
    stopSourceArchives(); return { name: archive.name, data };
  });
  expect(result.name).toBe('dinner.zip');
  const unpacked = JSON.parse(execFileSync('python3', ['-c',
    'import zipfile,io,base64,json,sys\nz=zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.argv[1])))\nassert z.testzip() is None\nprint(json.dumps({"names":z.namelist(),"text":z.read("dinner/tomato.txt").decode()}))', result.data], { encoding: 'utf8' }));
  expect(unpacked).toEqual({ names: ['dinner/', 'dinner/tomato.txt', 'dinner/empty/'], text: 'tomato' });
});

for (const mode of ['timeout', 'messageerror'] as const) test(`storage detection ${mode} falls back without hanging reception`, async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(mode => {
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('storage-worker')) {
          this.postMessage = (() => {
            (window as any).__probeStarted = true;
            if (mode === 'messageerror') queueMicrotask(() => this.dispatchEvent(new MessageEvent('messageerror')));
          }) as typeof this.postMessage;
          const terminate = this.terminate.bind(this);
          this.terminate = () => { (window as any).__storageTerminated = true; terminate(); };
        }
      }
    };
  }, mode);
  await page.goto('./');
  await expect(page.locator('#file-input')).toBeAttached();
  await page.evaluate(() => { (window as any).__probe = import('/src/received-storage.ts').then(s => s.createTemporarySession(10)); });
  await expect.poll(() => page.evaluate(() => (window as any).__probeStarted === true)).toBe(true);
  if (mode === 'timeout') await page.clock.runFor(8100);
  expect(await page.evaluate(() => (window as any).__probe)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__storageTerminated)).toBe(true);
  await page.locator('#file-input').setInputFiles({ name: 'still-usable.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(page.locator('#start-send')).toBeEnabled();
});

for (const copied of [false, true]) test(`denied clipboard access offers a usable copy fallback; legacy copy ${copied}`, async ({ page }) => {
  await page.addInitScript(copied => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = () => copied;
  }, copied);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.evaluate(() => {
    document.getElementById('session-panel')!.hidden = false;
    document.getElementById('share-box')!.hidden = false;
    (document.getElementById('share-link') as HTMLInputElement).value = 'https://example.invalid/generated-invitation';
  });
  await page.locator('#copy-link').click();
  await expect(page.locator('#toast')).toHaveText(copied ? '分享链接已复制' : '无法自动复制，请长按或选中链接后复制。');
  if (!copied) expect(await page.locator('#share-link').evaluate(input => {
    const field = input as HTMLInputElement; return field.selectionEnd! - field.selectionStart!;
  })).toBe('https://example.invalid/generated-invitation'.length);
  expect(errors).toEqual([]);
});

test('a broken storage snapshot is rejected at detection instead of presenting unusable downloads', async ({ page }) => {
  await page.route('**/src/storage-worker.ts*', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: 'FileSystemFileHandle.prototype.getFile = async () => new File([], "broken");\n' + await response.text() });
  });
  await page.goto('./');
  expect(await page.evaluate(() => import('/src/received-storage.ts').then(s => s.createTemporarySession(4)))).toBeUndefined();
});

test('optional viewport observers and failed SVG animations cannot disable file selection', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: undefined });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    SVGElement.prototype.animate = () => { throw new DOMException('Unsupported SVG animation', 'NotSupportedError'); };
  });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'select-me.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(page.locator('#files')).toContainText('select-me.txt'); await expect(page.locator('#start-send')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('missing manual compression gives a useful error while automatic-link capabilities remain available', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'CompressionStream', { configurable: true, value: undefined });
    Object.defineProperty(window, 'DecompressionStream', { configurable: true, value: undefined });
  });
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const p = await import('/src/protocol.ts');
    try { await p.packDescription({ type: 'offer', sdp: 'v=0\r\n' }); return ''; }
    catch (error) { return (error as Error).message; }
  });
  expect(result).toContain('请使用分享链接');
  await expect(page.locator('#start-send')).toBeDisabled();
  await page.locator('#file-input').setInputFiles({ name: 'still-selectable.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(page.locator('#start-send')).toBeEnabled();
});

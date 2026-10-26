import { test as base, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// WebKit's private contexts reject OPFS. Use a disposable, test-owned disk
// profile just as the existing real storage coverage does.
const test = base.extend({ context: async ({ context, browserName, playwright }, use) => {
  if (browserName !== 'webkit') { await use(context); return; }
  const profile = await mkdtemp(join(tmpdir(), 'pizzasend-site-webkit-'));
  const persistent = await playwright.webkit.launchPersistentContext(profile, { baseURL: 'http://127.0.0.1:4175', locale: 'zh-CN' });
  try { await use(persistent); } finally { await persistent.close(); await rm(profile, { recursive: true, force: true }); }
} });

test.beforeEach(async ({ context }) => {
  await context.route('**/app.config.json', route => route.fulfill({ json: { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 } }));
});

test('stable root and test path load distinct bundles with a translated compact test banner', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.locator('#send-tab')).toBeVisible();
  await expect(page.locator('.test-banner')).toHaveCount(0);
  const stableScript = await page.locator('script[src]').first().getAttribute('src');
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/test/'); await expect(page.locator('.test-banner')).toContainText('测试版');
  expect(await page.locator('script[src]').first().getAttribute('src')).not.toBe(stableScript);
  await expect(page.locator('.test-banner a')).toHaveAttribute('href', '/');
  await page.locator('#language-toggle').click();
  await expect(page.locator('.test-banner')).toContainText('Test');
  await expect(page.locator('.test-banner a')).toHaveText('Open stable version');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#file-input').setInputFiles({ name: 'generated-selection.txt', mimeType: 'text/plain', buffer: Buffer.from('test only') });
  await expect(page.locator('#files')).toContainText('generated-selection.txt');
  expect(errors).toEqual([]);
  const manifest = JSON.parse(readFileSync('dist/test/release.json', 'utf8'));
  expect(manifest.productionRevision).toBe(JSON.parse(readFileSync('deployment/production.json', 'utf8')).revision);
  expect(readFileSync('dist/_headers', 'utf8')).toContain('/test/*\n  Cache-Control: no-store\n  X-Robots-Tag: noindex, nofollow');
});

test('test preferences cannot change stable language or connection settings', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { localStorage.setItem('pizza-send-language', 'en'); localStorage.setItem('pizza-send-signal', 'https://stable-preference.invalid'); });
  await page.goto('/test/');
  await expect(page.locator('#send-tab')).toContainText('发送文件');
  expect(await page.locator('#signal-url').inputValue()).toBe('');
  await page.locator('#language-toggle').click();
  expect(await page.evaluate(() => ({ stable: localStorage.getItem('pizza-send-language'), test: localStorage.getItem('pizzasend-test:pizza-send-language') }))).toEqual({ stable: 'en', test: 'en' });
  await page.goto('/'); await expect(page.locator('#send-tab')).toContainText('Send files');
  expect(await page.locator('#signal-url').inputValue()).toBe('https://stable-preference.invalid');
});

test('test storage worker and cleanup touch only test files', async ({ page }) => {
  await page.goto('/test/');
  const stableWorker = readdirSync('dist/assets').find(name => name.startsWith('storage-worker-'))!;
  const testWorker = readdirSync('dist/test/assets').find(name => name.startsWith('storage-worker-'))!;
  const sessions = await page.evaluate(async ({ stableWorker, testWorker }) => {
    const seed = async (url: string, name: string) => {
      const worker = new Worker(url, { type: 'module' }); let id = 0;
      const tasks = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
      worker.onmessage = ({ data }) => { const task = tasks.get(data.id)!; tasks.delete(data.id); data.ok ? task.resolve(data.data) : task.reject(Error(data.error.name + ': ' + data.error.message)); };
      const request = (type: string, data?: unknown) => new Promise<any>((resolve, reject) => { const current = ++id; tasks.set(current, { resolve, reject }); worker.postMessage({ id: current, type, data }); });
      try {
        await request('probe').catch(error => { throw Error(url + ' probe: ' + error.message); }); const session = await request('create', { total: 4 });
        await request('begin', { session, info: { id: 0, name, size: 4, type: 'text/plain' } });
        const buffer = new TextEncoder().encode('test').buffer;
        await request('write', { session, offset: 0, buffer });
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
        await request('finish', { session, hash }); await request('complete', { session }); return session;
      } finally { worker.terminate(); }
    };
    return { stable: await seed('/assets/' + stableWorker, 'stable-only.txt'), test: await seed('/test/assets/' + testWorker, 'test-only.txt') };
  }, { stableWorker, testWorker });
  await page.reload(); await expect(page.locator('#stored-files')).toContainText('test-only.txt');
  await expect(page.locator('#stored-files')).not.toContainText('stable-only.txt');
  await page.locator('#clear-stored').click(); await page.locator('#confirm-cleanup').click();
  await expect(page.locator('#stored-panel')).toBeHidden();
  expect(await page.evaluate(async session => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('pizzasend-received-v1')).getDirectoryHandle(session);
    return await (await (await dir.getFileHandle('file-0.bin')).getFile()).text();
  }, sessions.stable)).toBe('test');
});

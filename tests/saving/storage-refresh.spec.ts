import { isolateLocalRequests, test as base, expect } from '../fixtures';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Ephemeral WebKit contexts reject OPFS; exercise real disk I/O in a disposable
// persistent profile, as in the folder archive coverage.
const test = base.extend({ context: async ({ context, browserName, playwright }, use, info) => {
  if (browserName !== 'webkit') { await use(context); return; }
  const profile = await mkdtemp(join(tmpdir(), 'pizza-refresh-webkit-'));
  const persistent = await playwright.webkit.launchPersistentContext(profile, { baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173', locale: 'zh-CN', acceptDownloads: true });
  try { await isolateLocalRequests(persistent, info.testId); await use(persistent); } finally { await persistent.close(); await rm(profile, { recursive: true, force: true }); }
} });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as any;
    state.__refresh = { calls: 0, pending: 0, peak: 0, hold: false };
    (window as any).Worker = new Proxy(Worker, { construct(Target, argumentsList) {
      const worker = Reflect.construct(Target, argumentsList) as Worker;
      const lists = new Set<number>(), post = worker.postMessage;
      // Observe replies before application handlers resume their awaiters.
      worker.addEventListener('message', event => { if (lists.delete(event.data.id)) state.__refresh.pending--; });
      worker.postMessage = (message: any, ...options: any[]) => {
        if (message?.type === 'list') {
          const count = state.__refresh; count.calls++; count.pending++; count.peak = Math.max(count.peak, count.pending);
          lists.add(message.id);
          if (count.hold) return;
        }
        Reflect.apply(post, worker, [message, ...options]);
      };
      return worker;
    } });
  });
  await page.goto('./');
  await expect.poll(() => page.evaluate(() => (window as any).__refresh.calls > 0 && !(window as any).__refresh.pending)).toBe(true);
});

test('bursts coalesce directory reads while the latest file and cleanup remain visible', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).__refresh.calls);
  await page.evaluate(() => { for (let i = 0; i < 50; i++) window.dispatchEvent(new Event('pizzasend-storage-change')); });
  await expect.poll(() => page.evaluate(before => (window as any).__refresh.calls > before && !(window as any).__refresh.pending, before)).toBe(true);
  const count = await page.evaluate(before => ({ calls: (window as any).__refresh.calls - before, peak: (window as any).__refresh.peak }), before);
  expect(count.calls).toBeLessThanOrEqual(2); expect(count.peak).toBe(1);
  await page.evaluate(async () => {
    const storage = await import('/src/received-storage.ts'), data = new TextEncoder().encode('latest file');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
    const id = await storage.createTemporarySession(data.length); if (!id) throw Error('Storage unavailable');
    await storage.beginTemporaryFile(id, { id: 0, name: 'latest.txt', size: data.length, type: 'text/plain' });
    await storage.writeTemporaryFile(id, 0, data.buffer);
    await storage.finishTemporaryFile(id, hash); await storage.completeTemporarySession(id);
  });
  await expect(page.locator('#stored-files .filename-button')).toHaveText('latest.txt');
  await page.locator('#clear-stored').click(); await page.locator('#confirm-cleanup').click();
  await expect(page.locator('#cleanup-dialog')).toBeHidden();
  await expect(page.locator('#stored-panel')).toBeHidden();
});

test('leaving during a pending refresh drops queued reads and cannot schedule an error retry', async ({ page }) => {
  await page.clock.install();
  const before = await page.evaluate(() => (window as any).__refresh.calls);
  await page.evaluate(() => {
    (window as any).__refresh.hold = true;
    for (let i = 0; i < 50; i++) window.dispatchEvent(new Event('pizzasend-storage-change'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__refresh.pending)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.clock.fastForward(61000);
  expect(await page.evaluate(() => (window as any).__refresh.calls)).toBe(before + 1);
  await expect(page.locator('#notice')).toBeHidden();
});

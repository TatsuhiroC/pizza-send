import { test as base, expect, chromium } from '@playwright/test';
import { open, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// A temporary persistent profile gives OPFS disk-backed storage; private contexts
// can instead use a smaller storage quota based on the runner's memory.
const test = base.extend({
  context: async ({}, use, info) => {
    const profile = await mkdtemp(join(tmpdir(), 'pizza-send-browser-'));
    const context = await chromium.launchPersistentContext(profile, {
      ...info.project.use.launchOptions, headless: true,
      baseURL: info.project.use.baseURL, acceptDownloads: true
    });
    try { await use(context); }
    finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  }
});

for (const megabytes of [200, 1024]) {
  test(`${megabytes} MiB file streams to browser disk with SHA-256`, async ({ page, context }) => {
    test.setTimeout(360000);
    const directory = resolve('../../work/large-test');
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, `stream-${megabytes}.bin`);
    const block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < block.length; i++) block[i] = i % 251;
    const hash = createHash('sha256');
    const file = await open(path, 'w');
    try {
      for (let i = 0; i < megabytes; i++) { await file.write(block); hash.update(block); }
    } finally { await file.close(); }
    const expected = hash.digest('hex');
    await context.addInitScript(() => {
      localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
      localStorage.setItem('pizza-send-stun', '');
      // Only the isolated test browser uses fake media to expose local ICE interfaces.
      void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    });
    const receiver = await context.newPage();
    await receiver.addInitScript(() => {
      // Replace the UI picker with a real OPFS handle; writes still use the browser's disk stream.
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
        const directory = await navigator.storage.getDirectory();
        return directory.getFileHandle('large-received.bin', { create: true });
      } });
    });
    try {
      await page.goto('/');
      await page.locator('#file-input').setInputFiles(path);
      await page.locator('#start-send').click();
      await expect(page.locator('#share-box')).toBeVisible();
      await receiver.goto(await page.locator('#share-link').inputValue());
      await expect(receiver.locator('#accept-files')).toBeVisible();
      const capacity = await receiver.evaluate(() => navigator.storage.estimate());
      console.log(`OPFS_CAPACITY_${megabytes}MiB=${capacity.quota ?? 'unknown'}`);
      test.skip(capacity.quota !== undefined && capacity.quota < megabytes * 1024 * 1024 * 1.2, 'Isolated browser OPFS quota is too small for this fixture; use a host with more storage.');
      const started = Date.now();
      await receiver.locator('#accept-files').click();
      await receiver.waitForFunction(() => ['传输完成，原样送达。', '传输未完成'].includes(document.getElementById('status')?.textContent || ''), null, { timeout: 300000 });
      expect(await receiver.locator('#status').textContent(), await receiver.locator('#notice').textContent() || 'transfer failed').toBe('传输完成，原样送达。');
      await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
      const result = await receiver.evaluate(async () => {
        const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
        const directory = await navigator.storage.getDirectory();
        const handle = await directory.getFileHandle('large-received.bin');
        const file = await handle.getFile(), hash = sha256.create();
        const reader = file.stream().getReader();
        while (true) { const { value, done } = await reader.read(); if (done) break; hash.update(value); }
        const digest = Array.from(hash.digest(), n => n.toString(16).padStart(2, '0')).join('');
        await directory.removeEntry('large-received.bin');
        return { size: file.size, digest };
      });
      expect(result.size).toBe(megabytes * 1024 * 1024);
      expect(result.digest).toBe(expected);
      console.log(`LOCAL_ONLY_${megabytes}MiB_SECONDS=${((Date.now() - started) / 1000).toFixed(2)} (includes independent disk verification)`);
    } finally { await rm(path, { force: true }); }
  });
}

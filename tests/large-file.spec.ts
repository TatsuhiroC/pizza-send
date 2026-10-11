import { test, expect } from '@playwright/test';
import { open, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

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
      const started = Date.now();
      await receiver.locator('#accept-files').click();
      await expect(receiver.locator('#status')).toHaveText('传输完成，原样送达。', { timeout: 300000 });
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

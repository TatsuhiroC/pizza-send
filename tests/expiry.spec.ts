import { test, expect, type Page } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const HOUR = 3600000;
const START = Date.UTC(2026, 9, 12, 8);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const moduleURLs = new WeakMap<Page, string>();
async function clocked(page: Page) {
  const clock = { now: START };
  await page.route('**/src/storage-worker.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: 'globalThis.__expiryNow = ' + clock.now + '; Date.now = () => globalThis.__expiryNow;\n' + await response.text() });
  });
  await page.goto('./');
  await expect.poll(() => page.workers().filter(w => w.url().includes('storage-worker')).length).toBe(1);
  moduleURLs.set(page, await page.evaluate(() => performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/received-storage.ts')!.name));
  await page.clock.install({ time: START });
  return clock;
}
async function moveClock(page: Page, clock: { now: number }, now: number) {
  clock.now = now;
  await page.clock.setSystemTime(now);
  await page.workers().find(w => w.url().includes('storage-worker'))!.evaluate(now => { (globalThis as any).__expiryNow = now; }, now);
}
async function storageURL(page: Page) {
  return moduleURLs.get(page)!;
}
async function seed(page: Page, names: string[], complete = true) {
  const url = await storageURL(page), before = (await records(page)).length;
  const id = await page.evaluate(async ({ url, names, hashes, complete }) => {
    const s = await import(url), id = (await s.createTemporarySession(names.length * 4))!;
    for (const [index, name] of names.entries()) {
      await s.beginTemporaryFile(id, { id: index, name, size: 4, type: 'text/plain' });
      await s.writeTemporaryFile(id, 0, new Uint8Array(4).fill(index + 1).buffer);
      await s.finishTemporaryFile(id, hashes[index]);
    }
    if (complete) await s.completeTemporarySession(id);
    return id;
  }, { url, names, complete, hashes: names.map((_, index) => hash(Buffer.alloc(4, index + 1))) });
  await expect(page.locator('.download-file')).toHaveCount(before + names.length);
  return { id, url };
}
async function records(page: Page) {
  const url = await storageURL(page);
  return page.evaluate(async url => (await import(url)).listTemporaryFiles(), url);
}
async function visit(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}
async function directories(page: Page) {
  return page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('pizzasend-received-v1');
    const names = []; for await (const [name, entry] of root.entries()) if (entry.kind === 'directory') names.push(name); return names;
  });
}

test('long active batches are protected, then receive a full hour and expire automatically', async ({ page }, info) => {
  const clock = await clocked(page), active = await seed(page, ['first.txt'], false);
  await page.evaluate(async ({ id, url }) => {
    const s = await import(url);
    await s.beginTemporaryFile(id, { id: 1, name: 'second.txt', size: 4, type: 'text/plain' });
    await s.writeTemporaryFile(id, 0, new Uint8Array([2, 2]).buffer);
  }, active);
  await moveClock(page, clock, START + 2 * HOUR); await visit(page);
  expect((await records(page))[0].expiresAt).toBeUndefined();
  await expect(page.locator('.stored-deadline')).toHaveText('本次传输结束后保留 1 小时');
  await page.evaluate(async ({ id, url, hash }) => {
    const s = await import(url);
    await s.writeTemporaryFile(id, 2, new Uint8Array([2, 2]).buffer);
    await s.finishTemporaryFile(id, hash); await s.completeTemporarySession(id);
  }, { ...active, hash: hash(Buffer.alloc(4, 2)) });
  await expect(page.locator('.download-file')).toHaveCount(2);
  expect((await records(page)).map(file => file.expiresAt)).toEqual([START + 3 * HOUR, START + 3 * HOUR]);
  await expect(page.locator('.stored-deadline').first()).toHaveText('约 60 分钟后清理');
  await page.setViewportSize({ width: 320, height: 844 }); await page.locator('#language-toggle').click();
  await expect(page.locator('.stored-deadline').first()).toHaveText('Cleared in about 60 min');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('expiry-english-mobile.png'), fullPage: true });
  await moveClock(page, clock, START + 3 * HOUR - 1);
  expect(await records(page)).toHaveLength(2);
  const blob = await page.locator('.download-file').first().getAttribute('href');
  await moveClock(page, clock, START + 3 * HOUR);
  await page.clock.runFor(60000); // Run the real page's scheduled cleanup; no extra storage call.
  await expect(page.locator('#stored-panel')).toBeHidden(); await expect.poll(() => directories(page)).toEqual([]);
  expect(await page.evaluate(async url => { try { await fetch(url!); return true; } catch { return false; } }, blob)).toBe(false);
});

test('refresh preserves deadlines; saving renews only that file and expiry keeps its downloaded copy', async ({ page }, info) => {
  const clock = await clocked(page); await seed(page, ['saved.txt', 'other.txt']);
  await moveClock(page, clock, START + 59 * 60000); await page.reload();
  await expect(page.locator('.download-file')).toHaveCount(2);
  expect((await records(page)).map(file => file.expiresAt)).toEqual([START + HOUR, START + HOUR]);
  await expect(page.locator('.stored-deadline').first()).toHaveText('约 1 分钟后清理');
  const pending = page.waitForEvent('download'); await page.locator('.download-file[download="saved.txt"]').click();
  const download = await pending, saved = info.outputPath('downloaded.txt'); await download.saveAs(saved);
  expect(hash(await readFile(saved))).toBe(hash(Buffer.alloc(4, 1)));
  const extended = START + 59 * 60000 + HOUR;
  await expect.poll(async () => (await records(page))[0].expiresAt).toBe(extended);
  await moveClock(page, clock, START + HOUR); await visit(page);
  await expect(page.locator('.download-file')).toHaveCount(1);
  expect((await records(page))[0].expiresAt).toBe(extended);
  await page.reload(); await expect(page.locator('.download-file')).toHaveCount(1);
  expect((await records(page))[0].expiresAt).toBe(extended);
  await moveClock(page, clock, extended); await visit(page);
  await expect(page.locator('#stored-panel')).toBeHidden(); await expect.poll(() => directories(page)).toEqual([]);
  expect(hash(await readFile(saved))).toBe(hash(Buffer.alloc(4, 1)));
  await page.reload(); await expect(page.locator('.download-file')).toHaveCount(0);
});

test('the next visit removes expired files but keeps newer files', async ({ page }) => {
  const clock = await clocked(page); await seed(page, ['older.txt']);
  await moveClock(page, clock, START + 30 * 60000); await seed(page, ['newer.txt']);
  await page.goto('about:blank'); clock.now = START + HOUR; await page.clock.setSystemTime(clock.now); await page.goto('./');
  await expect(page.locator('.download-file')).toHaveCount(1);
  await expect(page.locator('.stored-file .filename-button')).toHaveText('newer.txt');
  expect((await records(page))[0].expiresAt).toBe(START + 90 * 60000);
  expect(await directories(page)).toHaveLength(1);
});

test('legacy metadata gets one hour of grace without renewed deadlines on later visits', async ({ page }) => {
  const clock = await clocked(page), { id } = await seed(page, ['legacy.txt']);
  await page.evaluate(async id => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('pizzasend-received-v1')).getDirectoryHandle(id);
    for (const name of ['index-a.json', 'index-b.json']) {
      const handle = await dir.getFileHandle(name), data = JSON.parse(await (await handle.getFile()).text());
      data.createdAt -= 7 * 24 * 3600000;
      for (const entry of data.files) delete entry.expiresAt;
      const stream = await handle.createWritable(); await stream.write(JSON.stringify(data)); await stream.close();
    }
  }, id);
  await page.reload(); await expect(page.locator('.download-file')).toHaveCount(1);
  expect((await records(page))[0].expiresAt).toBe(START + HOUR);
  await moveClock(page, clock, START + 30 * 60000); await page.reload();
  await expect(page.locator('.download-file')).toHaveCount(1); expect((await records(page))[0].expiresAt).toBe(START + HOUR);
  await moveClock(page, clock, START + HOUR); await page.reload(); await expect(page.locator('#stored-panel')).toBeHidden();
});

test('automatic deletion failure is retried and does not lose the unremoved file across reloads', async ({ page }) => {
  const clock = await clocked(page); await seed(page, ['retry.txt']);
  await page.workers().find(w => w.url().includes('storage-worker'))!.evaluate(() => {
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = function(name, options) {
      if (name === 'file-0.bin') throw new DOMException('fixture disk busy', 'NoModificationAllowedError');
      return remove.call(this, name, options);
    };
  });
  await moveClock(page, clock, START + HOUR); await visit(page);
  await expect(page.locator('#notice')).toBeVisible();
  expect(await directories(page)).toHaveLength(1);
  const preserved = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('pizzasend-received-v1');
    for await (const [, dir] of root.entries()) if (dir.kind === 'directory') {
      const copies = []; for (const name of ['index-a.json', 'index-b.json']) copies.push(JSON.parse(await (await (await (dir as FileSystemDirectoryHandle).getFileHandle(name)).getFile()).text()).files.length);
      return copies;
    }
  });
  expect(preserved).toEqual([1, 1]);
  await page.reload(); await expect(page.locator('#stored-panel')).toBeHidden(); await expect.poll(() => directories(page)).toEqual([]);
});


test('a cleanup confirmation remains usable when its files expire before confirmation', async ({ page }) => {
  const clock = await clocked(page); await seed(page, ['expired-before-confirm.txt']);
  await page.locator('#clear-stored').click(); await expect(page.locator('#cleanup-dialog')).toBeVisible();
  await moveClock(page, clock, START + HOUR); await visit(page);
  await expect(page.locator('.download-file')).toHaveCount(0);
  await page.locator('#confirm-cleanup').click(); await expect(page.locator('#cleanup-dialog')).toBeHidden();
  await expect(page.locator('#cleanup-error')).toBeHidden(); expect(await directories(page)).toEqual([]);
});

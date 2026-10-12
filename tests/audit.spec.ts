import { test, expect, type BrowserContext } from './fixtures';
import { readFile } from 'node:fs/promises';

async function setup(context: BrowserContext) {
  await context.route('http://127.0.0.1:8787/rooms', route => route.continue({ headers: {
    ...route.request().headers(), 'cf-connecting-ip': '192.0.2.200'
  } }));
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
}

test('retrying a partially failed folder selection uses only the new folder and preserves existing files', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const root = await navigator.storage.getDirectory();
    const first = await root.getDirectoryHandle('first', { create: true });
    const second = await root.getDirectoryHandle('second', { create: true });
    const existing = await second.getFileHandle('a.txt', { create: true });
    const writer = await existing.createWritable(); await writer.write('keep me'); await writer.close();
    let attempts = 0;
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => {
      if (++attempts > 1) return second;
      return {
        keys: () => first.keys(),
        getFileHandle: (name: string, options: any) => {
          if (name === 'b.txt') throw new DOMException('Fixture failure', 'NotAllowedError');
          return first.getFileHandle(name, options);
        }
      };
    } });
    const transfer: any = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 268435456 }, 'receiver', () => {});
    transfer.manifest = [{ id: 0, name: 'a.txt', size: 1, type: '' }, { id: 1, name: 'b.txt', size: 1, type: '' }];
    transfer.channel = { readyState: 'open', send() {}, close() {} };
    let failed = false;
    try { await transfer.accept(); } catch { failed = true; }
    await transfer.accept();
    const handles = transfer.handles;
    const names = handles.map((handle: FileSystemFileHandle) => handle.name);
    const fromSecond = await Promise.all(handles.map((handle: FileSystemFileHandle) => second.resolve(handle)));
    for (const handle of handles) {
      const stream = await handle.createWritable(); await stream.write('x'); await stream.close();
    }
    const preserved = await (await existing.getFile()).text();
    const oldFile = await (await (await first.getFileHandle('a.txt')).getFile()).text();
    transfer.close(false);
    await root.removeEntry('first', { recursive: true }); await root.removeEntry('second', { recursive: true });
    return { failed, names, fromSecond, preserved, oldFile };
  });
  expect(result).toEqual({ failed: true, names: ['1-a.txt', 'b.txt'], fromSecond: [['1-a.txt'], ['b.txt']], preserved: 'keep me', oldFile: '' });
});

test('an old receiving request cannot cancel or show errors in a new sending session', async ({ page, context }) => {
  await setup(context);
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  let requested = false;
  await page.route('http://127.0.0.1:8787/rooms/' + 'a'.repeat(64) + '?*', async route => {
    requested = true; await gate;
    await route.fulfill({ status: 410, body: 'Session expired', headers: { 'access-control-allow-origin': 'http://127.0.0.1:5173' } });
  });
  try {
    await page.goto('./'); await page.locator('#receive-tab').click();
    const url = new URL(page.url()); url.hash = new URLSearchParams({ r: 'a'.repeat(64), t: 'b'.repeat(64), k: 'c'.repeat(64) }).toString();
    await page.locator('#receive-code').fill(url.toString()); await page.locator('#connect-receive').click();
    await expect.poll(() => requested).toBe(true);
    await page.locator('#cancel').click(); await page.locator('#send-tab').click();
    await page.locator('#file-input').setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('new session') });
    await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
    const link = await page.locator('#share-link').inputValue();
    const response = page.waitForResponse(r => r.url().includes('/rooms/' + 'a'.repeat(64)));
    release(); await response;
    // A fresh UI action runs after the old request's rejection handlers.
    await page.locator('#language-toggle').click(); await page.locator('#language-toggle').click();
    await expect(page.locator('#notice')).toBeHidden(); await expect(page.locator('#start-send')).toBeDisabled();
    const receiver = await context.newPage(); await receiver.goto(link);
    await expect(receiver.locator('#accept-files')).toBeVisible();
    await receiver.locator('#accept-files').click();
    await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
    const download = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
    expect((await readFile((await (await download).path())!)).toString()).toBe('new session');
  } finally { release(); }
});

test('closing while a disk write is pending never acknowledges unsaved data', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const receipts: any[] = [], events: string[] = [];
    let finish!: () => void;
    const gate = new Promise<void>(resolve => finish = resolve);
    const transfer: any = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 268435456 }, 'receiver', event => events.push(event.type));
    const channel: any = { readyState: 'open', send(value: string) { receipts.push(JSON.parse(value)); }, close() {} };
    transfer.channel = channel; transfer.accepted = true;
    transfer.manifest = [{ id: 0, name: 'write.bin', size: 1, type: '' }];
    transfer.incoming = { info: transfer.manifest[0], received: 0, ack: 0, parts: [],
      hash: (await import('/node_modules/@noble/hashes/sha2.js')).sha256.create(),
      writer: { write: () => gate, abort: async () => {} } };
    const pending = transfer.handle(new Uint8Array([7]).buffer, 0);
    transfer.close(false); finish(); await pending;
    return { receipts, progressAfterClose: events.includes('progress') };
  });
  expect(result).toEqual({ receipts: [], progressAfterClose: false });
});

test('control messages are bounded before entering the asynchronous receive queue', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const errors: string[] = [];
    const transfer: any = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 268435456 }, 'receiver', event => {
      if (event.type === 'error') errors.push(event.data);
    });
    const channel: any = { readyState: 'open', close() {} };
    transfer.attach(channel);
    // Deliver synchronously to model a burst while the queue is waiting on disk.
    for (let i = 0; i < 5000 && !transfer.stopped; i++) channel.onmessage({ data: JSON.stringify({ type: 'pong', padding: 'x'.repeat(60000) }) });
    const stoppedImmediately = transfer.stopped;
    transfer.close(false); await transfer.queue;
    return { stoppedImmediately, errors };
  });
  expect(result).toEqual({ stoppedImmediately: true, errors: ['接收队列超出安全限制'] });
});

test('pasted links reject other websites and connection settings reject embedded credentials', async ({ page }) => {
  await page.goto('./'); await page.locator('#receive-tab').click();
  await page.locator('#receive-code').fill('https://unknown.example/#2.' + 'A'.repeat(43));
  await page.locator('#connect-receive').click();
  await expect(page.locator('#notice')).toContainText('本站的 PizzaSend');
  await expect(page.locator('#session-panel')).toBeHidden();
  await expect(page.locator('#connect-receive')).toBeEnabled();
  await page.locator('.settings > summary').click();
  await page.locator('#signal-url').fill('https://user:password@example.com');
  await page.locator('#save-settings').click();
  await expect(page.locator('#notice')).toContainText('不能包含凭据');
  expect(await page.evaluate(() => localStorage.getItem('pizza-send-signal'))).toBeNull();
});

test('blocking browser preferences does not prevent page initialization', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/app.config.json', route => route.fulfill({ json: {
    signalUrl: 'https://signal.example', iceServers: [], memoryLimitBytes: 268435456
  } }));
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
  });
  await page.goto('./');
  await expect(page.locator('#signal-url')).toHaveValue('https://signal.example');
  await page.locator('#language-toggle').click(); await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(errors).toEqual([]);
});

test('portable filenames preserve extensions, Unicode code points and collision-prefix space', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { safeName } = await import('/src/protocol.ts');
    const names = ['电影'.repeat(80) + '.mp4', '🍕'.repeat(100) + '.zip'].map(safeName);
    return {
      names, sizes: names.map(name => new TextEncoder().encode(name).length),
      units: names.map(name => name.length), canonical: names.every(name => name === safeName(name)),
      reserved: safeName('CON.txt'), unsafe: safeName('a:b?c*.txt'), empty: safeName('.. ')
    };
  });
  expect(result.names[0]).toMatch(/^电影.+\.mp4$/);
  expect(result.names[1]).toMatch(/^(?:🍕)+\.zip$/u);
  expect(result.sizes.every(size => size <= 240)).toBe(true);
  expect(result.units.every(size => size <= 180)).toBe(true);
  expect(result.canonical).toBe(true);
  expect(result.reserved).toBe('_CON.txt'); expect(result.unsafe).toBe('a_b_c_.txt'); expect(result.empty).toBe('received-file');
});

import { test, expect, type BrowserContext, type Page } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
async function setup(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    const Peer = RTCPeerConnection, Socket = WebSocket;
    const state = window as any;
    state.__pcs = []; state.__sockets = []; state.__starts = []; state.__sentBytes = 0;
    state.RTCPeerConnection = class extends Peer { constructor(config: any) { super(config); state.__pcs.push(this); } };
    state.WebSocket = class extends Socket { constructor(url: string, protocols?: string | string[]) { super(url, protocols); state.__sockets.push(this); } };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (data instanceof ArrayBuffer) state.__sentBytes += data.byteLength;
      else if (typeof data === 'string') {
        const message = JSON.parse(data);
        if (message.type === 'file-start') state.__starts.push(message);
      }
      return send.call(this, data);
    } as any;
    // Slow only fixture reads, leaving enough time to interrupt a real transfer.
    const arrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function() {
      if (this.size <= 1048576) await new Promise(resolve => setTimeout(resolve, 2 * Math.ceil(this.size / 32768)));
      return arrayBuffer.call(this);
    };
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
}
async function begin(sender: Page, receiver: Page, buffer: Buffer, multiple = false) {
  await sender.goto('./');
  const files = [{ name: 'resume.bin', mimeType: 'application/octet-stream', buffer }];
  if (multiple) {
    files.unshift({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
    files.push({ name: 'after.txt', mimeType: 'text/plain', buffer: Buffer.from('after recovery') });
  }
  await sender.locator('#file-input').setInputFiles(files);
  await sender.locator('#start-send').click();
  await expect(sender.locator('#share-box')).toBeVisible();
  await receiver.goto(await sender.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible();
  await receiver.locator('#accept-files').click();
  await expect.poll(() => sender.evaluate(() => (window as any).__sentBytes)).toBeGreaterThan(2 * 1048576);
}
async function interrupt(page: Page, sockets = false) {
  await page.evaluate(sockets => {
    const state = window as any;
    state.__pcs.at(-1).close();
    if (sockets) for (const socket of state.__sockets) if (socket.url.includes('/rooms/')) socket.close();
  }, sockets);
}
test('repeated transport and signaling interruptions resume a multi-file download without restarting', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  const errors: string[] = [];
  for (const p of [page, receiver]) p.on('pageerror', error => errors.push(error.message));
  const buffer = Buffer.alloc(24 * 1048576);
  for (let i = 0; i < buffer.length; i++) buffer[i] = i % 251;
  await begin(page, receiver, buffer, true);
  await interrupt(page, true);
  await interrupt(receiver, true);
  await expect.poll(() => page.evaluate(() => (window as any).__starts.filter((start: any) => start.offset > 0).length), { timeout: 40000 }).toBe(1);
  await interrupt(receiver);
  await expect.poll(() => page.evaluate(() => (window as any).__starts.filter((start: any) => start.offset > 0).length), { timeout: 40000 }).toBe(2);
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。', { timeout: 60000 });
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const state = await page.evaluate(() => ({ starts: (window as any).__starts, sent: (window as any).__sentBytes }));
  expect(state.starts.filter((start: any) => start.id === 0)).toHaveLength(1);
  expect(state.starts.filter((start: any) => start.offset > 0).every((start: any) => start.id === 1)).toBe(true);
  expect(state.sent).toBeLessThan(buffer.length + 8 * 1048576);
  expect(await receiver.locator('.download-file').count()).toBe(3);
  const download = receiver.waitForEvent('download');
  await receiver.locator('.download-file').nth(1).click();
  expect(sha(await readFile((await (await download).path())!))).toBe(sha(buffer));
  expect(errors).toEqual([]);
});
test('disk-stream recovery retains the original writer and save permission', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    const state = window as any;
    state.__picks = 0; state.__writers = 0;
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
      state.__picks++;
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('resume-disk.bin', { create: true });
      return { createWritable: async () => {
        state.__writers++;
        const writer = await handle.createWritable();
        return { write: (data: any) => writer.write(data), close: () => writer.close(), abort: () => writer.abort() };
      } };
    } });
  });
  const buffer = Buffer.alloc(8 * 1048576, 73);
  await begin(page, receiver, buffer);
  await interrupt(receiver, true);
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。', { timeout: 60000 });
  const saved = await receiver.evaluate(async () => {
    const state = window as any, root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle('resume-disk.bin')).getFile();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    await root.removeEntry('resume-disk.bin');
    return { size: file.size, hash, picks: state.__picks, writers: state.__writers };
  });
  expect(saved).toEqual({ size: buffer.length, hash: sha(buffer), picks: 1, writers: 1 });
  expect(await page.evaluate(() => (window as any).__starts[1].offset)).toBeGreaterThan(0);
});
test('invalid resume offset is rejected instead of skipping file bytes', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (typeof data === 'string' && data.includes('"type":"resume"')) {
        const message = JSON.parse(data); message.offset = Number.MAX_SAFE_INTEGER;
        data = JSON.stringify(message);
      }
      return send.call(this, data);
    } as any;
  });
  await begin(page, receiver, Buffer.alloc(8 * 1048576, 4));
  await interrupt(page);
  await expect(page.locator('.recipient-row[data-phase="error"]')).toContainText('续传位置无效', { timeout: 40000 });
  await expect(receiver.locator('.download-file')).toHaveCount(0);
});
test('cancelling during recovery ends the room and does not restore the transfer', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  await begin(page, receiver, Buffer.alloc(8 * 1048576, 9));
  await interrupt(page);
  await page.locator('#cancel').click();
  await expect(page.locator('#start-send')).toBeEnabled();
  await expect(receiver.locator('#notice')).toContainText(/结束|取消|关闭/);
  await expect(page.locator('#session-panel')).toBeHidden();
  await expect(receiver.locator('.download-file')).toHaveCount(0);
});
test('a lost final completion receipt recovers without sending the file again', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  await receiver.addInitScript(() => {
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      const state = window as any;
      if (!state.__dropped && typeof data === 'string' && data.includes('"type":"complete"')) {
        state.__dropped = true;
        setTimeout(() => state.__pcs.at(-1).close(), 0);
        return;
      }
      return send.call(this, data);
    } as any;
  });
  const buffer = Buffer.alloc(4 * 1048576, 21);
  await begin(page, receiver, buffer);
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。', { timeout: 40000 });
  expect(await receiver.evaluate(() => (window as any).__dropped)).toBe(true);
  expect(await page.evaluate(() => (window as any).__sentBytes)).toBe(buffer.length);
  expect(await page.evaluate(() => (window as any).__starts.length)).toBe(1);
  const download = receiver.waitForEvent('download');
  await receiver.locator('.download-file').click();
  expect(sha(await readFile((await (await download).path())!))).toBe(sha(buffer));
});
test('corruption after reconnection is caught by the whole-file checksum', async ({ page, context }) => {
  await setup(context);
  await page.addInitScript(() => {
    const send = RTCDataChannel.prototype.send;
    let corruptNext = false;
    RTCDataChannel.prototype.send = function(data: any) {
      if (typeof data === 'string' && data.includes('"type":"file-start"') && JSON.parse(data).offset > 0) corruptNext = true;
      if (corruptNext && data instanceof ArrayBuffer) {
        const copy = data.slice(0); new Uint8Array(copy)[0] ^= 1; data = copy; corruptNext = false;
      }
      return send.call(this, data);
    } as any;
  });
  const receiver = await context.newPage();
  await begin(page, receiver, Buffer.alloc(8 * 1048576, 33));
  await interrupt(page);
  await expect(receiver.locator('#notice')).toContainText('完整性校验失败', { timeout: 40000 });
  await expect(receiver.locator('.download-file')).toHaveCount(0);
});
test('signaling reconnect replaces only the same client and explicit cancellation ends the room', async ({ page, context }) => {
  await setup(context);
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const room = await (await fetch('http://127.0.0.1:8787/rooms', { method: 'POST' })).json();
    const connect = (role: string, client: string) => new Promise<WebSocket | null>(resolve => {
      const ws = new WebSocket('ws://127.0.0.1:8787/rooms/' + room.room + '?' + new URLSearchParams({ role, token: room[role], client }));
      ws.onopen = () => resolve(ws); ws.onerror = () => resolve(null);
    });
    const sender = await connect('sender', 'a'.repeat(64));
    const receiver = await connect('receiver', 'b'.repeat(64));
    const intruder = await connect('receiver', 'c'.repeat(64));
    const replacement = await connect('receiver', 'b'.repeat(64));
    const ended = new Promise<boolean>(resolve => {
      replacement!.onmessage = event => { if (JSON.parse(event.data).type === 'ended') resolve(true); };
    });
    sender!.send(JSON.stringify({ type: 'end' }));
    const cancelled = await ended;
    const rejectedAfterEnd = await connect('receiver', 'b'.repeat(64));
    sender!.close(); receiver!.close(); replacement!.close();
    return { intruderRejected: intruder === null, replacementConnected: !!replacement, cancelled, endedRoomRejected: rejectedAfterEnd === null };
  });
  expect(result).toEqual({ intruderRejected: true, replacementConnected: true, cancelled: true, endedRoomRejected: true });
});

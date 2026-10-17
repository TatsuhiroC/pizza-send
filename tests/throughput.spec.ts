import { test, expect } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('real slow receiver applies backpressure, batches writes, stays bounded and recovers throughput without changing bytes', async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    const state = window as any; state.__sent = 0; state.__ack = 0; state.__peakFlight = 0; state.__maxChunk = 0; state.__writeSizes = [];
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function(...args: any[]) {
      const channel = create.apply(this, args as [string, RTCDataChannelInit?]);
      channel.addEventListener('message', event => { if (typeof event.data === 'string') { const message = JSON.parse(event.data); if (message.type === 'ack') state.__ack = message.bytes; } });
      return channel;
    };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (data instanceof ArrayBuffer) { state.__sent += data.byteLength; state.__maxChunk = Math.max(state.__maxChunk, data.byteLength); state.__peakFlight = Math.max(state.__peakFlight, state.__sent - state.__ack); }
      return send.call(this, data);
    } as any;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: any, transfer?: any) {
      if (message?.type === 'write') {
        state.__writeSizes.push(message.data.buffer.byteLength);
        if (message.data.offset >= 2 * 1048576 && message.data.offset < 4 * 1048576) { setTimeout(() => post.call(this, message, transfer ?? []), 50); return; }
      }
      return post.call(this, message, transfer ?? []);
    };
  });
  const receiver = await context.newPage();
  await page.goto('./');
  await page.evaluate(async () => {
    const state = window as any; state.__windows = [];
    const { TransferFlow } = await import('/src/transfer-flow.ts'), confirm = TransferFlow.prototype.confirm;
    TransferFlow.prototype.confirm = function(bytes: number, now?: number) { confirm.call(this, bytes, now); state.__windows.push(this.windowBytes); };
  });
  const buffer = Buffer.alloc(12 * 1048576 + 17, 73);
  await page.locator('#file-input').setInputFiles({ name: '流水线-原文件.mp4', mimeType: 'video/mp4', buffer });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue()); await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备', { timeout: 90000 });
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  const stats = await page.evaluate(() => ({ peak: (window as any).__peakFlight, chunk: (window as any).__maxChunk, windows: (window as any).__windows as number[] }));
  expect(stats.peak).toBeLessThanOrEqual(4 * 1048576); expect(stats.chunk).toBeLessThanOrEqual(32768);
  expect(Math.min(...stats.windows)).toBeGreaterThanOrEqual(512 * 1024); expect(Math.max(...stats.windows)).toBeLessThanOrEqual(4 * 1048576);
  const smallest = Math.min(...stats.windows), lowestAt = stats.windows.indexOf(smallest);
  expect(smallest).toBeLessThan(4 * 1048576);
  expect(Math.max(...stats.windows.slice(lowestAt))).toBeGreaterThan(smallest);
  const sizes = await receiver.evaluate(() => (window as any).__writeSizes as number[]);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024); expect(sizes.some(size => size > 32768)).toBe(true);
  const download = receiver.waitForEvent('download'); await receiver.locator('.download-file').click(); const original = await download;
  expect(original.suggestedFilename()).toBe('流水线-原文件.mp4');
  expect(createHash('sha256').update(await readFile((await original.path())!)).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'));
  await page.locator('#cancel').click();
});

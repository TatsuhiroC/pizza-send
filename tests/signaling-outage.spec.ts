import { test, expect } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

for (const role of ['sender', 'receiver'] as const) test(`a service disconnect notice preserves a healthy ${role} data channel but still recovers a broken one`, async ({ page }) => {
  await page.goto('./');
  const requests = await page.evaluate(async role => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, role, () => {});
    const pair = new AutoPair(transfer, await signalKey('a'.repeat(64)), () => {});
    let requests = 0;
    transfer.requestRecovery = () => { requests++; };
    (pair as any).offered = true;
    Object.defineProperty(transfer.pc, 'connectionState', { configurable: true, value: 'connected' });
    const channel = { readyState: 'open', close() {} }; transfer.channel = channel as any;
    try {
      await (pair as any).handle({ type: 'peer-left' });
      const healthy = requests;
      channel.readyState = 'closed';
      await (pair as any).handle({ type: 'peer-left' });
      const broken = requests; channel.readyState = 'open';
      Object.defineProperty(transfer.pc, 'connectionState', { configurable: true, value: 'failed' });
      await (pair as any).handle({ type: 'peer-left' });
      return { healthy, broken, failed: requests };
    } finally { pair.close(); transfer.close(false); }
  }, role);
  expect(requests).toEqual({ healthy: 0, broken: 1, failed: 2 });
});

test('losing only the receiver signaling socket does not restart a healthy real file transfer', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real DataChannel outages run in Chromium; both engines cover lifecycle notices above.');
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    const state = window as any, Peer = RTCPeerConnection, Socket = WebSocket;
    state.__pcs = []; state.__sockets = []; state.__bytes = 0;
    state.RTCPeerConnection = class extends Peer { constructor(config: RTCConfiguration) { super(config); state.__pcs.push(this); } };
    state.WebSocket = class extends Socket { constructor(url: string) { super(url); state.__sockets.push(this); } };
    const read = Blob.prototype.arrayBuffer, send = RTCDataChannel.prototype.send;
    Blob.prototype.arrayBuffer = async function() { if (this.size <= 1048576) await new Promise(resolve => setTimeout(resolve, 3)); return read.call(this); };
    RTCDataChannel.prototype.send = function(data: any) { if (data instanceof ArrayBuffer) state.__bytes += data.byteLength; return send.call(this, data); } as any;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
  const receiver = await context.newPage(), original = Buffer.alloc(16 * 1048576, 87);
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'signal-independent.bin', mimeType: 'application/octet-stream', buffer: original });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue()); await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect.poll(() => page.evaluate(() => (window as any).__bytes)).toBeGreaterThan(1048576);
  await receiver.evaluate(() => { for (const socket of (window as any).__sockets) socket.close(); });
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  for (const target of [page, receiver]) expect(await target.evaluate(() => (window as any).__pcs.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__bytes)).toBe(original.length);
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  const actual = await readFile((await (await pending).path())!);
  expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
});

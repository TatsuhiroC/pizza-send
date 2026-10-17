import { test, expect } from '../tests/fixtures';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Local DataChannels and real OPFS. Delays below affect browser file reads or
// application ACKs, not the physical network; these are comparative fixtures.
const results: unknown[] = [];
test.afterAll(async () => {
  if (process.env.BENCHMARK_RESULT) await writeFile(process.env.BENCHMARK_RESULT, JSON.stringify(results, null, 2));
});
for (const profile of ['local', 'read-delay', 'ack-delay'] as const) {
  for (let repeat = 0; repeat < 3; repeat++) test(`${profile} run ${repeat + 1}`, async ({ page, context }) => {
    await context.addInitScript(profile => {
      const state = window as any;
      state.__reads = 0; state.__readBytes = 0; state.__writes = 0; state.__pollFired = 0;
      const timeout = window.setTimeout.bind(window);
      state.setTimeout = (fn: (...args: any[]) => void, delay: number, ...args: any[]) => timeout(() => {
        if (delay === 250) state.__pollFired++;
        fn(...args);
      }, delay);
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message: any, transfer?: any) {
        if (message?.type === 'write') state.__writes++;
        return post.call(this, message, transfer ?? []);
      };
      localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
      localStorage.setItem('pizza-send-stun', '');
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
      const read = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function() {
        state.__reads++; state.__readBytes += this.size;
        if (profile === 'read-delay') await new Promise(resolve => setTimeout(resolve, 2));
        return read.call(this);
      };
      const send = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function(data: any) {
        if (typeof data === 'string') {
          const type = JSON.parse(data).type;
          if (type === 'accept') state.__acceptAt = performance.now();
          if (type === 'complete') state.__completeAt = performance.now();
        }
        if (profile === 'ack-delay' && typeof data === 'string' && JSON.parse(data).type === 'ack') {
          setTimeout(() => { if (this.readyState === 'open') send.call(this, data); }, 150);
          return;
        }
        return send.call(this, data);
      } as any;
      void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    }, profile);
    const receiver = await context.newPage();
    const buffer = Buffer.alloc(32 * 1048576);
    for (let i = 0; i < buffer.length; i++) buffer[i] = i % 251;
    await page.goto('./');
    await page.locator('#file-input').setInputFiles({ name: 'benchmark-original.bin', mimeType: 'application/octet-stream', buffer });
    await page.locator('#start-send').click();
    await expect(page.locator('#share-box')).toBeVisible();
    await receiver.goto(await page.locator('#share-link').inputValue());
    await expect(receiver.locator('#accept-files')).toBeVisible();
    const started = performance.now();
    await receiver.locator('#accept-files').click();
    await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备', { timeout: 90000 });
    await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
    const seconds = (performance.now() - started) / 1000;
    const reads = await page.evaluate(() => ({ calls: (window as any).__reads, bytes: (window as any).__readBytes }));
    const download = receiver.waitForEvent('download'); await receiver.locator('.download-file').click(); const file = await download;
    expect(file.suggestedFilename()).toBe('benchmark-original.bin');
    expect(createHash('sha256').update(await readFile((await file.path())!)).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'));
    const writes = await receiver.evaluate(() => (window as any).__writes);
    const transferSeconds = await receiver.evaluate(() => ((window as any).__completeAt - (window as any).__acceptAt) / 1000);
    const polls = await page.evaluate(() => (window as any).__pollFired);
    const result = { profile, repeat: repeat + 1, bytes: buffer.length, seconds, transferSeconds, mibPerSecond: 32 / transferSeconds, reads, writes, polls };
    results.push(result); console.log('TRANSFER_BENCHMARK ' + JSON.stringify(result));
    await page.locator('#cancel').click();
  });
}

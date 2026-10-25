import { test as base, expect, chromium, type BrowserContext } from '../tests/fixtures';
import browserConfig from '../playwright.config';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const test = base.extend<{ receiverContext: BrowserContext }>({
  receiverContext: async ({ browser }, use, info) => {
    const profile = process.env.BENCH_PERSISTENT ? await mkdtemp(join(tmpdir(), 'pizzasend-benchmark-profile-')) : undefined;
    const context = profile ? await chromium.launchPersistentContext(profile, { ...browserConfig.use?.launchOptions, acceptDownloads: true }) : await browser.newContext({ acceptDownloads: true });
    await context.route(url => url.hostname === '127.0.0.1' && url.port === '8787' && url.pathname.startsWith('/rooms'), route =>
      route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': 'benchmark-receiver-' + info.testId } }));
    try { await use(context); } finally { await context.close(); if (profile) await rm(profile, { recursive: true, force: true }); }
  }
});
// Investigation only: delayed application receipts do not simulate a WAN.
const results: unknown[] = [];
const delays = (process.env.BENCH_DELAYS || '150,0,300').split(',').map(Number);
const repeats = Number(process.env.BENCH_REPEATS || 3);
const size = Number(process.env.BENCH_MIB || 32);
test.afterEach(async ({ page, receiverContext }, info) => {
  if (info.status === info.expectedStatus) return;
  const pages = [page, ...receiverContext.pages()];
  const diagnostics = await Promise.all(pages.map(async target => {
    try { return await target.evaluate(() => ({ status: document.getElementById('status')?.textContent, detail: document.getElementById('status-detail')?.textContent, notice: document.getElementById('notice')?.textContent, stats: (window as any).__stats })); }
    catch { return { closed: true }; }
  }));
  await writeFile(info.outputPath('failure-states.json'), JSON.stringify(diagnostics, null, 2));
  console.log('TRANSFER_FAILURE ' + JSON.stringify(diagnostics.map((d: any) => ({ status: d.status, detail: d.detail, notice: d.notice, sent: d.stats?.sent, writes: d.stats?.writes, workerError: d.stats?.workerError, estimate: d.stats?.estimate }))));
});
test.afterAll(async () => {
  if (process.env.BENCHMARK_RESULT) await writeFile(process.env.BENCHMARK_RESULT, JSON.stringify(results, null, 2));
});
for (let repeat = 0; repeat < repeats; repeat++) {
  // Reverse order on alternate rounds to reduce systematic warm-up bias.
  for (const ackDelay of repeat % 2 ? [...delays].reverse() : delays) {
    for (const variant of process.env.BENCH_VARIANTS ? process.env.BENCH_VARIANTS.split(',') : process.env.BENCH_BASELINE_DIST ? (repeat % 2 ? ['candidate', 'published'] : ['published', 'candidate']) : [process.env.BENCH_VARIANT || 'candidate']) {
      test(`${variant} receipt delay ${ackDelay} ms round ${repeat + 1}`, async ({ page, context, receiverContext }, info) => {
        const initialize = ({ ackDelay, writeMiBps }: { ackDelay: number; writeMiBps: number }) => {
          const state = window as any;
          state.__stats = { sent: 0, confirmed: 0, peakFlight: 0, reads: 0, writes: 0,
            readMs: 0, wasmInstances: 0, timers: {} as Record<string, { scheduled: number; fired: number; elapsed: number }>, milestones: [] as any[] };
          const stats = state.__stats;
          void navigator.storage.estimate().then(estimate => { stats.estimate = estimate; });
          const instantiate = WebAssembly.instantiate;
          WebAssembly.instantiate = (async (...args: any[]) => {
            const result = await (instantiate as any)(...args); stats.wasmInstances++; return result;
          }) as typeof WebAssembly.instantiate;
          localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
          localStorage.setItem('pizza-send-stun', '');
          Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
          const timeout = window.setTimeout.bind(window);
          state.setTimeout = (fn: (...args: any[]) => void, delay: number, ...args: any[]) => {
            const at = performance.now(), active = stats.sent > 0 && !stats.lastBinaryAt;
            const key = delay === 250 ? '250ms' : delay <= 25 ? 'short' : 'other';
            const count = stats.timers[key] ||= { scheduled: 0, fired: 0, elapsed: 0 };
            if (active) count.scheduled++;
            return timeout(() => {
              if (active) { count.fired++; count.elapsed += performance.now() - at; }
              fn(...args);
            }, delay);
          };
          const read = Blob.prototype.arrayBuffer;
          Blob.prototype.arrayBuffer = async function() {
            stats.reads++; const at = performance.now();
            const buffer = await read.call(this); stats.readMs += performance.now() - at; return buffer;
          };
          const post = Worker.prototype.postMessage;
          const observedWorkers = new WeakSet<Worker>();
          let writeDue = 0;
          Worker.prototype.postMessage = function(message: any, transfer?: any) {
            if (!observedWorkers.has(this)) {
              observedWorkers.add(this);
              this.addEventListener('message', ({ data }) => {
                if (data?.ok === false) stats.workerError = data.error;
              });
            }
            if (message?.type === 'write') {
              stats.writes++; stats.lastWriteAt = performance.now();
              if (writeMiBps) {
                // Byte-proportional receive-storage service time. This is not a
                // network emulator, and does not charge a fixed delay per RPC.
                const now = performance.now();
                writeDue = Math.max(writeDue, now) + message.data.buffer.byteLength / (writeMiBps * 1048576) * 1000;
                timeout(() => post.call(this, message, transfer ?? []), Math.max(0, writeDue - now));
                return;
              }
            }
            if (message?.type === 'finish-file') stats.finishFileAt = performance.now();
            return post.call(this, message, transfer ?? []);
          };
          const NativePeer = RTCPeerConnection;
          (window as any).RTCPeerConnection = new Proxy(NativePeer, {
            construct(Target, args) {
              const peer = Reflect.construct(Target, args) as RTCPeerConnection;
              peer.addEventListener('datachannel', event => {
                event.channel.addEventListener('message', message => {
                  if (message.data instanceof ArrayBuffer) stats.lastReceiveAt = performance.now();
                });
              });
              return peer;
            }
          });
          const create = RTCPeerConnection.prototype.createDataChannel;
          RTCPeerConnection.prototype.createDataChannel = function(...args: any[]) {
            const channel = create.apply(this, args as [string, RTCDataChannelInit?]);
            channel.addEventListener('message', event => {
              if (typeof event.data !== 'string') return;
              const message = JSON.parse(event.data);
              if (message.type === 'ack') stats.confirmed = message.bytes;
            });
            return channel;
          };
          const send = RTCDataChannel.prototype.send;
          RTCDataChannel.prototype.send = function(data: any) {
            const now = performance.now();
            if (data instanceof ArrayBuffer) {
              stats.firstBinaryAt ??= now;
              stats.sent += data.byteLength;
              stats.peakFlight = Math.max(stats.peakFlight, stats.sent - stats.confirmed);
              if (stats.sent % 1048576 === 0) stats.milestones.push({ bytes: stats.sent, ms: now - stats.firstBinaryAt,
                flight: stats.sent - stats.confirmed, buffered: this.bufferedAmount });
            } else if (typeof data === 'string') {
              const type = JSON.parse(data).type;
              if (type === 'accept') stats.acceptAt = now;
              if (type === 'complete') stats.completeAt = now;
              if (type === 'file-end') stats.lastBinaryAt = now;
              if (type === 'ack' && ackDelay) {
                // Use the native timer so this injection isn't counted as sender pacing.
                timeout(() => { if (this.readyState === 'open') send.call(this, data); }, ackDelay);
                return;
              }
            }
            return send.call(this, data);
          } as any;
          void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
        };
        const options = { ackDelay, writeMiBps: Number(process.env.BENCH_WRITE_MIBPS || 0) };
        await context.addInitScript(initialize, options);
        await receiverContext.addInitScript(initialize, options);
        const receiver = await receiverContext.newPage();
        await page.goto(process.env.BENCH_BASELINE_DIST ? `/${variant}/` : './');
        const path = info.outputPath('latency-original.bin');
        await mkdir(dirname(path), { recursive: true });
        const block = Buffer.alloc(Math.min(size * 1048576, 8 * 1048576));
        for (let i = 0; i < block.length; i++) block[i] = i % 251;
        const expected = createHash('sha256'), fixture = await open(path, 'w');
        try {
          for (let at = 0; at < size * 1048576; at += block.length) {
            const piece = block.subarray(0, Math.min(block.length, size * 1048576 - at));
            await fixture.writeFile(piece); expected.update(piece);
          }
        } finally { await fixture.close(); }
        await page.locator('#file-input').setInputFiles(path);
        await page.locator('#start-send').click();
        await expect(page.locator('#share-box')).toBeVisible();
        const receiverLink = new URL(await page.locator('#share-link').inputValue());
        if (process.env.BENCH_BASELINE_DIST && process.env.BENCH_RECEIVER_VARIANT) receiverLink.pathname = `/${process.env.BENCH_RECEIVER_VARIANT}/`;
        if (process.env.BENCH_DISABLE_WASM) await receiverContext.addInitScript(() => { WebAssembly.compile = async () => { throw new Error('Fixture WASM disabled'); }; });
        await receiver.goto(receiverLink.toString());
        const cpuRate = Number(process.env.BENCH_RECEIVER_CPU || 1);
        const receiverSession = await receiverContext.newCDPSession(receiver);
        await receiverSession.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
        const performanceSessions = [await context.newCDPSession(page), receiverSession];
        for (const session of performanceSessions) await session.send('Performance.enable');
        const profiles = process.env.BENCH_PROFILE ? await Promise.all(performanceSessions.map(async session => {
          await session.send('Profiler.enable'); await session.send('Profiler.start'); return session;
        })) : [];
        await receiver.locator('#accept-files').click();
        await expect(receiver.locator('#status')).toHaveText(/^(文件已收到，请保存到设备|传输未完成|连接未完成)$/, { timeout: 90000 });
        expect(await receiver.locator('#status').textContent()).toBe('文件已收到，请保存到设备');
        await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
        const sender = await page.evaluate(() => (window as any).__stats);
        const received = await receiver.evaluate(() => (window as any).__stats);
        for (let index = 0; index < profiles.length; index++) {
          const { profile } = await profiles[index].send('Profiler.stop');
          await writeFile(info.outputPath(`cpu-${index}.json`), JSON.stringify(profile));
        }
        const taskSeconds = await Promise.all(performanceSessions.map(async session => {
          const { metrics } = await session.send('Performance.getMetrics');
          return Object.fromEntries(metrics.filter(m => ['TaskDuration', 'ScriptDuration'].includes(m.name)).map(m => [m.name, m.value]));
        }));
        const result = { variant, receiverVariant: process.env.BENCH_RECEIVER_VARIANT || variant, persistentReceiver: !!process.env.BENCH_PERSISTENT, cpuRate, taskSeconds, receiverWasm: received.wasmInstances, repeat: repeat + 1, ackDelay, mib: size, writeMiBps: Number(process.env.BENCH_WRITE_MIBPS || 0),
          transferSeconds: (received.completeAt - received.acceptAt) / 1000,
          sendSeconds: (sender.lastBinaryAt - sender.firstBinaryAt) / 1000, sender, receiverWrites: received.writes, receiveTailMs: received.completeAt - received.lastReceiveAt, writeTailMs: received.completeAt - received.lastWriteAt };
        const download = receiver.waitForEvent('download');
        await receiver.locator('.download-file').click(); const file = await download;
        expect(file.suggestedFilename()).toBe('latency-original.bin');
        const actual = createHash('sha256');
        for await (const chunk of createReadStream((await file.path())!)) actual.update(chunk);
        expect(actual.digest('hex')).toBe(expected.digest('hex'));
        expect(sender.peakFlight).toBeLessThanOrEqual(4 * 1048576);
        results.push(result);
        if (process.env.BENCHMARK_RESULT) await writeFile(process.env.BENCHMARK_RESULT, JSON.stringify(results, null, 2));
        console.log('LATENCY_BENCHMARK ' + JSON.stringify({ variant, cpuRate, ackDelay, mib: size, seconds: result.transferSeconds, receiverWrites: received.writes, receiverWasm: received.wasmInstances, peakFlight: sender.peakFlight }));
        await page.locator('#cancel').click();
      });
    }
  }
}

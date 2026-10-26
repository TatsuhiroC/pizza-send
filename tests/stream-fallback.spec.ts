import { test, expect, type WebSocketRoute } from './fixtures';
import { streamWorthTrying } from '../src/stream-fallback';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('a relay candidate needs a measured useful rate, substantial gain and enough remaining time', () => {
  expect(streamWorthTrying(3000, 100, 16 * 1048576)).toBe(true);
  expect(streamWorthTrying(800 * 1024, 262144 * 1000 / (500 * 1024), 1e9)).toBe(false);
  expect(streamWorthTrying(200000, 1200, 16 * 1048576)).toBe(false);
  expect(streamWorthTrying(3000, 12000, 16 * 1048576)).toBe(false);
  expect(streamWorthTrying(3000, 100, 3000)).toBe(false);
  expect(streamWorthTrying(0, 100, 0)).toBe(true);
  for (const value of [NaN, Infinity, 0, -1]) expect(streamWorthTrying(3000, value, 1e6)).toBe(false);
});
test('untrusted stream controls cannot open a channel; native renegotiation defers route probing', async ({ page }) => {
  await page.goto('./');
  expect(await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const transfer: any = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', () => {});
    const pair: any = new AutoPair(transfer, await signalKey('a'.repeat(64)), () => {}, 'a'.repeat(64));
    let opens = 0; pair.streamFallback.supported = true; pair.signal.stream = async () => { opens++; throw Error('Fixture unavailable'); };
    const original = transfer.pc;
    for (const type of ['stream-prepare', 'stream-activate', 'stream-activated', 'stream-unavailable']) await pair.handle({ type, session: 'b'.repeat(64), epoch: 0 });
    const denied = opens === 0 && original === transfer.pc;
    await pair.handle({ type: 'stream-prepare', session: 'b'.repeat(64), epoch: 0 }, true);
    let allowed: boolean | undefined;
    pair.streamFallback.monitor = (value: boolean) => { allowed = value; };
    pair.offered = pair.negotiating = true; pair.monitorRoute();
    const deferred = allowed === false;
    pair.close(); transfer.close(false); return { denied, opens, deferred };
  })).toEqual({ denied: true, opens: 1, deferred: true });
});

for (const blocked of [false, true]) test(blocked ? 'initial direct ICE failure opens encrypted WSS without a TURN stage' : 'a slow long transfer probes encrypted WSS without a TURN stage and resumes the original file', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'The initial native DataChannel comparison uses Chromium.');
  let streamTickets = 0, relayTickets = 0, ciphertextFrames = 0;
  const streams = new Map<string, WebSocketRoute>(), errors: string[] = [];
  await context.route('http://127.0.0.1:8787/rooms/**', async route => {
    const request = route.request(), body = request.method() === 'POST' ? request.postDataJSON() : undefined;
    if (body?.type === 'turn') { relayTickets++; await route.fulfill({ status: 503, json: { error: 'Unavailable in fixture' } }); }
    else if (body?.type === 'stream-connect') {
      streamTickets++; expect(request.headers().authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
      await route.fulfill({ json: { ticket: 'e'.repeat(64) } });
    } else await route.fallback();
  });
  await context.routeWebSocket(url => url.hostname === '127.0.0.1' && url.searchParams.get('transport') === 'stream', socket => {
    const url = new URL(socket.url()), role = url.searchParams.get('role')!, session = url.searchParams.get('session')!;
    expect(url.searchParams.has('token')).toBe(false);
    const key = session + role, opposite = session + (role === 'sender' ? 'receiver' : 'sender'); streams.set(key, socket);
    socket.onMessage(data => {
      if (typeof data === 'string') { expect(JSON.parse(data).type).toBe('credit'); return; }
      ciphertextFrames++; expect(data.includes(Buffer.from('generated-original-video.mp4'))).toBe(false); streams.get(opposite)?.send(data);
    });
    if (streams.has(opposite)) for (const peer of [socket, streams.get(opposite)!]) peer.send(JSON.stringify({ type: 'stream-ready' }));
  });
  await context.addInitScript(({ blocked }) => {
    if (blocked) {
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        setRemoteDescription(description: RTCSessionDescriptionInit) { return super.setRemoteDescription({ ...description, sdp: description.sdp?.replace(/^a=candidate:.*\r?\n/gm, '') }); }
        addIceCandidate() { return Promise.resolve(); }
      } as typeof RTCPeerConnection;
    }
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      const channel = this as any, now = performance.now();
      channel.__fixtureAt = Math.max(channel.__fixtureAt || 0, now);
      if (!blocked && data instanceof ArrayBuffer) channel.__fixtureAt += data.byteLength * 1000 / 32768;
      const delay = channel.__fixtureAt - now;
      if (delay > 0) { setTimeout(() => { if (this.readyState === 'open') send.call(this, data); }, delay); return; }
      return send.call(this, data);
    } as any;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  }, { blocked });
  const receiver = await context.newPage(); for (const current of [page, receiver]) current.on('pageerror', error => errors.push(error.message));
  const buffer = Buffer.alloc(8 * 1048576 + 17); for (let i = 0; i < buffer.length; i++) buffer[i] = i % 251;
  const instrument = async (current: typeof page) => current.evaluate(async () => {
    const { StreamFallback } = await import('/src/stream-fallback.ts');
    const { Transfer } = await import('/src/protocol.ts');
    const state = window as any; state.__streamTrace = [];
    const log = (entry: any) => { state.__streamTrace.push(entry); if (state.__streamTrace.length > 100) state.__streamTrace.shift(); };
    for (const name of ['handle', 'abort', 'restore'] as const) {
      const original = (StreamFallback.prototype as any)[name];
      (StreamFallback.prototype as any)[name] = function(...args: any[]) {
        log({ action: name, type: args[0]?.type, epoch: args[0]?.epoch, current: this.hooks.epoch(), active: this.active, busy: this.busy });
        return original.apply(this, args);
      };
    }
    for (const name of ['handle', 'replaceTransportNow', 'fail'] as const) {
      const original = (Transfer.prototype as any)[name];
      (Transfer.prototype as any)[name] = function(...args: any[]) {
        if (name !== 'handle' || typeof args[0] === 'string') {
          let message; try { message = JSON.parse(args[0]); } catch {}
          log({ action: name, generation: this.generation, mode: name === 'replaceTransportNow' ? args[0]?.constructor.name || 'webrtc' : undefined,
            type: message?.type, offset: message?.offset, bytes: message?.bytes, failure: name === 'fail' ? args[0] : undefined });
        }
        return original.apply(this, args);
      };
    }
  });
  await page.goto('./'); await instrument(page); await page.locator('#file-input').setInputFiles({ name: 'generated-original-video.mp4', mimeType: 'video/mp4', buffer });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  await receiver.goto(await page.locator('#share-link').inputValue()); await expect(receiver.locator('#accept-files')).toBeVisible({ timeout: 60000 });
  await instrument(receiver); if (!blocked) expect(streamTickets).toBe(0); await receiver.locator('#accept-files').click();
  try {
    await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备', { timeout: 100000 });
    await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
    await expect(receiver.locator('#connection-path')).toContainText('加密服务器转发');
    await expect(receiver.locator('#connection-path')).toContainText('AES-GCM');
    const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click(); const download = await pending;
    expect(download.suggestedFilename()).toBe('generated-original-video.mp4');
    expect(createHash('sha256').update(await readFile((await download.path())!)).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'));
    expect(streamTickets).toBe(2); expect(relayTickets).toBe(0); expect(ciphertextFrames).toBeGreaterThan(8); expect(errors).toEqual([]);
  } catch (error) {
    console.log('SAFE_STREAM_FIXTURE', JSON.stringify({ streamTickets, relayTickets, ciphertextFrames, errors,
      sender: await page.evaluate(() => (window as any).__streamTrace), receiver: await receiver.evaluate(() => (window as any).__streamTrace) }));
    throw error;
  } finally { await page.locator('#cancel').click(); }
});

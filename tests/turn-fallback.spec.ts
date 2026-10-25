import { test, expect } from './fixtures';
import { TurnFallbackPolicy, turnCredentials, readTurnCredentials } from '../src/turn-fallback';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

for (const scenario of [
  { name: 'slow with short ETA stays direct', speed: 64 * 1024, seconds: 60, expected: false },
  { name: 'fast with long ETA stays direct', speed: 8 * 1048576, seconds: 1800, expected: false },
  { name: 'slow and long ETA becomes eligible after sustained observation', speed: 30 * 1024, seconds: 1800, expected: true },
  { name: 'zero progress remains eligible even when control messages arrive', speed: 0, seconds: 1800, expected: true }
]) test(scenario.name, () => {
  const policy = new TurnFallbackPolicy(), total = Math.max(1048576, scenario.speed * scenario.seconds);
  for (let ms = 0; ms <= 16000; ms += 2000) expect(policy.update(ms, scenario.speed * ms / 1000, total, true)).toBe(false);
  expect(policy.update(18000, scenario.speed * 18, total, true)).toBe(scenario.expected);
});
test('one slow sample, backgrounding, rollback and suspension cannot trigger a switch', () => {
  const policy = new TurnFallbackPolicy();
  for (let i = 0; i <= 5; i++) expect(policy.update(i * 2000, i * 65536, 1e9, true)).toBe(false);
  expect(policy.update(12000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(14000, 12 * 1048576, 1e9, false)).toBe(false);
  expect(policy.update(16000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(80000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(82000, 0, 1e9, true)).toBe(false);
});
test('relay configuration rejects arbitrary destinations and invalid expiry', () => {
  const value = { iceServers: [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'test-user', credential: 'test-password' }], expiresAt: Date.now() + 3500000 };
  expect(turnCredentials(value)).toEqual(value);
  for (const urls of ['turn:evil.test:3478?transport=udp', 'https://turn.cloudflare.com/', 'turn:turn.cloudflare.com:53?transport=udp']) {
    expect(() => turnCredentials({ ...value, iceServers: [{ ...value.iceServers[0], urls }] })).toThrow();
  }
  expect(() => turnCredentials({ ...value, expiresAt: Date.now() - 1 })).toThrow();
});
test('oversized relay responses are rejected before JSON parsing', async () => {
  await expect(readTurnCredentials(new Response('a'.repeat(16385)))).rejects.toThrow('中继暂时不可用');
});
test('cancelling while credentials are in flight cannot restart the transfer', async ({ page }) => {
  await page.goto('./');
  expect(await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const transfer: any = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {});
    const pair: any = new AutoPair(transfer, await signalKey('a'.repeat(64)), () => {});
    let finish!: (value: any) => void;
    pair.signal.turn = () => new Promise(resolve => { finish = resolve; });
    const pending = pair.prepareRelay(), pc = transfer.pc;
    pair.close(); transfer.close(false);
    finish({ iceServers: [{ urls: 'turns:turn.cloudflare.com:443?transport=tcp', username: 'user', credential: 'temporary' }], expiresAt: Date.now() + 3500000 });
    await pending;
    return transfer.pc === pc && transfer.stopped && !transfer.relayServers;
  })).toBe(true);
});

test('relay control requires encrypted peer authentication; preparation failure preserves the direct connection', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {});
    const pair: any = new AutoPair(transfer, await signalKey('a'.repeat(64)), () => {}), original = transfer.pc;
    let requests = 0;
    pair.signal.turn = async () => { requests++; throw Error('upstream unavailable'); };
    for (const type of ['relay-request', 'relay-prepare', 'relay-ready']) await pair.handle({ type, epoch: 0 });
    const before = requests;
    await pair.handle({ type: 'relay-request', epoch: 0 }, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const state = { before, requests, unchanged: original === transfer.pc, recovering: transfer.recovering, stopped: transfer.stopped };
    pair.close(); transfer.close(false); return state;
  });
  expect(result).toEqual({ before: 0, requests: 1, unchanged: true, recovering: false, stopped: false });
});

test('monitor ignores short slow transfers and fast long transfers, then requests one qualified fallback', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const transfer: any = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'sender', () => {});
    const pair: any = new AutoPair(transfer, await signalKey('a'.repeat(64)), () => {});
    pair.offered = pair.relaySupported = true;
    Object.defineProperty(transfer.pc, 'connectionState', { value: 'connected' });
    transfer.channel = { readyState: 'open', close() {} };
    let requests = 0, state = { bytes: 0, total: 0, active: true, hidden: false };
    transfer.relayProgress = () => state;
    pair.signal.turn = async () => { requests++; throw Error('unavailable'); };
    const realNow = Date.now;
    for (const scenario of [{ speed: 64 * 1024, remaining: 60 }, { speed: 8 * 1048576, remaining: 1800 }, { speed: 30 * 1024, remaining: 1800 }]) {
      pair.relayPolicy.reset();
      for (let ms = 0; ms <= 20000; ms += 2000) {
        Date.now = () => 1e7 + ms;
        state = { bytes: scenario.speed * ms / 1000, total: scenario.speed * scenario.remaining, active: true, hidden: false };
        pair.monitorRelay();
      }
      if (scenario.remaining === 60 || scenario.speed > 1048576) {
        if (requests) throw Error('Unqualified fallback');
      }
    }
    Date.now = realNow;
    await new Promise(resolve => setTimeout(resolve, 0));
    pair.monitorRelay(); pair.close(); transfer.close(false); return requests;
  });
  expect(result).toBe(1);
});

for (const blocked of [false, true]) test(`authenticated fallback ${blocked ? 'connects after direct ICE failure' : 'resumes committed bytes after sustained low speed'} without changing file contents`, async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'Real data channel integration uses Chromium; policy/authentication run in both engines.');
  const requests: { auth: boolean; at: number }[] = [];
  await context.route('http://127.0.0.1:8787/rooms/**', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.type === 'turn') {
      requests.push({ auth: /^Bearer [a-f0-9]{64}$/.test(route.request().headers().authorization || ''), at: Date.now() });
      await route.fulfill({ json: { iceServers: [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'fixture-user', credential: 'fixture-password' }], expiresAt: Date.now() + 3500000 } });
    } else await route.fallback();
  });
  await context.addInitScript(blocked => {
    const state = window as any, Peer = RTCPeerConnection;
    state.__turnConfigurations = []; state.__fileStarts = []; state.__slowSource = !blocked;
    state.RTCPeerConnection = class extends Peer {
      private simulatedRelay: boolean;
      constructor(config: RTCConfiguration) {
        // This test exercises coordination/checkpoints with real DataChannels,
        // but substitutes local ICE for the external provider. Live relay is
        // verified separately with real short-lived credentials before release.
        state.__turnConfigurations.push(config.iceTransportPolicy || 'all');
        super(config.iceTransportPolicy === 'relay' ? { iceServers: [] } : config);
        this.simulatedRelay = config.iceTransportPolicy === 'relay';
        if (this.simulatedRelay) state.__slowSource = false;
      }
      setRemoteDescription(description: RTCSessionDescriptionInit) {
        return super.setRemoteDescription(blocked && !this.simulatedRelay ? { ...description, sdp: description.sdp?.replace(/^a=candidate:.*\r?\n/gm, '') } : description);
      }
      addIceCandidate(candidate?: RTCIceCandidateInit | null) { return blocked && !this.simulatedRelay ? Promise.resolve() : super.addIceCandidate(candidate); }
    };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (typeof data === 'string') { const message = JSON.parse(data); if (message.type === 'file-start') state.__fileStarts.push(message); }
      return send.call(this, data);
    } as any;
    const arrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function() {
      if (state.__slowSource && this.size <= 32768) await new Promise(resolve => setTimeout(resolve, 300));
      return arrayBuffer.call(this);
    };
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  }, blocked);
  const receiver = await context.newPage(), errors: string[] = [];
  for (const p of [page, receiver]) p.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  const buffer = Buffer.alloc(blocked ? 1048576 : 16 * 1048576);
  for (let i = 0; i < buffer.length; i++) buffer[i] = i % 251;
  await page.locator('#file-input').setInputFiles({ name: '原文件.dat', mimeType: 'application/octet-stream', buffer });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  expect(requests).toHaveLength(0);
  const began = Date.now();
  await receiver.goto(await page.locator('#share-link').inputValue());
  await expect(receiver.locator('#accept-files')).toBeVisible({ timeout: 50000 });
  await receiver.locator('#accept-files').click();
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。', { timeout: 60000 });
  expect(requests).toHaveLength(2); expect(requests.every(r => r.auth)).toBe(true);
  expect(requests[0].at - began).toBeGreaterThan(blocked ? 14000 : 16000);
  for (const p of [page, receiver]) expect(await p.evaluate(() => (window as any).__turnConfigurations)).toContain('relay');
  if (!blocked) expect(await page.evaluate(() => (window as any).__fileStarts.some((start: any) => start.offset > 0))).toBe(true);
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click(); const download = await pending;
  expect(download.suggestedFilename()).toBe('原文件.dat');
  expect(createHash('sha256').update(await readFile((await download.path())!)).digest('hex')).toBe(createHash('sha256').update(buffer).digest('hex'));
  expect(errors).toEqual([]); await page.locator('#cancel').click();
});

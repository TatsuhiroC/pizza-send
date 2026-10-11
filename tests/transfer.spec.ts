import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function setup(context: BrowserContext, signal = true) {
  const signalUrl = signal ? (process.env.TEST_SIGNAL_URL || 'http://127.0.0.1:8787') : '';
  await context.addInitScript(({ signalUrl }) => {
    const Original = RTCPeerConnection;
    (window as any).__pcs = [];
    (window as any).RTCPeerConnection = class extends Original { constructor(config: any) { super(config); (window as any).__pcs.push(this); } };
    localStorage.setItem('pizza-send-signal', signalUrl);
    localStorage.setItem('pizza-send-stun', '');
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  }, { signalUrl });
}
async function automatic(sender: Page, receiver: Page, payload: { name: string; mimeType: string; buffer: Buffer }[]) {
  await sender.goto('/');
  await sender.locator('#file-input').setInputFiles(payload);
  await sender.locator('#start-send').click();
  await expect(sender.locator('#share-box')).toBeVisible();
  const url = await sender.locator('#share-link').inputValue();
  await receiver.goto(url);
  try { await expect(receiver.locator('#accept-files')).toBeVisible(); }
  catch (e) {
    for (const [label, p] of [['sender', sender], ['receiver', receiver]] as const) {
      console.log(label, await p.evaluate(async () => Promise.all((window as any).__pcs.map(async (pc: RTCPeerConnection) => ({ state: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState, localCandidates: pc.localDescription?.sdp.split('\n').filter(l => l.startsWith('a=candidate:')), remoteCandidates: pc.remoteDescription?.sdp.split('\n').filter(l => l.startsWith('a=candidate:')), stats: Array.from((await pc.getStats()).values()).filter(s => ['candidate-pair', 'local-candidate', 'remote-candidate'].includes(s.type)) })))));
    }
    throw e;
  }
}
test('20 MB + empty + Chinese filename: automatic pairing, end-to-end SHA-256 and downloads', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  const errors: string[] = [];
  for (const p of [page, receiver]) p.on('pageerror', e => errors.push(e.message));
  const buffer = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < buffer.length; i++) buffer[i] = i % 251;
  const payload = [
    { name: '20MB-完整性.bin', mimeType: 'application/octet-stream', buffer },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    { name: '你好-披萨.txt', mimeType: 'text/plain', buffer: Buffer.from('你好，PizzaSend 🍕\n') }
  ];
  await automatic(page, receiver, payload);
  const started = Date.now();
  await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('传输完成，原样送达。');
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  const elapsed = Date.now() - started;
  for (const [i, file] of payload.entries()) {
    const downloaded = receiver.waitForEvent('download');
    await receiver.locator('.download-file').nth(i).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(file.name);
    expect(sha(await readFile((await download.path())!))).toBe(sha(file.buffer));
  }
  console.log('LOCAL_ONLY_20MB_SECONDS=' + (elapsed / 1000).toFixed(2) + ' (same-machine Chrome; not an internet benchmark)');
  expect(errors).toEqual([]);
});
test('manual pairing works without signaling', async ({ page, context }) => {
  await setup(context, false);
  const receiver = await context.newPage();
  const buffer = Buffer.from('manual connection, no signal server');
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'manual.txt', mimeType: 'text/plain', buffer });
  await page.locator('#start-send').click();
  await expect(page.locator('#pair-dialog')).toBeVisible();
  const offer = await page.locator('#outgoing-code').inputValue();
  await receiver.goto('/'); await receiver.locator('#receive-tab').click();
  await receiver.locator('#receive-code').fill(offer); await receiver.locator('#connect-receive').click();
  await expect(receiver.locator('#pair-dialog')).toBeVisible();
  const answer = await receiver.locator('#outgoing-code').inputValue();
  await page.locator('#answer-code').fill(answer); await page.locator('#apply-answer').click();
  await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('传输完成，原样送达。');
  const promise = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  expect(sha(await readFile((await (await promise).path())!))).toBe(sha(buffer));
});
test('checksum mismatch is rejected and never offered as a download', async ({ page, context }) => {
  await setup(context);
  await page.addInitScript(() => {
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (typeof data === 'string' && data.includes('"type":"file-end"')) {
        const message = JSON.parse(data); message.hash = '0'.repeat(64); data = JSON.stringify(message);
      }
      return send.call(this, data);
    } as any;
  });
  const receiver = await context.newPage();
  await automatic(page, receiver, [{ name: 'check.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024, 42) }]);
  await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#notice')).toContainText('完整性校验失败');
  await expect(receiver.locator('.download-file')).toHaveCount(0);
});
test('sender cancellation clears session and rejects further joins', async ({ page, context, request }) => {
  await setup(context);
  const receiver = await context.newPage();
  await automatic(page, receiver, [{ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('cancel') }]);
  await page.locator('#cancel').click();
  await expect(receiver.locator('#notice')).toContainText(/结束|关闭|取消/);
  await expect(page.locator('#start-send')).toBeEnabled();
  expect((await request.post('http://127.0.0.1:8787/rooms', { headers: { Origin: 'https://untrusted.example' } })).status()).toBe(403);
});
test('cancelling while room creation is pending does not restore the session', async ({ page, context }) => {
  test.setTimeout(20000);
  await setup(context);
  let release!: () => void;
  let requested = false;
  const gate = new Promise<void>(resolve => release = resolve);
  await page.route('**/rooms', async route => {
    requested = true;
    await gate;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ room: 'a'.repeat(64), sender: 'b'.repeat(64), receiver: 'c'.repeat(64) }), headers: { 'access-control-allow-origin': 'http://127.0.0.1:5173' } });
  });
  try {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('cancel') });
    await page.locator('#start-send').evaluate(button => (button as HTMLButtonElement).click());
    await expect.poll(() => requested, { timeout: 5000 }).toBe(true);
    await page.locator('#cancel').evaluate(button => (button as HTMLButtonElement).click());
    const response = page.waitForResponse(r => r.url().endsWith('/rooms'));
    release(); await response;
    await expect(page.locator('#start-send')).toBeEnabled();
    await expect(page.locator('#share-box')).toBeHidden();
    await expect(page.locator('#session-panel')).toBeHidden();
  } finally { release(); }
});
test('crypto envelopes reject tampering; manifest rejects invalid sizes; layout fits mobile', async ({ page, context }) => {
  await setup(context, false);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const p = await import('/src/protocol.ts');
    const key = await p.signalKey(p.randomToken());
    const packed = await p.seal(key, { type: 'offer', value: 'test' });
    const opened = await p.unseal(key, packed);
    let tampered = false, invalid = false;
    const changed = (packed[0] === 'A' ? 'B' : 'A') + packed.slice(1);
    try { await p.unseal(key, changed); } catch { tampered = true; }
    try { p.validateManifest([{ id: 0, name: 'x', size: -1, type: '' }]); } catch { invalid = true; }
    return { opened, tampered, invalid, safe: p.safeName('../x') };
  });
  expect(result.opened.value).toBe('test'); expect(result.tampered).toBe(true); expect(result.invalid).toBe(true); expect(result.safe).not.toContain('/');
  await mkdir('../../work/qa', { recursive: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.screenshot({ path: '../../work/qa/pizza-send-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '../../work/qa/pizza-send-mobile.png', fullPage: true });
});


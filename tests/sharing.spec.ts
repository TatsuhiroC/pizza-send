import { test, expect, chromium, type BrowserContext, type Page } from './fixtures';
import QRCode from 'qrcode';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

let quota = 1;
async function setup(context: BrowserContext, denyCamera = false) {
  // Isolate new test rooms from other tests' per-IP quota in the local Worker.
  const ip = `192.0.2.${quota++}`;
  await context.route('http://127.0.0.1:8787/rooms', route => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }));
  await context.addInitScript(({ denyCamera }) => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    const state = window as any, get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    state.__cameraCalls = 0; state.__cameraTracks = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints?.video) {
        state.__cameraCalls++;
        if (denyCamera) throw new DOMException('Denied in fixture', 'NotAllowedError');
      }
      const stream = await get(constraints);
      if (constraints?.video) state.__cameraTracks.push(...stream.getVideoTracks());
      return stream;
    };
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  }, { denyCamera });
}
const fixture = Buffer.from('Camera QR scan and compact sharing still deliver the original file.');
async function share(page: Page) {
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'scan.txt', mimeType: 'text/plain', buffer: fixture });
  await page.locator('#start-send').click();
  await expect(page.locator('#share-box')).toBeVisible();
  return page.locator('#share-link').inputValue();
}
async function verifyDownload(sender: Page, receiver: Page, expected = fixture) {
  await expect(receiver.locator('#accept-files')).toBeVisible();
  await receiver.locator('#accept-files').click();
  await expect(sender.locator('#status')).toHaveText('传输完成，原样送达。');
  const download = receiver.waitForEvent('download');
  await receiver.locator('.download-file').first().click();
  const file = await readFile((await (await download).path())!);
  expect(createHash('sha256').update(file).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
}

test('a second transfer shows a fresh QR and the same receiver camera connects to the new link', async ({ page, context }) => {
  await setup(context);
  const firstLink = await share(page), receiver = await context.newPage();
  await receiver.goto('./'); await receiver.locator('#receive-tab').click();
  // Feed the sender's actual displayed QR through video frames, keeping the
  // receiver page and scanner alive across both transfers.
  await receiver.evaluate(() => {
    const state = window as any;
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 480;
      canvas.getContext('2d')!.drawImage(state.__cameraImage, 0, 0, 480, 480);
      const stream = canvas.captureStream(5);
      state.__cameraCalls++; state.__cameraTracks.push(...stream.getVideoTracks());
      return stream;
    };
  });
  const scanDisplayedQR = async (link: string) => {
    const image = await page.locator('#share-qr').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
    await receiver.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      (window as any).__cameraImage = image;
    }, image);
    await receiver.locator('#open-scanner').click();
    await expect(receiver.locator('#receive-code')).toHaveValue(link);
    await expect(receiver.locator('#scan-dialog')).not.toBeVisible();
    await expect(receiver.locator('#accept-files')).toBeVisible();
  };
  await expect(page.locator('#share-qr')).toBeVisible();
  await scanDisplayedQR(firstLink);
  await verifyDownload(page, receiver);
  await page.locator('#cancel').click(); await receiver.locator('#cancel').click();
  await page.locator('.remove-file').click();
  const secondFile = Buffer.from('This is the second file, sent through a new QR invitation.');
  await page.locator('#file-input').setInputFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: secondFile });
  await page.locator('#start-send').click();
  await expect(page.locator('#share-box')).toBeVisible();
  const secondLink = await page.locator('#share-link').inputValue();
  expect(secondLink).not.toBe(firstLink);
  await expect(page.locator('#share-qr')).toBeVisible();
  await expect(page.locator('#share-qr')).toBeVisible();
  await scanDisplayedQR(secondLink);
  await expect(receiver.locator('#incoming-files')).toContainText('second.txt');
  await verifyDownload(page, receiver, secondFile);
  expect(await receiver.evaluate(() => (window as any).__cameraCalls)).toBe(2);
  expect(await receiver.evaluate(() => (window as any).__cameraTracks.map((track: MediaStreamTrack) => track.readyState))).toEqual(['ended', 'ended']);
  await expect(receiver.locator('#notice')).toBeHidden();
});

test('compact links retain a 256-bit secret, hide credentials from requests, and reject room overwrite', async ({ page, context }) => {
  await setup(context);
  let creation: any;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/rooms')) creation = request.postDataJSON(); });
  const link = await share(page), url = new URL(link);
  expect(url.hash).toMatch(/^#2\.[A-Za-z0-9_-]{43}$/);
  expect(url.search).toBe('');
  const result = await page.evaluate(async fragment => {
    const p = await import('/src/share.ts');
    const credentials = await p.parseShare(fragment);
    let malformedRejected = false;
    try { await p.parseShare(fragment.slice(0, -1)); } catch { malformedRejected = true; }
    const legacy = await p.parseShare('#r=' + credentials.room + '&t=' + credentials.receiver + '&k=' + credentials.secret);
    return { ...credentials, digest: await p.receiverDigest(credentials.receiver), canonical: '#' + p.shareFragment(credentials.secret), malformedRejected, legacyMatches: JSON.stringify(legacy) === JSON.stringify(credentials) };
  }, url.hash);
  expect(result.secret).toHaveLength(64);
  expect(result.canonical).toBe(url.hash);
  expect(result.malformedRejected).toBe(true); expect(result.legacyMatches).toBe(true);
  expect(creation).toEqual({ v: 2, room: result.room, receiverHash: result.digest, multi: true });
  expect(JSON.stringify(creation)).not.toContain(result.secret);
  expect(JSON.stringify(creation)).not.toContain(result.receiver);
  const oldLength = url.origin.length + url.pathname.length + 201;
  expect(link.length).toBeLessThan(oldLength * .4);
  const collision = await page.evaluate(async body => (await fetch('http://127.0.0.1:8787/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, creation);
  expect(collision).toBe(409);
  const receiver = await context.newPage();
  await receiver.goto(link);
  await verifyDownload(page, receiver);
});

test('old three-part share URLs remain usable with the original room API', async ({ page, context }) => {
  await setup(context);
  await page.goto('./');
  const oldLink = await page.evaluate(async () => {
    const p = await import('/src/protocol.ts');
    const session = await (await fetch('http://127.0.0.1:8787/rooms', { method: 'POST' })).json();
    const secret = p.randomToken();
    const transfer = new p.Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 268435456 }, 'sender', () => {});
    transfer.prepare([new File(['Legacy sharing still works.'], 'legacy.txt')]);
    const pair = new p.AutoPair(transfer, await p.signalKey(secret), () => {});
    await pair.connect('http://127.0.0.1:8787', session.room, 'sender', session.sender);
    (window as any).__legacyPair = pair;
    const url = new URL(location.href); url.hash = new URLSearchParams({ r: session.room, t: session.receiver, k: secret }).toString();
    return url.toString();
  });
  const receiver = await context.newPage();
  await receiver.goto(oldLink);
  await expect(receiver.locator('#accept-files')).toBeVisible();
  await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('传输完成，原样送达。');
  const download = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  expect((await readFile((await (await download).path())!)).toString()).toBe('Legacy sharing still works.');
  await page.evaluate(() => (window as any).__legacyPair.close());
});

test('QR screenshot fallback works after camera permission denial and rejects unknown websites', async ({ page, context }) => {
  await setup(context, true);
  const link = await share(page), receiver = await context.newPage();
  await receiver.goto('./'); await receiver.locator('#receive-tab').click();
  expect(await receiver.evaluate(() => (window as any).__cameraCalls)).toBe(0);
  await receiver.locator('#open-scanner').click();
  await expect(receiver.locator('#scan-status')).toContainText('未获得相机权限');
  await expect(receiver.locator('#scan-again')).toBeVisible();
  await receiver.locator('#qr-image-input').setInputFiles({ name: 'unknown.png', mimeType: 'image/png', buffer: await QRCode.toBuffer('https://unknown.example/') });
  await expect(receiver.locator('#scan-status')).toContainText('不是有效的 PizzaSend');
  await expect(receiver.locator('#scan-dialog')).toBeVisible();
  expect(new URL(receiver.url()).host).toBe('127.0.0.1:5173');
  await receiver.locator('#qr-image-input').setInputFiles({ name: 'share.png', mimeType: 'image/png', buffer: await QRCode.toBuffer(link, { width: 480, margin: 4 }) });
  await expect(receiver.locator('#scan-dialog')).not.toBeVisible();
  await verifyDownload(page, receiver);
});

test('camera button scans real video frames and stops the camera before pairing', async ({ page, context }) => {
  await setup(context);
  const link = await share(page), directory = await mkdtemp(join(tmpdir(), 'pizza-send-camera-'));
  const cameraFile = join(directory, 'qr.y4m');
  const qr = QRCode.create(link, { errorCorrectionLevel: 'M' }).modules, width = 640, height = 480;
  const frame = Buffer.alloc(width * height * 3 / 2, 128); frame.fill(235, 0, width * height);
  const scale = Math.floor(height / (qr.size + 8)), startX = Math.floor((width - qr.size * scale) / 2), startY = Math.floor((height - qr.size * scale) / 2);
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.get(y, x)) {
    for (let row = 0; row < scale; row++) frame.fill(16, (startY + y * scale + row) * width + startX + x * scale, (startY + y * scale + row) * width + startX + (x + 1) * scale);
  }
  await writeFile(cameraFile, Buffer.concat([Buffer.from('YUV4MPEG2 W640 H480 F5:1 Ip A1:1 C420jpeg\nFRAME\n'), frame]));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), args: [
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + cameraFile
  ] });
  try {
    const receiverContext = await browser.newContext({ acceptDownloads: true }); await setup(receiverContext);
    const receiver = await receiverContext.newPage(); await receiver.goto('http://127.0.0.1:5173/');
    await receiver.locator('#receive-tab').click(); await receiver.locator('#open-scanner').click();
    await expect(receiver.locator('#accept-files')).toBeVisible({ timeout: 30000 });
    await expect(receiver.locator('#scan-dialog')).not.toBeVisible();
    const cameras = await receiver.evaluate(() => ({ calls: (window as any).__cameraCalls, states: (window as any).__cameraTracks.map((track: MediaStreamTrack) => track.readyState), detached: (document.getElementById('scan-video') as HTMLVideoElement).srcObject === null }));
    expect(cameras.calls).toBe(1); expect(cameras.states).toEqual(['ended']); expect(cameras.detached).toBe(true);
    await verifyDownload(page, receiver);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test('closing a pending camera permission request releases a late stream and mobile UI stays within viewport', async ({ page, context }) => {
  await setup(context);
  await page.addInitScript(() => {
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), state = window as any;
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await get(constraints);
      if (constraints?.video) {
        state.__lateTracks = stream.getTracks();
        await new Promise<void>(resolve => state.__releaseCamera = resolve);
      }
      return stream;
    };
  });
  await page.goto('./'); await page.locator('#receive-tab').click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator('#open-scanner').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__releaseCamera)).toBe(true);
  await mkdir('../../work/qa', { recursive: true });
  await page.screenshot({ path: '../../work/qa/pizza-send-camera-mobile.png' });
  await page.locator('#close-scanner').click();
  await page.evaluate(() => (window as any).__releaseCamera());
  await expect.poll(() => page.evaluate(() => (window as any).__lateTracks.map((track: MediaStreamTrack) => track.readyState))).toEqual(['ended']);
  await expect(page.locator('#scan-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => (document.getElementById('scan-video') as HTMLVideoElement).srcObject === null)).toBe(true);
});

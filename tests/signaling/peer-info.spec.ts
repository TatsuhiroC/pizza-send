import { test, expect } from '../fixtures';
import { localPeerInfo, readPeerInfo } from '../../src/peer-info';

test('device labels cover phones, desktop-mode tablets and common browsers without identifying details', () => {
  const cases = [
    ['iPhone; CPU iPhone OS 18_0 like Mac OS X Version/18.0 Mobile/15E148 Safari/604.1', 5, 'phone', 'safari'],
    ['iPhone; CPU iPhone OS 18_0 like Mac OS X CriOS/130.0 Mobile/15E148 Safari/604.1', 5, 'phone', 'chrome'],
    ['Macintosh; Intel Mac OS X 10_15 Version/18.0 Safari/605.1.15', 5, 'tablet', 'safari'],
    ['iPad; CPU OS 18_0 Version/18.0 Mobile/15E148 Safari/604.1', 5, 'tablet', 'safari'],
    ['Macintosh; Intel Mac OS X 10_15 Chrome/130.0 Safari/537.36', 0, 'computer', 'chrome'],
    ['Windows NT 10.0 Chrome/130.0 Safari/537.36 Edg/130.0', 0, 'computer', 'edge'],
    ['Linux; Android 13 Chrome/130.0 Mobile Safari/537.36 SamsungBrowser/26.0', 5, 'phone', 'samsung'],
    ['Linux; Android 13 Chrome/130.0 Safari/537.36', 5, 'tablet', 'chrome'],
    ['iPhone FxiOS/130.0 Mobile Safari/604.1', 5, 'phone', 'firefox'],
    ['Windows NT 10.0 Chrome/130.0 Safari/537.36 OPR/115.0', 0, 'computer', 'opera'],
    ['', 0, 'unknown', 'unknown'],
  ] as const;
  for (const [userAgent, maxTouchPoints, device, browser] of cases) {
    expect(localPeerInfo({ userAgent, maxTouchPoints })).toEqual({ device, browser });
  }
});

test('peer labels accept only fixed values and discard extra fields from the peer', () => {
  for (const value of [undefined, null, [], 'Safari', { device: 'phone' }, { device: '<img src=x>', browser: 'safari' }, { device: 'phone', browser: 'Safari<script>' }]) expect(readPeerInfo(value)).toBeUndefined();
  expect(readPeerInfo({ device: 'phone', browser: 'safari', userAgent: 'private', name: 'private' })).toEqual({ device: 'phone', browser: 'safari' });
});

test('two recipients keep their own encrypted labels through reconnect, language changes and completion', async ({ page, context, browserName }, info) => {
  test.skip(browserName === 'webkit', 'Real data-channel delivery runs in Chromium; parsing and authentication are covered in WebKit.');
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    const Native = RTCPeerConnection;
    (window as any).__peers = [];
    (window as any).RTCPeerConnection = class extends Native {
      constructor(config: RTCConfiguration) { super(config); (window as any).__peers.push(this); }
    };
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
  const phone = await context.newPage(), computer = await context.newPage();
  await phone.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'iPhone; CPU iPhone OS 18_0 Version/18.0 Mobile/15E148 Safari/604.1' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 });
  });
  await computer.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Macintosh; Intel Mac OS X 10_15 Chrome/130.0 Safari/537.36' });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0 });
  });
  const frames: string[] = [];
  phone.on('websocket', socket => socket.on('framesent', event => { if (typeof event.payload === 'string') frames.push(event.payload); }));
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'device-label.txt', mimeType: 'text/plain', buffer: Buffer.from('Original file, independently labeled recipients.') });
  await page.locator('#start-send').click();
  await expect(page.locator('#share-box')).toBeVisible();
  const link = await page.locator('#share-link').inputValue();
  await phone.goto(link); await expect(phone.locator('#accept-files')).toBeVisible();
  await computer.goto(link); await expect(computer.locator('#accept-files')).toBeVisible();
  const rows = page.locator('.recipient-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.recipient-device')).toHaveText('手机 · Safari');
  await expect(rows.nth(1).locator('.recipient-device')).toHaveText('电脑 · Chrome');
  await phone.evaluate(() => (window as any).__peers.at(-1).close());
  await expect.poll(() => phone.evaluate(() => (window as any).__peers.length)).toBeGreaterThan(1);
  await expect(rows.nth(0).locator('.recipient-device')).toHaveText('手机 · Safari');
  await expect(rows).toHaveCount(2);
  await page.locator('#language-toggle').click();
  await expect(rows.nth(0).locator('.recipient-device')).toHaveText('Phone · Safari');
  await expect(rows.nth(1).locator('.recipient-device')).toHaveText('Computer · Chrome');
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await rows.nth(0).locator('.recipient-device').evaluate(element => element.clientHeight)).toBeLessThan(20);
  await rows.nth(0).screenshot({ path: info.outputPath('recipient-phone-english.png') });
  expect(frames.some(frame => frame.includes('"type":"signal"'))).toBe(true);
  expect(frames.some(frame => /peerInfo|iPhone|Safari/.test(frame))).toBe(false);
  await phone.locator('#accept-files').click(); await computer.locator('#accept-files').click();
  await expect(rows.locator('.recipient-message')).toHaveText(['Transfer complete. Every byte intact.', 'Transfer complete. Every byte intact.']);
  for (const receiver of [phone, computer]) {
    const original = await receiver.locator('.download-file').evaluate(async (link: HTMLAnchorElement) => (await fetch(link.href)).text());
    expect(original).toBe('Original file, independently labeled recipients.');
  }
  await expect(rows.nth(0).locator('.recipient-device')).toHaveText('Phone · Safari');
  await page.locator('#cancel').click();
});

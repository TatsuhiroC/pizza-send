import { test, expect, type Page } from '../fixtures';
import { shareFragment } from '../../src/share';

const settings = { signalUrl: 'http://127.0.0.1:8787', iceServers: [], memoryLimitBytes: 268435456 };
const file = { name: 'startup.txt', mimeType: 'text/plain', buffer: Buffer.from('Configuration must be ready before choosing a pairing mode.') };
async function holdConfig(page: Page) {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), blocked = new Promise<void>(resolve => entered = resolve);
  await page.route('**/app.config.json', async route => {
    entered(); await gate; await route.fulfill({ json: settings }).catch(() => {});
  });
  return { release, blocked };
}

test('pending configuration prevents an early sender from falling into manual pairing', async ({ page }) => {
  const held = await holdConfig(page);
  try {
    await page.goto('./', { waitUntil: 'domcontentloaded' }); await held.blocked;
    await page.locator('#file-input').setInputFiles(file);
    await expect(page.locator('#start-send')).toBeDisabled({ timeout: 1000 });
    await expect(page.locator('#start-send-label')).toHaveText('正在加载连接配置…');
    await expect(page.locator('#pair-dialog')).toBeHidden();
    await page.locator('#receive-tab').click();
    await expect(page.locator('#connect-receive')).toBeEnabled();
    await expect(page.locator('#open-scanner')).toBeEnabled();
    await page.locator('#send-tab').click(); held.release();
    await expect(page.locator('#start-send')).toBeEnabled();
    await page.locator('#start-send').click();
    await expect(page.locator('#share-qr')).toBeVisible();
    await expect(page.locator('#pair-dialog')).toBeHidden();
  } finally { held.release(); await page.evaluate(() => document.getElementById('cancel')?.click()).catch(() => {}); }
});

test('an incoming invitation shows configuration progress before connecting once', async ({ page }) => {
  const held = await holdConfig(page); let requests = 0;
  await page.route(settings.signalUrl + '/rooms/**', async route => { requests++; await route.fulfill({ status: 503, body: 'Fixture unavailable' }); });
  try {
    await page.goto('./#' + shareFragment('11'.repeat(32)), { waitUntil: 'domcontentloaded' }); await held.blocked;
    await expect(page.locator('#status')).toHaveText('正在加载连接配置…');
    expect(requests).toBe(0); held.release();
    await expect.poll(() => requests).toBe(1);
    await expect(page.locator('#status')).toHaveText('连接未完成');
    expect(requests).toBe(1);
  } finally { held.release(); }
});

test('configuration has a deadline and retry preserves selection while ignoring a late old response', async ({ page }) => {
  await page.clock.install();
  let release!: () => void, requests = 0;
  const gate = new Promise<void>(resolve => release = resolve);
  await page.route('**/app.config.json', async route => {
    if (++requests === 1) { await gate; await route.fulfill({ json: { ...settings, signalUrl: 'https://stale.invalid' } }).catch(() => {}); }
    else await route.fulfill({ json: settings });
  });
  try {
    await page.goto('./'); await page.locator('#file-input').setInputFiles(file);
    await page.clock.fastForward(8100);
    await expect(page.locator('#retry-config')).toBeVisible();
    await expect(page.locator('#notice')).toContainText('连接配置加载失败');
    await expect(page.locator('#start-send')).toBeDisabled();
    await page.locator('#retry-config').click();
    await expect(page.locator('#start-send')).toBeEnabled();
    await expect(page.locator('#files')).toContainText(file.name);
    release();
    await expect(page.locator('#signal-url')).toHaveValue(settings.signalUrl);
    await expect(page.locator('#retry-config')).toBeHidden();
    expect(requests).toBe(2);
  } finally { release(); }
});

test('editing an invitation during configuration loading prevents the original link from connecting later', async ({ page }) => {
  const held = await holdConfig(page); let requests = 0;
  await page.route(settings.signalUrl + '/rooms/**', async route => { requests++; await route.fulfill({ status: 503, body: 'Fixture unavailable' }); });
  try {
    await page.goto('./#' + shareFragment('11'.repeat(32)), { waitUntil: 'domcontentloaded' }); await held.blocked;
    const replacement = new URL(page.url()); replacement.hash = shareFragment('22'.repeat(32));
    await page.locator('#receive-code').fill(replacement.toString()); held.release();
    await expect(page.locator('#connect-receive')).toBeEnabled();
    await expect(page.locator('#session-panel')).toBeHidden();
    expect(requests).toBe(0);
    await page.locator('#connect-receive').click();
    await expect.poll(() => requests).toBe(1);
  } finally { held.release(); }
});

for (const failure of ['unavailable', 'invalid-json']) test(`configuration ${failure} does not silently enable manual pairing`, async ({ page }) => {
  await page.route('**/app.config.json', route => route.fulfill(failure === 'unavailable' ? { status: 503, body: 'Fixture unavailable' } : { status: 200, contentType: 'application/json', body: '{invalid' }));
  await page.goto('./'); await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#retry-config')).toBeVisible();
  await expect(page.locator('#start-send')).toBeDisabled();
  await expect(page.locator('#pair-dialog')).toBeHidden();
  await page.locator('#language-toggle').click();
  await expect(page.locator('#notice')).toContainText('Connection settings could not be loaded');
  await expect(page.locator('#retry-config')).toHaveText('Retry loading connection settings');
});

test('retrying configuration resumes the original receiver invitation without another scan', async ({ page }) => {
  let loads = 0, connections = 0;
  await page.route('**/app.config.json', route => ++loads === 1 ? route.fulfill({ status: 503 }) : route.fulfill({ json: settings }));
  await page.route(settings.signalUrl + '/rooms/**', async route => { connections++; await route.fulfill({ status: 503, body: 'Fixture unavailable' }); });
  await page.goto('./#' + shareFragment('22'.repeat(32)));
  await expect(page.locator('#retry-config')).toBeVisible();
  expect(connections).toBe(0);
  await page.locator('#retry-config').click();
  await expect.poll(() => connections).toBe(1);
  await expect(page.locator('#status')).toHaveText('连接未完成');
  expect(loads).toBe(2);
});

for (const choice of ['custom', 'manual']) test(`explicit saved ${choice} settings remain usable if the shared configuration is unavailable`, async ({ page }) => {
  await page.addInitScript(value => { localStorage.setItem('pizza-send-signal', value); localStorage.setItem('pizza-send-stun', ''); }, choice === 'custom' ? settings.signalUrl : '');
  await page.route('**/app.config.json', route => route.fulfill({ status: 503 }));
  await page.goto('./'); await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#start-send')).toBeEnabled();
  await expect(page.locator('#retry-config')).toBeHidden();
  await page.locator('#start-send').click();
  if (choice === 'manual') await expect(page.locator('#pair-dialog')).toBeVisible();
  else await expect(page.locator('#share-qr')).toBeVisible();
  await page.evaluate(() => document.getElementById('cancel')?.click());
});

test('saving an explicit manual choice recovers from a configuration failure', async ({ page }) => {
  await page.route('**/app.config.json', route => route.fulfill({ status: 503 }));
  await page.goto('./'); await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#retry-config')).toBeVisible();
  await page.locator('.settings > summary').click();
  await page.locator('#signal-url').fill(''); await page.locator('#stun-url').fill('');
  await page.locator('#save-settings').click();
  await expect(page.locator('#retry-config')).toBeHidden();
  await expect(page.locator('#start-send')).toBeEnabled();
  await page.locator('#start-send').click(); await expect(page.locator('#pair-dialog')).toBeVisible();
  await page.evaluate(() => document.getElementById('cancel')?.click());
});

test('clearing a selection cancels its pending source check before the native read returns', async ({ page }) => {
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function() {
      if (!(window as any).__holdCheck) return read.call(this);
      return new Promise(resolve => { (window as any).__lateCheck = resolve; });
    };
  });
  await page.goto('./'); await page.locator('#file-input').setInputFiles(file);
  await page.evaluate(() => { (window as any).__holdCheck = true; });
  await page.locator('#start-send').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__lateCheck)).toBe('function');
  await page.locator('#clear-files').click();
  await page.evaluate(() => { (window as any).__holdCheck = false; });
  await page.locator('#file-input').setInputFiles({ ...file, name: 'replacement.txt' });
  await expect(page.locator('#start-send')).toBeEnabled({ timeout: 1000 });
  await page.evaluate(() => (window as any).__lateCheck(new ArrayBuffer(1)));
  await expect(page.locator('#files')).toContainText('replacement.txt');
  await expect(page.locator('#notice')).toBeHidden();
  await expect(page.locator('#session-panel')).toBeHidden();
});

test('a saved manual preference is usable while the default configuration is still pending', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('pizza-send-signal', ''); localStorage.setItem('pizza-send-stun', ''); });
  const held = await holdConfig(page);
  try {
    await page.goto('./', { waitUntil: 'domcontentloaded' }); await held.blocked;
    await page.locator('#file-input').setInputFiles(file);
    await expect(page.locator('#start-send')).toBeEnabled();
    await page.locator('#start-send').click(); await expect(page.locator('#pair-dialog')).toBeVisible();
  } finally { held.release(); await page.evaluate(() => document.getElementById('cancel')?.click()); }
});
test('scanning and manual invitations remain usable after the default configuration fails', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pizza-send-stun', ''));
  await page.route('**/app.config.json', route => route.fulfill({ status: 503 }));
  await page.goto('./'); await page.locator('#receive-tab').click();
  await expect(page.locator('#open-scanner')).toBeEnabled();
  const offer = await page.evaluate(async () => {
    const { packDescription } = await import('/src/protocol.ts');
    const pc = new RTCPeerConnection({ iceServers: [] }); pc.createDataChannel('generated');
    try { return await packDescription(await pc.createOffer()); } finally { pc.close(); }
  });
  await page.locator('#receive-code').fill(offer); await page.locator('#connect-receive').click();
  await expect(page.locator('#pair-dialog')).toBeVisible(); await page.evaluate(() => document.getElementById('cancel')?.click());
});
test('saving a manual choice during config loading ignores the late default and preserves the selection', async ({ page }) => {
  const held = await holdConfig(page);
  try {
    await page.goto('./', { waitUntil: 'domcontentloaded' }); await held.blocked;
    await page.locator('#file-input').setInputFiles(file);
    await page.locator('.settings > summary').click();
    await page.locator('#signal-url').fill(''); await page.locator('#stun-url').fill('');
    await page.locator('#save-settings').click();
    await expect(page.locator('#start-send')).toBeEnabled(); held.release();
    await expect(page.locator('#signal-url')).toHaveValue('');
    await page.locator('#start-send').click(); await expect(page.locator('#pair-dialog')).toBeVisible();
  } finally { held.release(); await page.evaluate(() => document.getElementById('cancel')?.click()); }
});

test('an incoming manual QR link does not wait for the shared configuration', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pizza-send-stun', ''));
  const held = await holdConfig(page);
  try {
    await page.goto('./', { waitUntil: 'domcontentloaded' }); await held.blocked;
    const code = await page.evaluate(async () => {
      const { packDescription } = await import('/src/protocol.ts');
      const pc = new RTCPeerConnection({ iceServers: [] }); pc.createDataChannel('generated');
      try { return await packDescription(await pc.createOffer()); } finally { pc.close(); }
    });
    await page.goto('about:blank');
    await page.goto('./#' + new URLSearchParams({ offer: code }), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#pair-dialog')).toBeVisible({ timeout: 4000 });
  } finally { held.release(); await page.evaluate(() => document.getElementById('cancel')?.click()); }
});
for (const bad of [{ signalUrl: settings.signalUrl, memoryLimitBytes: -1 }, { signalUrl: settings.signalUrl, iceServers: [{ urls: 'turn:retired.invalid:3478' }] }]) test('invalid limits or retired relay configuration fail safely: ' + Object.keys(bad)[1], async ({ page }) => {
  await page.route('**/app.config.json', route => route.fulfill({ json: bad }));
  await page.goto('./'); await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#retry-config')).toBeVisible(); await expect(page.locator('#start-send')).toBeDisabled();
  await page.locator('#receive-tab').click(); await expect(page.locator('#open-scanner')).toBeEnabled();
});
test('loading configuration cannot enable a browser without secure cryptography', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window.crypto, 'subtle', { configurable: true, value: undefined }));
  await page.goto('./'); await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#start-send')).toBeDisabled(); await expect(page.locator('#notice')).toContainText('缺少安全传输能力');
});

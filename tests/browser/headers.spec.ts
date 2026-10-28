import { test, expect } from '../fixtures';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { shareFragment } from '../../src/share';

const site = process.env.HEADER_TEST_URL || 'http://127.0.0.1:4173/';
const signal = process.env.HEADER_TEST_SIGNAL_URL || 'http://127.0.0.1:8789';
// Exercise actual HTTP responses from Vite preview with Pages global headers.
// The production mode checks Cloudflare directly without mocking static files.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(signal => {
    localStorage.setItem('pizza-send-signal', signal);
    (window as any).__policyViolations = [];
    document.addEventListener('securitypolicyviolation', event => (window as any).__policyViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
  }, signal);
});

test('built page loads under CSP while inline and untrusted external scripts are blocked', async ({ page }) => {
  let externalRequests = 0;
  await page.route('https://csp-probe.invalid/**', route => { externalRequests++; return route.abort(); });
  const probe = new URL('__csp_execution_probe.js', site).toString();
  // Script loaded by the page has normal CSP privileges. DevTools evaluation
  // itself may bypass string-execution restrictions, even with bypassCSP off.
  await page.route(probe, route => route.fulfill({ contentType: 'text/javascript', body: `
    (async () => {
      try {
        const module = await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
        window.__wasmAllowed = (await WebAssembly.instantiate(module)) instanceof WebAssembly.Instance;
      } catch { window.__wasmAllowed = false; }
      try { new Function('window.__injectedEvalRan = true')(); }
      catch { window.__evalBlocked = true; }
      window.__executionProbeDone = true;
    })();
  ` }));
  const response = await page.goto(site);
  expect(response!.headers()['x-frame-options']).toBe('DENY');
  expect(response!.headers()['referrer-policy']).toBe('no-referrer');
  expect(response!.headers()['x-content-type-options']).toBe('nosniff');
  if (new URL(site).hostname === 'pizzasend.dpdns.org') expect(response!.headers()['strict-transport-security']).toBe('max-age=86400');
  await expect(page.locator('#send-tab')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__policyViolations)).toEqual([]);
  await page.evaluate(probe => {
    const script = document.createElement('script'); script.src = probe; document.head.append(script);
  }, probe);
  await expect.poll(() => page.evaluate(() => (window as any).__executionProbeDone)).toBe(true);
  expect(await page.evaluate(() => (window as any).__wasmAllowed)).toBe(true);
  expect(await page.evaluate(() => (window as any).__evalBlocked)).toBe(true);
  await page.evaluate(() => {
    const inline = document.createElement('script'); inline.textContent = 'window.__injectedScriptRan = true'; document.head.append(inline);
    const external = document.createElement('script'); external.src = 'https://csp-probe.invalid/blocked.js'; document.head.append(external);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__policyViolations.length)).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => (window as any).__injectedScriptRan)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__injectedEvalRan)).toBeUndefined();
  expect(externalRequests).toBe(0);
});

test('a parent page cannot embed the application even from the same origin', async ({ page }) => {
  let blockedByPolicy = false;
  page.on('console', message => { if (/frame-ancestors|x-frame-options/i.test(message.text())) blockedByPolicy = true; });
  const parent = new URL('__header-test-parent', site).toString();
  await page.route(parent, route => route.fulfill({ contentType: 'text/html', body: `<iframe id="embedded" src="${site}" onload="window.frameLoaded=true"></iframe>` }));
  await page.goto(parent);
  await expect.poll(() => page.evaluate(() => (window as any).frameLoaded)).toBe(true);
  await expect.poll(() => blockedByPolicy).toBe(true);
  expect(await page.locator('#embedded').evaluate(frame => {
    try { return !!(frame as HTMLIFrameElement).contentDocument?.getElementById('app'); } catch { return false; }
  })).toBe(false);
});

test('disk worker, pairing, blob preparation and original downloads work with the production policy', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real WebRTC transfer is covered in Chromium; WebKit checks policy and challenge compatibility.');
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    (window as any).__wasmInstances = 0;
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = (async (...args: any[]) => {
      const instance = await (instantiate as any)(...args);
      (window as any).__wasmInstances++; return instance;
    }) as typeof WebAssembly.instantiate;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
  const network: unknown[] = [];
  page.on('requestfailed', request => network.push({ method: request.method(), origin: new URL(request.url()).origin, failure: request.failure()?.errorText }));
  page.on('response', response => { if (new URL(response.url()).pathname === '/rooms') network.push({ status: response.status(), allowed: response.headers()['access-control-allow-origin'] }); });
  page.on('console', message => { if (message.type() === 'error') network.push({ error: message.text().replace(/https?:\/\/[^\s'"]+/g, '[URL]') }); });
  const receiver = await context.newPage();
  const payload = [{ name: '安全头-原文件.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024 * 1024, 81) }, { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }];
  await page.goto(site); await page.locator('#file-input').setInputFiles(payload); await page.locator('#start-send').click();
  try { await expect(page.locator('#share-box')).toBeVisible(); }
  catch (error) {
    console.log('CSP network', network);
    console.log('CSP transfer startup', await page.evaluate(() => ({
      notice: document.getElementById('notice')?.textContent,
      violations: (window as any).__policyViolations.map((v: any) => ({ directive: v.directive, blocked: (() => { try { return new URL(v.blocked).origin; } catch { return v.blocked; } })() }))
    })));
    throw error;
  }
  await receiver.goto(await page.locator('#share-link').inputValue());
  await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  for (const [index, original] of [...payload].reverse().entries()) {
    const download = receiver.waitForEvent('download'); await receiver.locator('.download-file').nth(index).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe(original.name);
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(digest(await readFile((await saved.path())!))).toBe(digest(original.buffer));
  }
  for (const p of [page, receiver]) {
    expect(await p.evaluate(() => (window as any).__policyViolations)).toEqual([]);
    expect(await p.evaluate(() => (window as any).__wasmInstances)).toBe(p === receiver ? payload.length : 0);
  }
  await page.locator('#cancel').click();
});

test('on-demand Turnstile script and frame remain allowed without contacting a real challenge', async ({ page }) => {
  await page.route(signal + '/rooms', route => route.fulfill({ status: 428, json: { siteKey: 'fixture-public-site-key' }, headers: { 'access-control-allow-origin': new URL(site).origin } }));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => route.fulfill({ contentType: 'text/javascript', body: `window.turnstile={render:(node)=>{const frame=document.createElement('iframe');frame.src='https://challenges.cloudflare.com/fixture';frame.title='Test challenge';node.append(frame);return 'fixture'},remove:()=>{}};` }));
  await page.route('https://challenges.cloudflare.com/fixture', route => route.fulfill({ contentType: 'text/html', body: '<p>Local challenge fixture</p>' }));
  await page.goto(site); await page.locator('#file-input').setInputFiles({ name: 'challenge.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
  await page.locator('#start-send').click();
  await expect(page.frameLocator('iframe[title="Test challenge"]').getByText('Local challenge fixture')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__policyViolations)).toEqual([]);
  await page.locator('#cancel-verification').click(); await expect(page.locator('#verification-dialog')).toBeHidden();
});

test('QR image scanning can read a blob and load the decoder under CSP', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Fixture camera denied', 'NotAllowedError'); }; });
  await page.route(signal + '/rooms/**', route => route.fulfill({ status: 410, json: { error: 'Ended' }, headers: { 'access-control-allow-origin': new URL(site).origin } }));
  const link = site + '#' + shareFragment('11'.repeat(32));
  await page.goto(site); await page.locator('#receive-tab').click(); await page.locator('#open-scanner').click();
  await page.locator('#qr-image-input').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: await QRCode.toBuffer(link, { width: 480, margin: 4 }) });
  await expect(page.locator('#scan-success')).toBeVisible();
  await expect(page.locator('#scan-dialog')).toBeHidden();
  await expect(page.locator('#status')).toHaveText('连接未完成');
  expect(await page.evaluate(() => (window as any).__policyViolations)).toEqual([]);
});

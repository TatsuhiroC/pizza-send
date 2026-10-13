import { test, expect, type BrowserContext, type Page } from './fixtures';
import { readFile } from 'node:fs/promises';

async function setup(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
}
async function share(page: Page) {
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({ name: 'review.txt', mimeType: 'text/plain', buffer: Buffer.from('a verified new transfer') });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  return page.locator('#share-link').inputValue();
}
for (const kind of ['AbortError', 'TimeoutError']) for (const role of ['sender', 'receiver']) test(`a ${role} pairing request interrupted by ${kind} reports a connection failure and can be retried`, async ({ page, context }) => {
  await setup(context);
  const target = role === 'receiver' ? await context.newPage() : page;
  const originalLink = role === 'receiver' ? await share(page) : '';
  await target.addInitScript(kind => {
    const fetch = window.fetch.bind(window);
    (window as any).__abortPairing = true;
    window.fetch = (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if ((window as any).__abortPairing && url.pathname.startsWith('/rooms')) return Promise.reject(new DOMException('Pairing request interrupted in fixture', kind));
      return fetch(input, options);
    };
  }, kind);
  await target.goto('./'); await expect(target.locator('#signal-url')).toHaveValue('http://127.0.0.1:8787');
  if (role === 'sender') {
    await target.locator('#file-input').setInputFiles({ name: 'review.txt', mimeType: 'text/plain', buffer: Buffer.from('a verified new transfer') });
    await target.locator('#start-send').click();
  } else {
    await target.locator('#receive-tab').click(); await target.locator('#receive-code').fill(originalLink);
    await target.locator('#connect-receive').click();
  }
  await expect(target.locator('#notice')).toContainText(kind === 'AbortError' ? '操作已中断' : '操作超时');
  await expect(target.locator('#status')).toHaveText('连接未完成');
  await expect(target.locator('#toast')).toBeHidden();
  await target.locator('#language-toggle').click();
  await expect(target.locator('#notice')).toContainText(kind === 'AbortError' ? 'Operation interrupted' : 'Operation timed out');
  await expect(target.locator('#status')).toHaveText('Connection failed');
  await target.locator('#language-toggle').click();
  await target.evaluate(() => { (window as any).__abortPairing = false; });
  let receiver = target;
  if (role === 'sender') {
    await target.locator('#start-send').click(); await expect(target.locator('#share-box')).toBeVisible();
    receiver = await context.newPage(); await receiver.goto(await target.locator('#share-link').inputValue());
  } else await target.locator('#connect-receive').click();
  await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const downloaded = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  expect((await readFile((await (await downloaded).path())!)).toString()).toBe('a verified new transfer');
});

for (const cancellation of [false, true]) test(`a late ${cancellation ? 'cancelled' : 'failed'} save cannot affect a new receiving session`, async ({ page, context }) => {
  await setup(context); const link = await share(page), receiver = await context.newPage();
  await receiver.addInitScript(() => {
    const state = window as any; state.__saveChoices = [];
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: () => new Promise((resolve, reject) => state.__saveChoices.push({ resolve, reject })) });
  });
  await receiver.goto(link); await expect(receiver.locator('#accept-files')).toBeVisible();
  await receiver.locator('#accept-files').click(); await expect(receiver.locator('#accept-files')).toBeDisabled();
  await receiver.locator('#cancel').click();
  await receiver.locator('#receive-code').fill(link); await receiver.locator('#connect-receive').click();
  await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect.poll(() => receiver.evaluate(() => (window as any).__saveChoices.length)).toBe(2);
  await receiver.evaluate(cancellation => {
    (window as any).__saveChoices[0].reject(cancellation ? new DOMException('Old picker cancelled', 'AbortError') : Error('Old save failed'));
  }, cancellation);
  await expect(receiver.locator('#accept-files')).toBeDisabled();
  await expect(receiver.locator('#notice')).toBeHidden(); await expect(receiver.locator('#toast')).toBeHidden();
  await receiver.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('new-receiving-session.txt', { create: true });
    (window as any).__saveChoices[1].resolve(handle);
  });
  await expect(receiver.locator('#status')).toHaveText('已保存到设备');
  expect(await receiver.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('new-receiving-session.txt')).getFile()).text())).toBe('a verified new transfer');
});

test('cancelling the current single-file save picker still reports cancellation and allows another choice', async ({ page, context }) => {
  await setup(context); const link = await share(page), receiver = await context.newPage();
  await receiver.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
      if (++attempts === 1) throw new DOMException('Picker cancelled', 'AbortError');
      return (await navigator.storage.getDirectory()).getFileHandle('picked-after-cancellation.txt', { create: true });
    } });
  });
  await receiver.goto(link); await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#toast')).toHaveText('已取消选择保存位置'); await expect(receiver.locator('#accept-files')).toBeEnabled();
  await expect(receiver.locator('#notice')).toBeHidden();
  await receiver.locator('#language-toggle').click(); await expect(receiver.locator('#toast')).toHaveText('Save location selection cancelled');
  await receiver.locator('#accept-files').click(); await expect(receiver.locator('#status')).toHaveText('Saved to your device');
  expect(await receiver.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('picked-after-cancellation.txt')).getFile()).text())).toBe('a verified new transfer');
});

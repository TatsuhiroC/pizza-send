import { test, expect } from './fixtures';

test('paste reads only after a click, fills plain text without connecting, and fits both languages on mobile', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as any; state.__clipboardReads = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => { state.__clipboardReads++; return '  https://tatsuhiroc.github.io/pizza-send/#2.' + 'A'.repeat(43) + '\n'; }
    } });
  });
  let requests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/rooms')) requests++; });
  await page.goto('./'); await page.locator('#receive-tab').click();
  expect(await page.evaluate(() => (window as any).__clipboardReads)).toBe(0);
  await page.locator('#paste-receive').click();
  await expect(page.locator('#receive-code')).toHaveValue('https://tatsuhiroc.github.io/pizza-send/#2.' + 'A'.repeat(43));
  await expect(page.locator('#receive-code')).toBeFocused();
  await expect(page.locator('#session-panel')).toBeHidden();
  expect(requests).toBe(0);
  expect(await page.evaluate(() => (window as any).__clipboardReads)).toBe(1);
  await page.setViewportSize({ width: 320, height: 844 });
  for (const label of ['粘贴', 'Paste']) {
    await expect(page.locator('#paste-receive')).toHaveText(label);
    expect((await page.locator('#paste-receive').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#language-toggle').click();
  }
});

for (const mode of ['denied', 'missing', 'empty']) {
  test(`${mode} clipboard keeps the existing input and allows manual paste`, async ({ page }) => {
    await page.addInitScript(mode => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : {
        readText: async () => { if (mode === 'denied') throw new DOMException('Denied', 'NotAllowedError'); return ' \n'; }
      } });
    }, mode);
    await page.goto('./'); await page.locator('#receive-tab').click();
    await page.locator('#receive-code').fill('keep this code');
    await page.locator('#paste-receive').click();
    await expect(page.locator('#toast')).toContainText(mode === 'empty' ? '剪贴板中没有文字' : '无法自动粘贴');
    await expect(page.locator('#receive-code')).toHaveValue('keep this code');
    await expect(page.locator('#paste-receive')).toBeEnabled();
    await page.locator('#receive-code').fill('manually pasted code');
    await expect(page.locator('#receive-code')).toHaveValue('manually pasted code');
    await page.locator('#language-toggle').click();
    await expect(page.locator('#toast')).toContainText(mode === 'empty' ? 'There is no text' : 'Unable to paste automatically');
  });
}

test('a pending paste never overwrites an edit or a different session', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: () => new Promise<string>(resolve => { (window as any).__finishPaste = resolve; })
    } });
  });
  await page.goto('./'); await page.locator('#receive-tab').click();
  await page.locator('#paste-receive').click();
  await expect(page.locator('#paste-receive')).toBeDisabled();
  await page.locator('#language-toggle').click();
  await expect(page.locator('#paste-receive')).toBeDisabled();
  await page.locator('#receive-code').fill('a newer code');
  await page.evaluate(() => (window as any).__finishPaste('old clipboard text'));
  await expect(page.locator('#paste-receive')).toBeEnabled();
  await expect(page.locator('#receive-code')).toHaveValue('a newer code');
  await page.locator('#paste-receive').click();
  await page.locator('#send-tab').click();
  await page.evaluate(() => (window as any).__finishPaste('stale clipboard text'));
  await expect(page.locator('#paste-receive')).toBeEnabled();
  await page.locator('#receive-tab').click();
  await expect(page.locator('#receive-code')).toHaveValue('a newer code');
});

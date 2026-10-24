import { test, expect } from './fixtures';

for (const [locale, expected] of [
  ['en-US', 'en'], ['en-GB', 'en'], ['zh-CN', 'zh-CN'], ['zh-TW', 'zh-CN'],
  ['zh-Hant-HK', 'zh-CN'], ['ja-JP', 'en'], ['fr-FR', 'en'], ['ru-RU', 'en']
]) test.describe(`browser language ${locale}`, () => {
  test.use({ locale });
  test('first visit uses a supported browser language without saving an override', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('lang', expected);
    await expect(page).toHaveTitle(expected === 'en' ? 'PizzaSend · File transfer' : 'PizzaSend · 文件快传');
    expect(await page.evaluate(() => localStorage.getItem('pizza-send-language'))).toBeNull();
    await expect(page.locator('#start-send')).toContainText(expected === 'en' ? 'Start sharing' : '创建传输');
  });
});

for (const [locale, saved, expected] of [['en-US', 'zh', 'zh-CN'], ['zh-CN', 'en', 'en']]) test.describe(`saved ${saved} on ${locale}`, () => {
  test.use({ locale });
  test('explicit preference wins over the browser language', async ({ page }) => {
    await page.addInitScript(saved => localStorage.setItem('pizza-send-language', saved), saved);
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('lang', expected);
  });
});

for (const [languages, expected] of [
  [['en-GB', 'zh-CN'], 'en'], [['ja-JP', 'zh-TW', 'en-US'], 'zh-CN']
] as const) test('supported languages follow browser priority: ' + languages.join(', '), async ({ page }) => {
  await page.addInitScript(languages => Object.defineProperty(navigator, 'languages', { get: () => languages }), languages);
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', expected);
});

test('an empty preference list falls back to navigator.language', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => [] });
    Object.defineProperty(navigator, 'language', { get: () => 'zh-HK' });
  });
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test.describe('English browser preferences', () => {
  test.use({ locale: 'en-US' });
  test('wider fallback fonts keep the English title and selected pizza inside small screens', async ({ page }) => {
    await page.goto('./');
    await page.addStyleTag({ content: '.intro h1 { font-family: monospace; }' });
    for (const width of [320, 375, 390, 640, 700]) {
      await page.setViewportSize({ width, height: 844 });
      for (const selected of [false, true]) {
        if (selected) await page.locator('#file-input').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
        else if (await page.locator('#clear-files').isVisible()) await page.locator('#clear-files').click();
        // Include the end of box scaling, not only the first transition frame.
        await page.locator('.hero-pizza').evaluate(async element => {
          await Promise.allSettled(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished));
        });
        const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ tag: element.tagName, id: element.id })));
        expect(overflow, `viewport ${width}, selected ${selected}`).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  });
  test('invalid saved values do not force Chinese', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pizza-send-language', 'invalid'));
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('storage restrictions preserve detection and manual switching', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
    });
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('#language-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    expect(errors).toEqual([]);
  });
});

test('automatic choice follows changed browser preferences on reopening until the user chooses', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => JSON.parse(sessionStorage.getItem('test-browser-languages') || '["en-US"]') });
  });
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.evaluate(() => sessionStorage.setItem('test-browser-languages', '["zh-CN"]'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  expect(await page.evaluate(() => localStorage.getItem('pizza-send-language'))).toBeNull();
  await page.locator('#language-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

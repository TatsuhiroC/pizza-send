import { test, expect } from './fixtures';

test('configuration preconnects only the selected service without creating a share', async ({ page }) => {
  const rooms: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/rooms')) rooms.push(request.method()); });
  await page.route('**/app.config.json', route => route.fulfill({ json: { signalUrl: 'https://default.invalid/' } }));
  await page.addInitScript(() => localStorage.setItem('pizza-send-signal', 'https://selected.invalid/path'));
  await page.goto('./');
  const hint = page.locator('head #signal-preconnect');
  await expect(hint).toHaveAttribute('href', 'https://selected.invalid');
  await expect(hint).toHaveAttribute('rel', 'preconnect');
  await expect(hint).toHaveAttribute('crossorigin', 'anonymous');
  await page.locator('.settings summary').click();
  await page.locator('#signal-url').fill('https://replacement.invalid');
  await page.locator('#save-settings').click();
  await expect(hint).toHaveAttribute('href', 'https://replacement.invalid');
  await expect(hint).toHaveCount(1);
  await page.locator('#signal-url').fill(''); await page.locator('#save-settings').click();
  await expect(hint).toHaveCount(0);
  expect(rooms).toEqual([]);
});

test('connection hints reject unsafe or unnecessary targets and reuse an unchanged origin', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pizza-send-signal', ''));
  await page.goto('./');
  expect(await page.evaluate(async () => {
    const { setSignalPreconnect } = await import('/src/signal-preconnect.ts');
    setSignalPreconnect('https://one.invalid/a');
    const first = document.getElementById('signal-preconnect');
    setSignalPreconnect('https://one.invalid/b');
    const reused = first === document.getElementById('signal-preconnect');
    const results = ['', 'malformed', 'http://localhost:8787', 'http://remote.invalid', location.origin, 'https://user:password@one.invalid', 'https://one.invalid/?secret=x', 'https://one.invalid/#secret'];
    return { reused, removed: results.map(value => {
      setSignalPreconnect('https://one.invalid'); setSignalPreconnect(value);
      return !document.getElementById('signal-preconnect');
    }) };
  })).toEqual({ reused: true, removed: Array(8).fill(true) });
});

import { test, expect } from './fixtures';

const current = 'https://signal.pizzasend.dpdns.org';
const previous = 'https://pizza-send-signal.jimchenqizheng.workers.dev';

for (const saved of [null, previous, previous + '/', 'https://custom.example', '']) {
  test(`signaling domain migration preserves the user's choice: ${JSON.stringify(saved)}`, async ({ page }) => {
    await page.route('**/app.config.json', route => route.fulfill({ json: {
      signalUrl: current, iceServers: [], memoryLimitBytes: 268435456
    } }));
    await page.addInitScript(value => {
      if (value !== null) localStorage.setItem('pizza-send-signal', value);
    }, saved);
    await page.goto('./');
    await expect(page.locator('#signal-url')).toHaveValue(saved === null || saved.startsWith(previous) ? current : saved);
    // Migration must not overwrite manually configured settings in browser storage.
    expect(await page.evaluate(() => localStorage.getItem('pizza-send-signal'))).toBe(saved);
    if (saved === previous) {
      let requested = false;
      await page.route(current + '/rooms', async route => {
        requested = true;
        await route.fulfill({ status: 503, body: '', headers: { 'access-control-allow-origin': 'http://127.0.0.1:5173' } });
      });
      await page.locator('#file-input').setInputFiles({ name: 'domain.txt', mimeType: 'text/plain', buffer: Buffer.from('domain migration') });
      await page.locator('#start-send').click();
      await expect.poll(() => requested).toBe(true);
      await expect(page.locator('#start-send')).toBeEnabled();
    }
  });
}

test('self-hosted deployments can still explicitly use the previous endpoint', async ({ page }) => {
  await page.route('**/app.config.json', route => route.fulfill({ json: {
    signalUrl: previous, iceServers: [], memoryLimitBytes: 268435456
  } }));
  await page.addInitScript(value => localStorage.setItem('pizza-send-signal', value), previous);
  await page.goto('./');
  await expect(page.locator('#signal-url')).toHaveValue(previous);
});

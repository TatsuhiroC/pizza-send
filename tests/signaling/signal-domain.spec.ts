import { test, expect } from '../fixtures';
import { readFile } from 'node:fs/promises';

const current = 'https://signal.pizzasend.dpdns.org';
const custom = 'https://signal.example.net';
const worker = 'https://pairing.demo.workers.dev';
const cases = [
  { label: 'production default', configured: current, saved: null, expected: current },
  { label: 'custom endpoint', configured: current, saved: custom, expected: custom },
  { label: 'custom endpoint with trailing slash', configured: current, saved: custom + '/', expected: custom + '/' },
  { label: 'custom Worker endpoint', configured: current, saved: worker, expected: worker },
  { label: 'manual pairing', configured: current, saved: '', expected: '' },
  { label: 'self-hosted default', configured: custom, saved: null, expected: custom },
  { label: 'self-hosted Worker default', configured: worker, saved: null, expected: worker }
];

for (const { label, configured, saved, expected } of cases) {
  // Use descriptive case names: configuration values must not enter CI titles.
  test(`signaling settings preserve the user's choice: ${label}`, async ({ page }) => {
    await page.route('**/app.config.json', route => route.fulfill({ json: {
      signalUrl: configured, iceServers: [], memoryLimitBytes: 268435456
    } }));
    await page.addInitScript(value => {
      if (value !== null) localStorage.setItem('pizza-send-signal', value);
    }, saved);
    await page.goto('./');
    await expect(page.locator('#signal-url')).toHaveValue(expected);
    expect(await page.evaluate(() => localStorage.getItem('pizza-send-signal'))).toBe(saved);

    let requested = false;
    if (expected) {
      await page.route(new URL(expected).origin + '/rooms', async route => {
        requested = true;
        await route.fulfill({ status: 503, json: { error: 'Fixture unavailable' },
          headers: { 'access-control-allow-origin': new URL(page.url()).origin } });
      });
    }
    await page.locator('#file-input').setInputFiles({ name: 'endpoint.txt', mimeType: 'text/plain', buffer: Buffer.from('signaling setting') });
    await page.locator('#start-send').click();
    if (expected) {
      await expect.poll(() => requested).toBe(true);
      await expect(page.locator('#start-send')).toBeEnabled();
    } else {
      await expect(page.locator('#pair-dialog')).toBeVisible();
      expect(requested).toBe(false);
    }
    expect(await page.evaluate(() => localStorage.getItem('pizza-send-signal'))).toBe(saved);
  });
}

test('production publishes signaling only through its custom domain', async () => {
  const deployment = JSON.parse(await readFile('signal/wrangler.jsonc', 'utf8'));
  const config = JSON.parse(await readFile('public/app.config.json', 'utf8'));
  expect(deployment.workers_dev).toBe(false);
  expect(deployment.preview_urls).toBe(false);
  expect(deployment.routes).toContainEqual({ pattern: new URL(config.signalUrl).hostname, custom_domain: true });
  const source = await readFile('src/main.ts', 'utf8');
  expect(source).not.toMatch(/(?:[a-z0-9-]+\.)+workers\.dev\b/i);
});

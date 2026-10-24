import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base, testMatch: 'headers.spec.ts', testIgnore: [],
  use: { locale: 'zh-CN', baseURL: 'http://127.0.0.1:4173', acceptDownloads: true },
  projects: [
    { name: 'headers-chromium', use: { browserName: 'chromium', launchOptions: base.use?.launchOptions } },
    { name: 'headers-webkit', use: { browserName: 'webkit' } }
  ],
  webServer: [
    { command: 'npm run preview -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173/', reuseExistingServer: false, timeout: 30000 },
    { command: 'wrangler dev --config signal/wrangler.jsonc --port 8789 --local --persist-to .wrangler/headers-state --var ALLOWED_ORIGINS:http://127.0.0.1:4173', url: 'http://127.0.0.1:8789/', reuseExistingServer: false, timeout: 60000,
      env: { WRANGLER_LOG_PATH: '/tmp/pizza-send-headers-tests.log', WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: '/tmp/pizza-send-headers-tests' } }
  ]
});

import { defineConfig } from '@playwright/test';
import base, { projectRoot } from '../../playwright.config';
export default defineConfig({
  testDir: base.testDir, outputDir: base.outputDir, testMatch: 'site-staging.spec.ts', timeout: 60000, workers: 1,
  expect: { timeout: 15000 },
  use: { locale: 'zh-CN', baseURL: 'http://127.0.0.1:4175' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: base.use?.launchOptions } },
    { name: 'webkit', use: { browserName: 'webkit' } }
  ],
  webServer: { cwd: projectRoot, command: 'npm run preview -- --port 4175', url: 'http://127.0.0.1:4175/', reuseExistingServer: !process.env.CI, timeout: 30000 }
});

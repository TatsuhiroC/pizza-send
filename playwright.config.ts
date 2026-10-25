import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testIgnore: 'headers.spec.ts', timeout: 120000, workers: 1,
  expect: { timeout: 20000 },
  use: { locale: 'zh-CN', baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173', launchOptions: { executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection', '--force-webrtc-ip-handling-policy=default', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, acceptDownloads: true },
  reporter: [['list']],
  webServer: [
    { command: 'npm run dev -- --port 5173', url: 'http://127.0.0.1:5173/', reuseExistingServer: !process.env.CI, timeout: 30000 },
    { command: 'npm run signal:dev', url: 'http://127.0.0.1:8787/', reuseExistingServer: !process.env.CI, timeout: 60000, env: { WRANGLER_LOG_PATH: '/tmp/pizza-send-wrangler-tests.log', WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: '/tmp/pizza-send-wrangler-tests' } }
  ]
});


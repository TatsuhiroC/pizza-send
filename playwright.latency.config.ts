import { defineConfig } from '@playwright/test';
import benchmark from './playwright.benchmark.config';

const servers = Array.isArray(benchmark.webServer) ? benchmark.webServer : benchmark.webServer ? [benchmark.webServer] : [];
export default defineConfig({
  ...benchmark, testMatch: 'latency.spec.ts',
  ...(process.env.BENCH_BUILT ? { webServer: servers.map((server, index) => index ? server : {
    ...server,
    command: process.env.BENCH_BASELINE_DIST ? 'node benchmarks/serve-builds.mjs' : 'npm run preview -- --port 5173 --strictPort',
    reuseExistingServer: false
  }) } : {})
});

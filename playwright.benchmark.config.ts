import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({ ...base, testDir: './benchmarks', testMatch: 'transfer.spec.ts', testIgnore: [], timeout: 120000 });

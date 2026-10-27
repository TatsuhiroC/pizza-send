import { defineConfig } from '@playwright/test';
import base, { projectRoot } from '../../playwright.config';
export default defineConfig({ ...base, testDir: projectRoot + 'benchmarks', testMatch: 'transfer.spec.ts', testIgnore: [], timeout: 120000 });

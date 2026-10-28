import { defineConfig } from '@playwright/test';
import base, { projectRoot } from '../../playwright.config';
export default defineConfig({ ...base, testDir: projectRoot + 'tests/performance', testMatch: 'transfer.spec.ts', testIgnore: [], timeout: 120000 });

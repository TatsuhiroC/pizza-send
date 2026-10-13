import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base, testMatch: 'mobile-save-controller.spec.ts',
  use: { baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173', browserName: 'webkit', acceptDownloads: true }
});

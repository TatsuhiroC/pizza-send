import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base, testMatch: ['camera-choice.spec.ts', 'scanner-lifecycle.spec.ts', 'folder-archive.spec.ts', 'selection-camera.spec.ts', 'mobile-save-controller.spec.ts', 'interface-motion.spec.ts', 'background.spec.ts', 'receive-batches.spec.ts', 'file-hash.spec.ts', 'compression.spec.ts', 'transfer-review.spec.ts'],
  use: { baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173', browserName: 'webkit', acceptDownloads: true }
});

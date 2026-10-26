import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
  ...base, testMatch: ['route-controls.spec.ts', 'stream-cipher.spec.ts', 'stream-channel.spec.ts', 'stream-policy.spec.ts', 'stream-fallback.spec.ts', 'route-policy.spec.ts', 'connection-diagnostics.spec.ts', 'language-default.spec.ts', 'language.spec.ts', 'signal-domain.spec.ts', 'browser-signaling-limits.spec.ts', 'review-2026-10-20.spec.ts', 'group-message-limits.spec.ts', 'signaling-outage.spec.ts', 'signaling-auth.spec.ts', 'camera-preview.spec.ts', 'camera-choice.spec.ts', 'scanner-lifecycle.spec.ts', 'folder-archive.spec.ts', 'selection-camera.spec.ts', 'mobile-save-controller.spec.ts', 'interface-motion.spec.ts', 'background.spec.ts', 'receive-batches.spec.ts', 'file-hash.spec.ts', 'compression.spec.ts', 'transfer-review.spec.ts'],
  use: { locale: 'zh-CN', baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173', browserName: 'webkit', acceptDownloads: true }
});

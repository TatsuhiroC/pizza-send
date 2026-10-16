import { test as base } from '@playwright/test';
import { randomUUID } from 'node:crypto';
export * from '@playwright/test';
// Keep each isolated local test's room-creation bucket independent. Production
// rate limiting is unchanged; never add this header to the deployed service.
export const test = base.extend<{ localRateLimitScope: void }>({
  localRateLimitScope: [async ({ context }, use, info) => {
    const scope = info.testId + '-' + randomUUID();
    await context.route(url => url.hostname === '127.0.0.1' && url.port === '8787' && url.pathname.startsWith('/rooms'), route =>
      route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': 'isolated-test-' + scope } }));
    await use();
  }, { auto: true }]
});

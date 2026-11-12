import { test as base, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
export * from '@playwright/test';
// Keep each isolated local test's room-creation bucket independent. Production
// rate limiting is unchanged; never add this header to the deployed service.
export async function isolateLocalRequests(context: BrowserContext, testId: string) {
  const scope = testId + '-' + randomUUID();
  await context.route(url => url.hostname === '127.0.0.1' && url.port === '8787' && url.pathname.startsWith('/rooms'), route =>
    route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': 'isolated-test-' + scope } }));
}

// Install the route only when a test actually needs a browser context. An
// automatic fixture would launch browsers even for pure protocol/Worker checks.
export const test = base.extend({
  context: async ({ context }, use, info) => {
    await isolateLocalRequests(context, info.testId);
    await use(context);
  }
});

// Fixtures that instrument RTCDataChannel must exercise that route even if
// the local relay would connect first. Leave the normal signaling API active.
export async function useDirectTransport(context: BrowserContext) {
  await context.route(url => url.hostname === '127.0.0.1' && url.port === '8787' && url.pathname.startsWith('/rooms/'), route => {
    const request = route.request();
    if (request.method() !== 'POST' || request.postDataJSON()?.type !== 'stream-connect') return route.fallback();
    return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': request.headers().origin || '*' },
      json: { error: 'Relay unavailable in the direct transport fixture' } });
  });
}

import { test, expect } from '../fixtures';

test('route choices remain visible, keep focus and translate without overflowing a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await page.goto('./');
  await page.evaluate(async () => {
    const { renderRouteControls } = await import('/src/route-controls.ts');
    const state = window as any; state.__choices = [];
    document.getElementById('session-panel')!.hidden = false;
    state.__showRoute = (changes: any) => renderRouteControls(document.getElementById('route-controls')!, {
      available: true, current: 'stream', target: 'stream', busy: false, manual: false, failed: false, ...changes
    }, route => state.__choices.push(route));
    state.__showRoute({ available: false });
  });
  const controls = page.locator('#route-controls'); await expect(controls).toBeHidden();
  await page.evaluate(() => (window as any).__showRoute({}));
  const direct = controls.locator('[data-route="direct"]'), stream = controls.locator('[data-route="stream"]');
  await expect(stream).toHaveAttribute('aria-pressed', 'true'); await direct.click();
  expect(await page.evaluate(() => (window as any).__choices)).toEqual(['direct']);
  await direct.focus();
  await page.evaluate(() => (window as any).__showRoute({ current: 'direct', target: 'direct', manual: true }));
  await expect(direct).toBeFocused(); await expect(direct).toHaveAttribute('aria-pressed', 'true');
  await expect(controls.locator('.route-hint')).toContainText('不再自动切换');
  await page.evaluate(() => (window as any).__showRoute({ busy: true }));
  await expect(direct).toBeDisabled(); await expect(stream).toBeDisabled();
  // An unsuccessful direct reconnection must still let the user pick the relay.
  await page.evaluate(async () => {
    (window as any).__showRoute({ current: 'direct', target: 'direct', recovering: true, manual: true });
    const { toggleLanguage } = await import('/src/i18n.ts'); toggleLanguage();
  });
  await expect(stream).toBeEnabled(); await expect(direct).toHaveText('Direct');
  await expect(controls.locator('legend')).toHaveText('Transfer route');
  await expect(controls.locator('.route-message')).toContainText('Switching back to direct');
  expect(await stream.evaluate(button => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await controls.screenshot({ path: '/tmp/pizzasend-route-controls-mobile.png' });
  await page.evaluate(async () => {
    const { toggleLanguage } = await import('/src/i18n.ts'); toggleLanguage();
    (window as any).__showRoute({ manual: true });
  });
  await controls.screenshot({ path: '/tmp/pizzasend-route-controls-zh.png' });
  await page.evaluate(async () => { const { toggleLanguage } = await import('/src/i18n.ts'); toggleLanguage(); });
  await page.evaluate(() => (window as any).__showRoute({ current: 'direct', failed: true }));
  await expect(controls).toBeVisible(); await expect(stream).toBeEnabled();
  await expect(controls.locator('.route-message')).toContainText('unavailable');
  await page.evaluate(() => (window as any).__showRoute({ current: 'direct', failed: true, connected: false }));
  await expect(controls.locator('.route-message')).toContainText('Not connected yet');
  await expect(stream).toBeEnabled();
});

test('route choices are hidden until needed and after the transfer ends', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#route-controls')).toBeHidden();
  await page.evaluate(async () => {
    const { renderRouteControls } = await import('/src/route-controls.ts');
    const host = document.getElementById('route-controls')!;
    renderRouteControls(host, { available: true, current: 'stream', target: 'stream', busy: false, manual: false, failed: false }, () => {}, false);
  });
  await expect(page.locator('#route-controls')).toBeHidden();
});

test('a sender changes only the selected recipient route', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { GroupSender } = await import('/src/group.ts');
    const calls: string[] = [], group: any = new GroupSender({} as any, {} as any, [], 'a'.repeat(64), 'http://127.0.0.1:8787', 'b'.repeat(64), 'c'.repeat(64), () => {}, () => {});
    for (const client of ['first', 'second']) group.peers.set(client, { client, pair: { chooseRoute: async (route: string) => calls.push(client + ':' + route), close() {} } });
    await group.chooseRoute('second', 'direct');
    group.event('second', { type: 'route', data: { current: 'direct', manual: true } });
    const untouched = group.peers.get('first').route === undefined;
    group.close(false); return { calls, untouched };
  });
  expect(result).toEqual({ calls: ['second:direct'], untouched: true });
});

test('manual route control requires encrypted peer authentication and cancellation drops late requests', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const transfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', () => {});
    const pair: any = new AutoPair(transfer, await signalKey('a'.repeat(64)), () => {}, 'a'.repeat(64));
    pair.streamFallback.supported = true; pair.streamFallback.used.add('b'.repeat(64));
    await pair.handle({ type: 'stream-choice', route: 'direct' });
    const untrustedIgnored = !pair.streamFallback.state.manual;
    await pair.handle({ type: 'stream-choice', route: 'direct' }, true);
    const authenticatedApplied = pair.streamFallback.state.manual;
    let finish!: () => void; pair.signal.send = () => new Promise<void>(resolve => { finish = resolve; });
    const pending = pair.chooseRoute('stream'); pair.close(); transfer.close(false); finish(); await pending;
    return { untrustedIgnored, authenticatedApplied, lateTimer: !!pair.routeRequestTimer, pending: !!pair.pendingRoute };
  });
  expect(result).toEqual({ untrustedIgnored: true, authenticatedApplied: true, lateTimer: false, pending: false });
});

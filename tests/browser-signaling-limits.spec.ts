import { test, expect, type WebSocketRoute } from './fixtures';

for (const service of ['signaling', 'group'] as const) test(`the real browser closes oversized ${service} traffic using an allowed client close code`, async ({ page }) => {
  let socket!: WebSocketRoute;
  await page.route('http://127.0.0.1:8787/rooms/**', route => route.fulfill({ json: route.request().method() === 'POST' ? { ticket: 'a'.repeat(64) } : { peerPresent: true, multi: true, inviteExpiresAt: Date.now() + 1800000, members: [] } }));
  await page.routeWebSocket('ws://127.0.0.1:8787/rooms/**', route => { socket = route; });
  const browserErrors: string[] = []; page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('./');
  await page.evaluate(async service => {
    const state = window as any; state.__limitErrors = [];
    const error = (message: string) => state.__limitErrors.push(message);
    if (service === 'signaling') {
      const { Signaling, signalKey } = await import('/src/protocol.ts');
      state.__boundedClient = new Signaling(await signalKey('b'.repeat(64)), async () => {}, error);
      await state.__boundedClient.connect('http://127.0.0.1:8787', 'c'.repeat(64), 'sender', 'd'.repeat(64));
    } else {
      const { GroupSender } = await import('/src/group.ts');
      state.__boundedClient = new GroupSender({} as any, { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, [], 'b'.repeat(64), 'http://127.0.0.1:8787', 'c'.repeat(64), 'd'.repeat(64), () => {}, error);
      await state.__boundedClient.connect();
    }
    state.__boundedSocket = state.__boundedClient.socket;
    state.__boundedSocket.addEventListener('close', (event: CloseEvent) => { state.__closeCode = event.code; });
  }, service);
  try {
    socket.send(JSON.stringify({ type: service === 'group' ? 'members' : 'signal', padding: 'x'.repeat(service === 'group' ? 16385 : 128001) }));
    await expect.poll(async () => browserErrors.length + await page.evaluate(() => (window as any).__limitErrors.length), { timeout: 2000 }).toBeGreaterThan(0);
    expect(browserErrors).toEqual([]);
    await expect.poll(() => page.evaluate(() => (window as any).__closeCode), { timeout: 2000 }).toBe(4009);
    expect(await page.evaluate(() => (window as any).__limitErrors)).toEqual(['配对消息超出安全限制，已断开配对服务。已建立的文件直传可以继续。']);
  } finally {
    await page.evaluate(service => {
      (window as any).__boundedClient.close(service === 'group' ? false : undefined);
      (window as any).__boundedSocket.close();
    }, service);
  }
});

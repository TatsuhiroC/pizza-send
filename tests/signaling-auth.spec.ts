import { test, expect, type WebSocketRoute } from './fixtures';

for (const role of ['receiver', 'sender'] as const) test(`a raw service ${role === 'receiver' ? 'offer' : 'answer'} cannot replace authenticated peer negotiation`, async ({ page }) => {
  let socket!: WebSocketRoute;
  await page.route('http://127.0.0.1:8787/rooms/**', route => route.fulfill({ json: route.request().method() === 'POST' ? { ticket: 'a'.repeat(64) } : { peerPresent: true } }));
  await page.routeWebSocket('ws://127.0.0.1:8787/rooms/**', route => { socket = route; });
  await page.goto('./');
  await page.evaluate(async role => {
    const { Transfer, AutoPair, signalKey } = await import('/src/protocol.ts');
    const state = window as any; state.__negotiated = []; state.__signalErrors = []; state.__peerInfo = [];
    const transfer = state.__authTransfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, role, event => { if (event.type === 'peer-info') state.__peerInfo.push(event.data); });
    if (role === 'receiver') transfer.answer = async (description: RTCSessionDescriptionInit) => { state.__negotiated.push(description.sdp); return { type: 'answer', sdp: 'v=0\r\n' }; };
    else {
      transfer.finish = async (description: RTCSessionDescriptionInit) => { state.__negotiated.push(description.sdp); };
      Object.defineProperty(transfer.pc, 'signalingState', { value: 'have-local-offer' });
    }
    const key = state.__signalKey = await signalKey('b'.repeat(64));
    const pair = state.__authPair = new AutoPair(transfer, key, (message: string) => state.__signalErrors.push(message));
    await pair.connect('http://127.0.0.1:8787', 'c'.repeat(64), role, 'd'.repeat(64));
  }, role);
  const type = role === 'receiver' ? 'offer' : 'answer';
  socket.send(JSON.stringify({ type, epoch: 0, peerInfo: { device: 'computer', browser: 'chrome' }, description: { type, sdp: 'v=0\r\na=untrusted-service\r\n' } }));
  socket.send(JSON.stringify({ type: 'candidates', epoch: 0, candidates: [{ candidate: 'candidate:untrusted-service' }] }));
  socket.send(JSON.stringify({ type: 'restart-request' }));
  const payload = await page.evaluate(async type => {
    const { seal } = await import('/src/protocol.ts');
    return seal((window as any).__signalKey, { session: 'e'.repeat(64), sequence: 1, message: { type, epoch: 0, peerInfo: { device: 'phone', browser: 'safari' }, description: { type, sdp: 'v=0\r\na=authenticated-peer\r\n' } } });
  }, type);
  socket.send(JSON.stringify({ type: 'signal', payload }));
  await expect.poll(() => page.evaluate(() => (window as any).__negotiated), { timeout: 2000 }).toEqual(['v=0\r\na=authenticated-peer\r\n']);
  expect(await page.evaluate(() => (window as any).__signalErrors)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__peerInfo)).toEqual(role === 'sender' ? [{ device: 'phone', browser: 'safari' }] : []);
  expect(await page.evaluate(() => (window as any).__authPair.remoteCandidates)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__authTransfer.recovering)).toBe(false);
  await page.evaluate(() => { (window as any).__authPair.close(); (window as any).__authTransfer.close(false); });
});

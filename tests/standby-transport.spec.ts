import { test, expect } from './fixtures';

test('standby heartbeats carry no file payload; probes require the matching nonce and share an in-flight check', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { StandbyTransport } = await import('/src/standby-transport.ts');
    const sent: any[] = [];
    const channel: any = { readyState: 'open', close() { this.readyState = 'closed'; }, send(data: string) { sent.push(JSON.parse(data)); } };
    const spare = new StandbyTransport(channel);
    const first = spare.probe(), second = spare.probe();
    channel.onmessage({ data: JSON.stringify({ type: 'standby-pong', nonce: '0'.repeat(32) }) });
    channel.onmessage({ data: new ArrayBuffer(32768) }); // Old ordered file tail is discarded.
    const onlyOnePing = sent.length === 1 && first === second;
    channel.onmessage({ data: JSON.stringify({ type: 'standby-pong', nonce: sent[0].nonce }) });
    const verified = await first;
    channel.onmessage({ data: JSON.stringify({ type: 'standby-ping', nonce: 'f'.repeat(32) }) });
    channel.onmessage({ data: JSON.stringify({ type: 'standby-ping', nonce: 'invalid' }) });
    const taken = spare.take();
    const released = channel.onmessage === null && taken === channel && channel.readyState === 'open';
    spare.close();
    return { onlyOnePing, verified, released, types: sent.map(message => message.type), closed: channel.readyState === 'closed' };
  });
  expect(result).toEqual({ onlyOnePing: true, verified: true, released: true, types: ['standby-ping', 'standby-pong'], closed: true });
});

test('a dead spare expires promptly and cancellation settles a pending probe', async ({ page }) => {
  await page.goto('./'); await page.clock.install();
  await page.evaluate(async () => {
    const { StandbyTransport } = await import('/src/standby-transport.ts');
    const state = window as any;
    state.__spare = new StandbyTransport({ readyState: 'open', close() { this.readyState = 'closed'; }, send() {} } as any);
    state.__probe = state.__spare.probe();
  });
  await page.clock.fastForward(3001);
  expect(await page.evaluate(() => (window as any).__probe)).toBe(false);
  expect(await page.evaluate(async () => {
    const spare = (window as any).__spare, pending = spare.probe(); spare.close(); return await pending;
  })).toBe(false);
});

test('a cancelled idle heartbeat cannot close a channel after ownership returns to the transfer', async ({ page }) => {
  await page.goto('./'); await page.clock.install();
  await page.evaluate(async () => {
    const { StandbyTransport } = await import('/src/standby-transport.ts');
    const state = window as any;
    state.__idleChannel = { readyState: 'open', close() { this.readyState = 'closed'; }, send() {} };
    state.__idle = new StandbyTransport(state.__idleChannel);
  });
  await page.clock.fastForward(10000); await page.clock.fastForward(3001); // First missed heartbeat.
  await page.clock.fastForward(6999); // A second heartbeat is in flight.
  expect(await page.evaluate(async () => {
    const state = window as any; state.__idle.take(); await Promise.resolve();
    return { state: state.__idleChannel.readyState, reusableByOldOwner: await state.__idle.probe() };
  })).toEqual({ state: 'open', reusableByOldOwner: false });
  await page.clock.fastForward(30000);
  expect(await page.evaluate(() => (window as any).__idleChannel.readyState)).toBe('open');
});

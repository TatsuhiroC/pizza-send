import { test, expect } from '@playwright/test';
import { StreamFallback } from '../src/stream-fallback';

test('authenticated route negotiation commits both peers to the same next epoch', async () => {
  const peers: any = {}, channels: any = {}, epochs = { sender: 0, receiver: 0 }, activations: string[] = [], delivered: any[] = [];
  let bytes = 0;
  for (const role of ['sender', 'receiver'] as const) {
    const opposite = role === 'sender' ? 'receiver' : 'sender';
    channels[role] = { readyState: 'open', ready: Promise.resolve(), close() { this.readyState = 'closed'; },
      send(data: any) { queueMicrotask(() => channels[opposite].onmessage?.({ data })); } };
    peers[role] = new StreamFallback(role, {
      epoch: () => epochs[role], progress: () => ({ bytes, total: 3000 * 1800, active: true, hidden: false, connected: true }), stopped: () => false,
      open: async () => channels[role], send: async message => { queueMicrotask(() => { void peers[opposite].handle(message); }); },
      activate: async (_channel, epoch) => {
        epochs[role] = epoch; activations.push(role);
        if (role === 'receiver') channels.receiver.send(JSON.stringify({ type: 'visibility', hidden: false }));
        else channels.sender.onmessage = (event: any) => delivered.push(JSON.parse(event.data));
      }, restore: () => { throw Error('Unexpected restore'); }
    });
    peers[role].supported = true;
  }
  try {
    for (let ms = 0; ms <= 18000; ms += 2000) { bytes = 3000 * ms / 1000; peers.sender.monitor(true, 1e7 + ms); }
    await expect.poll(() => peers.sender.active && peers.receiver.active, { timeout: 1000 }).toBe(true);
    expect(epochs).toEqual({ sender: 1, receiver: 1 }); expect(activations).toEqual(['receiver', 'sender']);
    expect(delivered).toEqual([{ type: 'visibility', hidden: false }]);
  } finally { peers.sender.close(); peers.receiver.close(); }
});
test('failed candidate preparation preserves the existing route; cancellation closes late resources', async () => {
  let activate = 0, restore = 0, finish!: (channel: any) => void, closes = 0;
  const make = (open: any) => new StreamFallback('sender', { epoch: () => 0, progress: () => ({ bytes: 0, total: 1e9, active: true, hidden: false, connected: true }), stopped: () => false,
    open, send: async () => {}, activate: async () => { activate++; }, restore: () => { restore++; } });
  const unavailable: any = make(async () => { throw Error('Unavailable'); });
  await unavailable.prepare(3000, false); expect(unavailable.busy).toBe(false); unavailable.close();
  const late: any = make(() => new Promise(resolve => { finish = resolve; }));
  const pending = late.prepare(3000, false); await new Promise(resolve => setTimeout(resolve, 0)); late.close();
  finish({ close() { closes++; } }); await pending;
  expect({ activate, restore, closes }).toEqual({ activate: 0, restore: 0, closes: 1 });
});
test('peer cannot reuse a previous stream salt in a fresh encrypted control message', async () => {
  let opens = 0;
  const peer = new StreamFallback('receiver', { epoch: () => 0, progress: () => ({ bytes: 0, total: 1e9, active: true, hidden: false, connected: true }), stopped: () => false,
    open: async () => { opens++; throw Error('Fixture unavailable'); }, send: async () => {}, activate: async () => {}, restore: () => {} });
  peer.supported = true;
  const message = { type: 'stream-prepare', epoch: 0, session: 'a'.repeat(64) };
  await peer.handle(message); await peer.handle(message); peer.close(); expect(opens).toBe(1);
});
test('an activated candidate that does not improve actual file progress returns to the previous route', () => {
  for (const scenario of [{ speed: 1000, remaining: 1e9, expected: 1 }, { speed: 6000, remaining: 1e9, expected: 0 }, { speed: 1000, remaining: 10000, expected: 0 }]) {
    let restores = 0;
    const peer: any = new StreamFallback('sender', { epoch: () => 1, progress: () => ({ bytes: scenario.speed * 20, total: scenario.speed * 20 + scenario.remaining, active: true, hidden: false, connected: true }), stopped: () => false,
      open: async () => { throw Error('Unexpected probe'); }, send: async () => {}, activate: async () => {}, restore: () => { restores++; } });
    peer.supported = peer.active = peer.tried = true; peer.trial = { at: 10000, bytes: 0, oldBps: 3000 };
    peer.monitor(true, 30000); peer.monitor(true, 32000); peer.close(); expect(restores).toBe(scenario.expected);
  }
});

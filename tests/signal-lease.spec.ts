import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const TTL = 30 * 60 * 1000;
async function roomFixture() {
  const clock = { now: 1000000 }, data = new Map<string, any>(), alarms: number[] = [], sockets: any[] = [];
  class Clock extends Date { static now() { return clock.now; } }
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: any) => { data.set(key, structuredClone(value)); },
    transaction: async (fn: any) => fn(storage), setAlarm: async (at: number) => { alarms.push(at); },
    deleteAll: async () => { data.clear(); }
  };
  const scope: any = { Date: Clock, crypto: webcrypto, TextEncoder, Response, URL, WebSocket: { OPEN: 1 },
    DurableObject: class { ctx: any; constructor(ctx: any) { this.ctx = ctx; } } };
  const source = (await readFile('signal/worker.js', 'utf8')).replace("import { DurableObject } from 'cloudflare:workers';", '').replace('export default', 'const handler =').replaceAll('export class', 'class');
  vm.runInNewContext(source + '\nglobalThis.Room = Room;', scope);
  const ctx = { storage, getWebSockets: (role?: string) => sockets.filter(s => !role || s.role === role) };
  const room = new scope.Room(ctx);
  const sender = 'a'.repeat(64), receiver = 'b'.repeat(64), hash = (s: string) => createHash('sha256').update(s).digest('hex');
  await room.initialize(hash(sender), hash(receiver));
  const socket = (role: string) => {
    const meta = { role, count: 0, window: clock.now };
    const s = { role, readyState: 1, sent: [] as string[], close() { this.readyState = 3; },
      deserializeAttachment: () => meta, serializeAttachment() {}, send(message: string) { this.sent.push(message); } };
    sockets.push(s); return s;
  };
  const pair = () => { const s = data.get('room'); s.senderClient = 'c'.repeat(64); s.receiverClient = 'd'.repeat(64); };
  return { room, clock, data, alarms, socket, pair, receiver };
}

test('unpaired invitations expire after thirty minutes even with sender heartbeats', async () => {
  const f = await roomFixture(), sender = f.socket('sender');
  const expiry = f.data.get('room').expiresAt;
  f.clock.now += 20 * 60000; await f.room.webSocketMessage(sender, JSON.stringify({ type: 'keepalive' }));
  expect(f.data.get('room').expiresAt).toBe(expiry);
});
test('paired heartbeats renew recovery access beyond thirty minutes with a twenty-four-hour cap', async () => {
  const f = await roomFixture(); f.pair(); const sender = f.socket('sender');
  const created = f.clock.now, original = f.data.get('room').expiresAt;
  f.clock.now += 20 * 60000; await f.room.webSocketMessage(sender, JSON.stringify({ type: 'keepalive' }));
  expect(f.data.get('room').expiresAt).toBe(f.clock.now + TTL);
  expect(f.data.get('room').inviteExpiresAt).toBe(original);
  for (let i = 0; i < 94; i++) { f.clock.now += 15 * 60000; await f.room.renewActive(); }
  expect(f.data.get('room').expiresAt).toBeLessThanOrEqual(created + 24 * 60 * 60000);
  f.clock.now = created + 24 * 60 * 60000; await f.room.alarm(); expect(f.data.has('room')).toBe(false);
});
test('a queued old alarm respects renewal but explicit ending cannot be renewed', async () => {
  const f = await roomFixture(); f.pair(); f.clock.now += 20 * 60000; await f.room.renewActive();
  f.clock.now += 11 * 60000; await f.room.alarm();
  expect(f.data.has('room')).toBe(true); expect(f.alarms.at(-1)).toBe(f.data.get('room').expiresAt);
  f.data.get('room').ended = true; const expiry = f.data.get('room').expiresAt;
  await f.room.renewActive(); expect(f.data.get('room').expiresAt).toBe(expiry);
  await f.room.alarm(); expect(f.data.has('room')).toBe(false);
});
test('renewal does not allow a new recipient to join an expired invitation', async () => {
  const f = await roomFixture(); f.pair(); f.clock.now += 20 * 60000; await f.room.renewActive();
  delete f.data.get('room').receiverClient; f.clock.now += 11 * 60000;
  const url = 'https://signal.test/rooms/' + 'e'.repeat(64) + '?' + new URLSearchParams({ role: 'receiver', token: f.receiver, client: 'f'.repeat(64) });
  expect((await f.room.fetch(new Request(url))).status).toBe(410);
});

import { test, expect, type WebSocketRoute } from '../fixtures';

for (const scenario of ['join', 'leave', 'end', 'churn'] as const) test(`independent group negotiation handles ${scenario} while an earlier connection is pending`, async ({ page }) => {
  await page.route('http://127.0.0.1:8787/rooms/**', route => route.fulfill({ json: route.request().method() === 'POST' ?
    { ticket: 'a'.repeat(64) } : { multi: true, inviteExpiresAt: Date.now() + 1800000, members: [] } }));
  await page.goto('./');
  const result = await page.evaluate(async scenario => {
    const { GroupSender } = await import('/src/group.ts');
    const { AutoPair, Transfer } = await import('/src/protocol.ts');
    const { deriveRecipientShare, receiverDigest } = await import('/src/share.ts');
    const Socket = window.WebSocket, connect = AutoPair.prototype.connect, secret = 'b'.repeat(64);
    const members = await Promise.all(Array.from({ length: scenario === 'churn' ? 21 : 2 }, async (_, i) => {
      const client = (i + 1).toString(16).padStart(64, '0'), share = await deriveRecipientShare(secret, client);
      return { client, room: share.room, receiverHash: await receiverDigest(share.receiver), sender: 'e'.repeat(64) };
    }));
    let socket: any, unblock!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; }), started: string[] = [], pairs: any[] = [];
    const wait = async (check: () => boolean) => {
      for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw Error('Independent connection did not progress');
    };
    (window as any).WebSocket = class {
      static OPEN = 1;
      readyState = 0; onopen?: () => void;
      constructor() { socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {} close() { this.readyState = 3; }
    };
    AutoPair.prototype.connect = async function(_api, room) {
      started.push(room); pairs.push(this);
      if (scenario === 'churn' || room === members[0].room) await held;
    };
    const config = { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, file = new File(['generated'], 'generated.txt');
    const initial = new Transfer(config, 'sender', () => {}); initial.prepare([file]);
    const group: any = new GroupSender(initial, config, [file], secret, 'http://127.0.0.1:8787', 'f'.repeat(64), 'a'.repeat(64), () => {}, () => {});
    const snapshot = async (list: typeof members) => {
      socket.onmessage({ data: JSON.stringify({ type: 'members', multi: true, inviteExpiresAt: Date.now() + 1800000, members: list }) });
      await group.queue;
    };
    try {
      await group.connect(); await snapshot(members.slice(0, scenario === 'churn' ? 10 : 1));
      await wait(() => started.length === (scenario === 'churn' ? 10 : 1));
      if (scenario === 'join') {
        await snapshot(members); await wait(() => started.length === 2);
        return { bothStartedBeforeRelease: started.length, pending: group.connecting.size };
      }
      if (scenario === 'leave') {
        await snapshot([]);
        const closedBeforeRelease = pairs[0].closed;
        unblock(); await wait(() => group.connecting.size === 0);
        return { closedBeforeRelease, phase: group.peers.get(members[0].client).phase, pending: group.pendingMembers.length };
      }
      if (scenario === 'end') {
        group.close(false); await snapshot(members); unblock(); await wait(() => group.connecting.size === 0);
        return { started: started.length, allClosed: pairs.every(pair => pair.closed), pending: group.pendingMembers.length };
      }
      await snapshot(members.slice(10, 20));
      const peakPending = group.pendingMembers.length, peakConnecting = group.connecting.size;
      await snapshot(members.slice(20));
      const latestPending = group.pendingMembers.length;
      unblock(); await wait(() => group.connecting.size === 0);
      return { peakPending, peakConnecting, latestPending, started: started.length, lastStarted: started.at(-1) === members[20].room };
    } finally { unblock(); group.close(false); AutoPair.prototype.connect = connect; (window as any).WebSocket = Socket; }
  }, scenario);
  if (scenario === 'join') expect(result).toMatchObject({ bothStartedBeforeRelease: 2 });
  else if (scenario === 'leave') expect(result).toEqual({ closedBeforeRelease: true, phase: 'left', pending: 0 });
  else if (scenario === 'end') expect(result).toEqual({ started: 1, allClosed: true, pending: 0 });
  else expect(result).toEqual({ peakPending: 10, peakConnecting: 10, latestPending: 1, started: 11, lastStarted: true });
});

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

for (const kind of ['oversized', 'backlog', 'byte-backlog', 'binary'] as const) test(`group status messages reject ${kind} input without ending the share`, async ({ page }) => {
  await page.route('http://127.0.0.1:8787/rooms/**', route => route.fulfill({ json: route.request().method() === 'POST' ? { ticket: 'a'.repeat(64) } : { multi: true, inviteExpiresAt: Date.now() + 1800000, members: [] } }));
  await page.goto('./');
  const result = await page.evaluate(async kind => {
    const { GroupSender } = await import('/src/group.ts');
    const OriginalSocket = window.WebSocket;
    const sockets: any[] = [], errors: string[] = [], outgoing: unknown[] = [];
    class Socket {
      static OPEN = 1;
      readyState = 0;
      onopen?: () => void;
      onmessage?: (event: { data: unknown }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data: unknown) { outgoing.push(data); }
      close() { this.readyState = 3; }
    }
    (window as any).WebSocket = Socket;
    let release!: () => void, processed = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const group = new GroupSender({} as any, { signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, [], 'b'.repeat(64), 'http://127.0.0.1:8787', 'c'.repeat(64), 'd'.repeat(64), () => {}, message => errors.push(message));
    try {
      await group.connect();
      // Hold consumption deliberately to exercise the message budget; normal
      // per-recipient negotiation no longer holds the member snapshot queue.
      (group as any).consume = async () => { await gate; processed++; };
      const socket = sockets[0];
      if (kind === 'binary') socket.onmessage({ data: new ArrayBuffer(32) });
      else if (kind === 'oversized') socket.onmessage({ data: JSON.stringify({ type: 'members', padding: 'x'.repeat(16385) }) });
      else for (let i = 0; i < 5000 && socket.readyState === 1; i++) socket.onmessage({ data: JSON.stringify({ type: 'members', padding: kind === 'byte-backlog' ? 'x'.repeat(15000) : '' }) });
      const closed = socket.readyState === 3;
      release(); await (group as any).queue;
      return { closed, processed, errors, outgoing, queued: (group as any).queuedMessages, bytes: (group as any).queuedBytes };
    } finally { group.close(false); release(); (window as any).WebSocket = OriginalSocket; }
  }, kind);
  expect(result.closed).toBe(true); expect(result.processed).toBeLessThanOrEqual(1);
  expect(result.queued).toBe(0); expect(result.bytes).toBe(0);
  expect(result.outgoing).toEqual([]);
  expect(result.errors).toEqual(['配对消息超出安全限制，已断开配对服务。已建立的文件直传可以继续。']);
});

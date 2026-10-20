import { test, expect } from './fixtures';

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
      // Peer negotiation can keep consume() waiting while more full member
      // snapshots arrive. Exercise the boundary before parsing/queuing them.
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

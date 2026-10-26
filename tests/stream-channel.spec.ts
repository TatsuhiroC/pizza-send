import { test, expect, type WebSocketRoute } from './fixtures';
import { createHash } from 'node:crypto';

test('stream credits prove receipt of the server marker after ordered decryption', async ({ page, context }) => {
  let socket!: WebSocketRoute; const credits: any[] = [];
  await context.routeWebSocket('ws://127.0.0.1:8787/credit-fixture', route => {
    socket = route; route.onMessage(data => { if (typeof data === 'string') credits.push(JSON.parse(data)); });
    route.send(JSON.stringify({ type: 'stream-ready' }));
  });
  await page.goto('./');
  const frame = await page.evaluate(async () => {
    const { StreamCipher } = await import('/src/stream-cipher.ts'), { StreamChannel } = await import('/src/stream-channel.ts');
    const state = window as any;
    state.__creditChannel = new StreamChannel('ws://127.0.0.1:8787/credit-fixture', await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'receiver'));
    state.__creditChannel.onmessage = (event: MessageEvent) => { state.__decodedCredit = event.data; };
    await state.__creditChannel.ready;
    const sender = await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'sender');
    return [...new Uint8Array(await sender.encrypt('generated payload'))];
  });
  socket.send(Buffer.from(frame));
  socket.send(JSON.stringify({ type: 'credit-request', bytes: frame.length, nonce: 'd'.repeat(64) }));
  await expect.poll(() => credits.length).toBe(1);
  expect(credits[0]).toEqual({ type: 'credit', bytes: frame.length, nonce: 'd'.repeat(64) });
  expect(await page.evaluate(() => (window as any).__decodedCredit)).toBe('generated payload');
  // A server marker cannot acknowledge bytes not delivered on this stream.
  socket.send(JSON.stringify({ type: 'credit-request', bytes: frame.length + 1, nonce: 'e'.repeat(64) }));
  await expect.poll(() => page.evaluate(() => (window as any).__creditChannel.readyState)).toBe('closed');
  expect(credits).toHaveLength(1);
});

// This bridge models the server's opaque forwarding only. Backend admission,
// ticket binding, expiry and bounded credits have separate security tests.
for (const scenario of ['complete', 'resume', 'initial']) test(`encrypted WebSocket carries the complete file protocol${scenario === 'resume' ? ' across a mid-file reconnect' : scenario === 'initial' ? ' after initial connection failure' : ''}`, async ({ page, context }) => {
  const resume = scenario === 'resume';
  const sockets = new Map<string, WebSocketRoute>(), errors: string[] = [];
  let frames = 0, exposed = false;
  await context.routeWebSocket('ws://127.0.0.1:8787/stream-fixture/**', socket => {
    const url = new URL(socket.url()), session = url.searchParams.get('session')!, role = url.searchParams.get('role')!;
    const key = session + ':' + role, opposite = session + ':' + (role === 'sender' ? 'receiver' : 'sender');
    sockets.set(key, socket);
    socket.onMessage(data => {
      if (typeof data === 'string') { expect(JSON.parse(data).type).toBe('credit'); return; }
      frames++; exposed ||= data.includes(Buffer.from('private-original-video.mp4'));
      sockets.get(opposite)?.send(data);
    });
    if (sockets.has(opposite)) for (const peer of [socket, sockets.get(opposite)!]) peer.send(JSON.stringify({ type: 'stream-ready' }));
  });
  const receiver = await context.newPage();
  for (const [role, current] of [['sender', page], ['receiver', receiver]] as const) {
    current.on('pageerror', error => errors.push(error.message));
    await current.goto('./');
    await current.evaluate(async ({ role, resume }) => {
      const { Transfer } = await import('/src/protocol.ts');
      const state = window as any; state.__events = []; state.__recoveries = 0; state.__slowRead = resume;
      const handle = (Transfer.prototype as any).handle; state.__records = [];
      (Transfer.prototype as any).handle = function(data: any, generation: number) {
        if (typeof data === 'string') { const message = JSON.parse(data); state.__records.push({ type: message.type, generation, offset: message.offset, bytes: message.bytes }); }
        return handle.call(this, data, generation);
      };
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
      const transfer = state.__streamTransfer = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 16 * 1048576 }, role, event => state.__events.push(event));
      transfer.enableRecovery(() => { state.__recoveries++; });
      if (role === 'sender') {
        const data = new Uint8Array(8 * 1048576 + 17); for (let i = 0; i < data.length; i++) data[i] = i % 251;
        transfer.prepare([new File([data], 'private-original-video.mp4', { type: 'video/mp4' }), new File(['second'], '第二个文件.txt', { type: 'text/plain' }), new File([], 'empty.txt')]);
        if (resume) {
          const read = Blob.prototype.arrayBuffer;
          Blob.prototype.arrayBuffer = async function() { if (state.__slowRead && this.size <= 32768) await new Promise(resolve => setTimeout(resolve, 10)); return read.call(this); };
        }
      }
    }, { role, resume });
  }
  const replace = async (session: string) => {
    for (const [role, current] of [['sender', page], ['receiver', receiver]] as const) await current.evaluate(async ({ role, session }) => {
      const { StreamCipher } = await import('/src/stream-cipher.ts');
      const { StreamChannel } = await import('/src/stream-channel.ts');
      (window as any).__candidate = new StreamChannel('ws://127.0.0.1:8787/stream-fixture/channel?' + new URLSearchParams({ role, session }), await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), session, role));
    }, { role, session });
    for (const current of [receiver, page]) await current.evaluate(async () => {
      const state = window as any; await state.__candidate.ready; await state.__streamTransfer.replaceTransport(state.__candidate);
    });
  };
  try {
    if (scenario === 'initial') for (const current of [page, receiver]) await current.evaluate(() => (window as any).__streamTransfer.pauseRecovery());
    await replace('c'.repeat(64));
    await expect.poll(() => receiver.evaluate(() => (window as any).__streamTransfer.manifest.length)).toBe(3);
    await receiver.evaluate(() => (window as any).__streamTransfer.accept());
    if (resume) {
      await expect.poll(() => receiver.evaluate(() => (window as any).__streamTransfer.relayProgress().bytes)).toBeGreaterThanOrEqual(262144);
      for (const current of [page, receiver]) await current.evaluate(() => { const transfer = (window as any).__streamTransfer; transfer.pauseRecovery(); transfer.channel.close(); });
      await page.evaluate(() => { (window as any).__slowRead = false; });
      await replace('d'.repeat(64));
    }
    for (const current of [receiver, page]) await expect.poll(() => current.evaluate(() => {
      const state = window as any; const error = state.__events.find((event: any) => event.type === 'error'); return error?.data || state.__streamTransfer.completed;
    })).toBe(true);
    const received = await receiver.evaluate(async () => {
      const { listTemporaryFiles, temporaryURL } = await import('/src/received-storage.ts');
      const transfer = (window as any).__streamTransfer;
      const files = transfer.temporarySession ? await Promise.all((await listTemporaryFiles()).filter(file => file.session === transfer.temporarySession).map(async file => ({ info: file.info, url: await temporaryURL(file) }))) : transfer.outputs;
      return Promise.all(files.map(async (file: any) => {
        const bytes = await (await fetch(file.url)).arrayBuffer();
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return { name: file.info.name, size: bytes.byteLength, hash: [...hash].map(n => n.toString(16).padStart(2, '0')).join('') };
      }));
    });
    const original = Buffer.alloc(8 * 1048576 + 17); for (let i = 0; i < original.length; i++) original[i] = i % 251;
    const expected = [['private-original-video.mp4', original], ['第二个文件.txt', Buffer.from('second')], ['empty.txt', Buffer.alloc(0)]] as const;
    expect(received.sort((a, b) => a.name.localeCompare(b.name))).toEqual(expected.map(([name, bytes]) => ({ name, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') })).sort((a, b) => a.name.localeCompare(b.name)));
    expect(frames).toBeGreaterThan(256); expect(exposed).toBe(false); expect(errors).toEqual([]);
    if (resume) expect(await receiver.evaluate(() => (window as any).__events.some((event: any) => event.type === 'resumed'))).toBe(true);
  } catch (error) {
    const snapshots = [];
    for (const [role, current] of [['sender', page], ['receiver', receiver]] as const) snapshots.push(await current.evaluate(role => {
      const state = window as any, t = state.__streamTransfer, channel = t.channel;
      return { role, generation: t.generation, resumedGeneration: t.resumedGeneration, recovering: t.recovering, completed: t.completed, stopped: t.stopped,
        sent: t.sent, acknowledged: t.acknowledged, received: t.received, sendingOffset: t.sendingOffset, queued: t.receivingQueuedBytes, records: state.__records.slice(-12),
        outgoing: channel?.outgoing, incoming: channel?.incoming, buffered: channel?.bufferedAmount, readyState: channel?.readyState,
        events: state.__events.slice(-12).map((event: any) => event.type), recoveries: state.__recoveries };
    }, role));
    console.log('SAFE_STREAM_CHANNEL_FIXTURE', JSON.stringify(snapshots)); throw error;
  } finally {
    for (const current of [page, receiver]) await current.evaluate(() => (window as any).__streamTransfer.close(false));
  }
});

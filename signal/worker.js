import { DurableObject } from 'cloudflare:workers';

const TTL = 30 * 60 * 1000;
const MAX_ACTIVE_TTL = 24 * 60 * 60 * 1000;
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
async function readBody(request, limit = 1024) {
  if (!request.body) return null;
  const reader = request.body.getReader(), parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Error('Room configuration too large');
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  if (!size) return null; // Keep the original room API available for old links.
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function roomOptions(request) {
  const value = await readBody(request);
  if (!value) return null;
  if (value.multi !== undefined && typeof value.multi !== 'boolean') throw Error('Invalid room configuration');
  if (value?.v !== 2 || !/^[a-f0-9]{64}$/.test(value.room) || !/^[a-f0-9]{64}$/.test(value.receiverHash)) throw Error('Invalid room configuration');
  return value;
}
function response(body, status, origin) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'vary': 'Origin', 'cache-control': 'no-store', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
    if (!allowed.includes(origin)) return response({ error: 'Origin not allowed' }, 403, 'null');
    if (request.method === 'OPTIONS') return response({}, 204, origin);
    const url = new URL(request.url);
    if (url.pathname === '/rooms' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const limiter = env.LIMITS.get(env.LIMITS.idFromName(await digest(ip)));
      if (!await limiter.allow()) return response({ error: 'Too many requests' }, 429, origin);
      let options;
      try { options = await roomOptions(request); }
      catch { return response({ error: 'Invalid room configuration' }, 400, origin); }
      const room = options?.room || token(), sender = token(), receiver = options ? null : token();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      if (!await stub.initialize(await digest(sender), options?.receiverHash || await digest(receiver), !!options?.multi)) return response({ error: 'Room already exists' }, 409, origin);
      return response({ v: options ? 2 : 1, ...(options?.multi ? { multi: true } : {}), room, sender, ...(receiver ? { receiver } : {}), expiresAt: Date.now() + TTL }, 201, origin);
    }
    const match = url.pathname.match(/^\/rooms\/([a-f0-9]{64})$/);
    if (!match || !['GET', 'POST'].includes(request.method)) return response({ error: 'Not found' }, 404, origin);
    let forwarded = request;
    if (request.method === 'POST') {
      let body;
      try { body = await readBody(request, 2048); } catch { return response({ error: 'Invalid request' }, 400, origin); }
      const headers = new Headers(request.headers); headers.delete('content-length');
      forwarded = new Request(request, { headers, body: JSON.stringify(body ?? {}) });
    }
    const result = await env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(forwarded);
    if (result.status === 101) return result;
    return new Response(result.body, { status: result.status, headers: { ...Object.fromEntries(result.headers), 'access-control-allow-origin': origin, 'vary': 'Origin', 'cache-control': 'no-store' } });
  }
};
export class RateLimit extends DurableObject {
  async allow() {
    const now = Date.now();
    const bucket = await this.ctx.storage.get('bucket') || { at: now, count: 0 };
    if (now - bucket.at >= 60000) { bucket.at = now; bucket.count = 0; }
    bucket.count++;
    await this.ctx.storage.put('bucket', bucket);
    await this.ctx.storage.setAlarm(now + 120000);
    return bucket.count <= 10;
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.runtime = env; }
  sockets(role) { return this.ctx.getWebSockets(role).filter(socket => socket.readyState === WebSocket.OPEN); }
  async initialize(sender, receiver, multi = false) {
    const created = await this.ctx.storage.transaction(async storage => {
      if (await storage.get('room')) return false;
      const now = Date.now();
      await storage.put('room', { sender, receiver, inviteExpiresAt: now + TTL, expiresAt: now + TTL, maxExpiresAt: now + MAX_ACTIVE_TTL, ended: false, ...(multi ? { multi: true, members: {}, closedClients: [] } : {}) });
      return true;
    });
    if (created) await this.ctx.storage.setAlarm(Date.now() + TTL);
    return created;
  }
  async fetch(request) {
    const state = await this.ctx.storage.get('room');
    if (!state || state.ended || state.expiresAt <= Date.now()) return new Response('Session expired', { status: 410 });
    const url = new URL(request.url), role = url.searchParams.get('role'), secret = url.searchParams.get('token') || '', client = url.searchParams.get('client') || '';
    if (!['sender', 'receiver'].includes(role) || !/^[a-f0-9]{64}$/.test(secret) || await digest(secret) !== state[role]) return new Response('Unauthorized', { status: 401 });
    if (client && !/^[a-f0-9]{64}$/.test(client)) return new Response('Invalid client', { status: 400 });
    if (state.multi) return this.groupFetch(request, role, client);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (role === 'receiver' && !state.receiverClient && (state.inviteExpiresAt ?? state.expiresAt) <= Date.now()) return new Response('Invitation expired', { status: 410 });
    const existing = this.sockets(role);
    if (existing.length && (!client || state[role + 'Client'] !== client)) return new Response('Session already occupied', { status: 409 });
    if (state[role + 'Client'] && state[role + 'Client'] !== client) return new Response('Session already occupied', { status: 409 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ peerPresent: this.sockets(role === 'sender' ? 'receiver' : 'sender').length > 0 });
    }
    const bound = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get('room');
      if (!current || current.ended || current.expiresAt <= Date.now()) return 410;
      if (role === 'receiver' && !current.receiverClient && (current.inviteExpiresAt ?? current.expiresAt) <= Date.now()) return 410;
      if (current[role + 'Client'] && current[role + 'Client'] !== client) return 409;
      current[role + 'Client'] = client;
      await storage.put('room', current);
      return 101;
    });
    if (bound !== 101) return new Response('Session unavailable', { status: bound });
    // Reconnect only the same browser session; a new holder of the share link
    // cannot evict an active recipient. Old TCP sockets may linger after a VPN change.
    for (const old of existing) old.close(1000, 'Connection replaced');
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment({ role, count: 0, window: Date.now() });
    const opposite = role === 'sender' ? 'receiver' : 'sender';
    for (const other of this.sockets(opposite)) other.send(JSON.stringify({ type: 'peer-ready' }));
    if (this.sockets(opposite).length) pair[1].send(JSON.stringify({ type: 'peer-ready' }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async belongsTo(sender, receiver) {
    const state = await this.ctx.storage.get('room');
    return !!state && state.sender === sender && state.receiver === receiver;
  }
  child(room) { return this.runtime.ROOMS.get(this.runtime.ROOMS.idFromName(room)); }
  async endMember(member) {
    const child = this.child(member.room);
    // Reservations are untrusted until child ownership has been checked. A
    // cancelled colliding join must never close somebody else's room.
    const senderHash = await digest(member.sender);
    if (await child.belongsTo(senderHash, member.receiverHash)) await child.setEnded(senderHash, member.receiverHash);
  }
  async setEnded(sender, receiver) {
    const state = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get('room');
      if (!current) return;
      if (sender !== undefined && (current.sender !== sender || current.receiver !== receiver)) return;
      current.ended = true; await storage.put('room', current); return current;
    });
    if (!state) return;
    for (const socket of this.sockets()) { socket.send(JSON.stringify({ type: 'ended' })); socket.close(1000, 'Sender ended session'); }
    if (state.multi) await Promise.allSettled(Object.values(state.members).map(member => this.endMember(member)));
    await this.ctx.storage.setAlarm(Date.now());
  }
  async groupFetch(request, role, client) {
    if (!client || (request.headers.get('Upgrade') && role !== 'sender')) return new Response('Invalid group request', { status: 400 });
    if (role === 'sender') {
      const bound = await this.ctx.storage.transaction(async storage => {
        const state = await storage.get('room');
        if (!state || state.ended || state.expiresAt <= Date.now()) return 410;
        if (state.senderClient && state.senderClient !== client) return 409;
        state.senderClient = client; await storage.put('room', state); return 200;
      });
      if (bound !== 200) return new Response('Session unavailable', { status: bound });
    }
    let state = await this.ctx.storage.get('room');
    if (!state || state.ended || state.expiresAt <= Date.now()) return new Response('Session expired', { status: 410 });
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      for (const old of this.sockets('sender')) old.close(1000, 'Connection replaced');
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1], ['sender']);
      pair[1].serializeAttachment({ role: 'sender', count: 0, window: Date.now() });
      await this.notifyGroup(); return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (request.method === 'GET') {
      if (role === 'sender') {
        await this.renewActive(); state = await this.ctx.storage.get('room');
        if (!state || state.ended) return new Response('Session expired', { status: 410 });
        return Response.json({ multi: true, inviteExpiresAt: state.inviteExpiresAt, members: Object.entries(state.members).filter(([, m]) => m.ready).map(([id, m]) => ({ client: id, room: m.room, receiverHash: m.receiverHash, sender: m.sender })) });
      }
      if (state.closedClients?.includes(client)) return new Response('Recipient left', { status: 410 });
      if (!state.members[client] && state.inviteExpiresAt <= Date.now()) return new Response('Invitation expired', { status: 410 });
      return Response.json({ multi: true, peerPresent: this.sockets('sender').length > 0, inviteExpiresAt: state.inviteExpiresAt });
    }
    let body;
    try { body = await readBody(request, 2048); } catch { return new Response('Invalid request', { status: 400 }); }
    if (role === 'sender' && body?.type === 'end') { await this.setEnded(); return Response.json({ ended: true }); }
    if ((role === 'receiver' && body?.type === 'leave') || (role === 'sender' && body?.type === 'finished')) {
      const id = role === 'receiver' ? client : body.client;
      if (!/^[a-f0-9]{64}$/.test(id || '')) return new Response('Invalid client', { status: 400 });
      const member = await this.ctx.storage.transaction(async storage => {
        const current = await storage.get('room');
        if (!current || current.ended) return;
        const member = current.members[id]; delete current.members[id];
        current.closedClients = [...(current.closedClients || []).filter(value => value !== id), id].slice(-128); await storage.put('room', current); return member;
      });
      if (member) await this.endMember(member);
      await this.notifyGroup();
      return Response.json({ left: true });
    }
    if (role !== 'receiver' || body?.type !== 'join' || !/^[a-f0-9]{64}$/.test(body.room || '') || !/^[a-f0-9]{64}$/.test(body.receiverHash || '')) return new Response('Invalid request', { status: 400 });
    const reserved = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get('room');
      if (!current || current.ended || current.expiresAt <= Date.now()) return { status: 410 };
      if (current.closedClients?.includes(client)) return { status: 410 };
      const existing = current.members[client];
      if (existing) return existing.room === body.room && existing.receiverHash === body.receiverHash ? { member: existing } : { status: 409 };
      if (current.inviteExpiresAt <= Date.now()) return { status: 410 };
      if (Object.keys(current.members).length >= 10) return { status: 429 };
      const member = { room: body.room, receiverHash: body.receiverHash, sender: token(), ready: false };
      current.members[client] = member; await storage.put('room', current); return { member };
    });
    if (reserved.status) return new Response('Invitation unavailable', { status: reserved.status });
    // A recipient joining just before invitation expiry must get a recovery
    // lease immediately, without waiting for the next sender heartbeat.
    await this.renewActive();
    const member = reserved.member, child = this.child(member.room), senderHash = await digest(member.sender);
    const created = await child.initialize(senderHash, member.receiverHash);
    if (!created && !await child.belongsTo(senderHash, member.receiverHash)) {
      await this.removeReservation(client, member.sender); return new Response('Room already exists', { status: 409 });
    }
    const accepted = await this.ctx.storage.transaction(async storage => {
      const current = await storage.get('room');
      if (!current || current.ended || current.expiresAt <= Date.now() || current.members[client]?.sender !== member.sender) return false;
      current.members[client].ready = true; await storage.put('room', current); return true;
    });
    if (!accepted) { await child.setEnded(senderHash, member.receiverHash); return new Response('Session expired', { status: 410 }); }
    await this.notifyGroup();
    return Response.json({ multi: true, room: member.room });
  }
  async notifyGroup() {
    const state = await this.ctx.storage.get('room');
    if (!state || state.ended) return;
    const message = JSON.stringify({ type: 'members', multi: true, inviteExpiresAt: state.inviteExpiresAt,
      members: Object.entries(state.members).filter(([, member]) => member.ready).map(([client, member]) => ({ client, room: member.room, receiverHash: member.receiverHash, sender: member.sender })) });
    for (const socket of this.sockets('sender')) socket.send(message);
  }
  async removeReservation(client, sender) {
    await this.ctx.storage.transaction(async storage => {
      const current = await storage.get('room');
      if (current?.members[client]?.sender === sender) { delete current.members[client]; await storage.put('room', current); }
    });
  }
  async webSocketMessage(socket, data) {
    const state = await this.ctx.storage.get('room');
    if (!state || state.ended || state.expiresAt <= Date.now()) { socket.close(1008, 'Session expired'); return; }
    const meta = socket.deserializeAttachment();
    if (!this.sockets(meta.role).includes(socket)) return;
    if (typeof data !== 'string' || data.length > 128000) { socket.close(1009, 'Message too large'); return; }
    if (Date.now() - meta.window > 60000) { meta.window = Date.now(); meta.count = 0; }
    meta.count++; socket.serializeAttachment(meta);
    if (meta.count > 120) { socket.close(1008, 'Rate limit'); return; }
    try {
      const message = JSON.parse(data);
      if (message.type === 'keepalive') {
        await this.renewActive();
        socket.send(JSON.stringify({ type: 'keepalive' })); return;
      }
      if (message.type === 'leave' && meta.role === 'receiver') {
        // Explicitly leaving releases the recipient slot. An unexpected network
        // disconnect keeps the binding so recovery cannot be hijacked.
        await this.ctx.storage.transaction(async storage => {
          const current = await storage.get('room');
          if (current) { delete current.receiverClient; await storage.put('room', current); }
        });
        meta.left = true; socket.serializeAttachment(meta);
        for (const other of this.sockets('sender')) other.send(JSON.stringify({ type: 'receiver-left' }));
        socket.close(1000, 'Receiver left');
        return;
      }
      if (message.type === 'end' && meta.role === 'sender' && state.multi) { await this.setEnded(); return; }
      if (state.multi) throw Error('Invalid group message');
      if (message.type === 'end' && meta.role === 'sender') {
        await this.ctx.storage.transaction(async storage => {
          const current = await storage.get('room');
          if (current) { current.ended = true; await storage.put('room', current); }
        });
        for (const other of this.sockets('receiver')) { other.send(JSON.stringify({ type: 'ended' })); other.close(1000, 'Sender ended session'); }
        return;
      }
      if (message.type !== 'signal' || typeof message.payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(message.payload)) throw Error('Invalid signal');
      for (const other of this.sockets(meta.role === 'sender' ? 'receiver' : 'sender')) other.send(JSON.stringify({ type: 'signal', payload: message.payload }));
    } catch { socket.close(1008, 'Invalid message'); }
  }
  async webSocketClose(socket, code, reason) {
    const meta = socket.deserializeAttachment();
    if (code === 1005 || code === 1006 || code === 1015) code = 1000;
    try { socket.close(code, reason); } catch {}
    // A socket close can mean a network change. Keep room tokens valid until
    // explicit cancellation or expiry so both browsers can reconnect.
    if (reason === 'Connection replaced' || meta.left) return;
    const state = await this.ctx.storage.get('room');
    if (!state || state.ended) return;
    for (const other of this.sockets(meta.role === 'sender' ? 'receiver' : 'sender')) other.send(JSON.stringify({ type: 'peer-left' }));
  }
  async webSocketError(socket) { await this.webSocketClose(socket, 1011, 'Socket error'); }
  async renewActive() {
    const now = Date.now();
    const expiresAt = await this.ctx.storage.transaction(async storage => {
      const state = await storage.get('room');
      if (!state || state.ended || state.expiresAt <= now || !state.senderClient || !(state.multi ? Object.keys(state.members).length : state.receiverClient)) return;
      // Limit metadata/alarm updates to roughly once a minute. Existing rooms
      // retain their original invitation expiry when first renewed after upgrade.
      if (state.expiresAt - now > TTL - 60000) return;
      state.inviteExpiresAt ??= state.expiresAt;
      state.maxExpiresAt ??= state.inviteExpiresAt - TTL + MAX_ACTIVE_TTL;
      const extended = Math.min(now + TTL, state.maxExpiresAt);
      if (extended <= state.expiresAt) return;
      state.expiresAt = extended;
      await storage.put('room', state); return state.expiresAt;
    });
    if (expiresAt) await this.ctx.storage.setAlarm(expiresAt);
  }
  async alarm() {
    const state = await this.ctx.storage.get('room');
    if (state && !state.ended && state.expiresAt > Date.now()) { await this.ctx.storage.setAlarm(state.expiresAt); return; }
    if (state?.multi) await Promise.allSettled(Object.values(state.members).map(member => this.endMember(member)));
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'Session expired');
    await this.ctx.storage.deleteAll();
  }
}


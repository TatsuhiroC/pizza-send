import { DurableObject } from 'cloudflare:workers';

const TTL = 30 * 60 * 1000;
const MAX_ACTIVE_TTL = 24 * 60 * 60 * 1000;
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const blocked = new Map();
let eventWindow = 0, eventCounts = {};
function securityEvent(code) {
  const window = Math.floor(Date.now() / 60000);
  if (window !== eventWindow) {
    if (Object.keys(eventCounts).length) console.log(JSON.stringify({ event: 'security-summary', minute: eventWindow, counts: eventCounts }));
    eventWindow = window; eventCounts = {};
  }
  eventCounts[code] = Math.min((eventCounts[code] || 0) + 1, 1000000);
}
async function limited(env, binding, key) {
  // Binding counters run before Durable Object lookups. They are deliberately
  // permissive edge protection, not exact global accounting.
  if (!env[binding]) throw Error('Security binding unavailable');
  return !(await env[binding].limit({ key })).success;
}
function admission(env) { return env.ADMISSION.get(env.ADMISSION.idFromName('global-v1')); }

const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
async function readBody(request, limit = 4096) {
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
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid room configuration');
  if (value.challenge !== undefined && (typeof value.challenge !== 'string' || value.challenge.length > 2048)) throw Error('Invalid challenge');
  if (value.multi !== undefined && typeof value.multi !== 'boolean') throw Error('Invalid room configuration');
  if (value?.v !== 2 || !/^[a-f0-9]{64}$/.test(value.room) || !/^[a-f0-9]{64}$/.test(value.receiverHash)) throw Error('Invalid room configuration');
  return value;
}
function response(body, status, origin) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'vary': 'Origin', 'cache-control': 'no-store', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...(status === 429 || status === 503 ? { 'retry-after': '60' } : {}) } });
}
async function verifyChallenge(env, request, options, origin) {
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return false;
  if (!options?.challenge) return false;
  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: options.challenge,
      remoteip: request.headers.get('CF-Connecting-IP') || undefined })
  });
  if (!result.ok) return false;
  const data = await result.json();
  return data.success === true && data.hostname === new URL(origin).hostname && data.action === 'create-share' && data.cdata === options.room;
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ip = await digest(request.headers.get('CF-Connecting-IP') || 'local');
    const deny = (code, status, error) => { securityEvent(code); return response({ error }, status, origin || 'null'); };
    try {
      if (await limited(env, 'REQUEST_LIMITER', ip)) return deny('request-limit', 429, 'Too many requests');
      const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
      if (!allowed.includes(origin)) return deny('origin', 403, 'Origin not allowed');
      if (request.method === 'OPTIONS') return response({}, 204, origin);
      const url = new URL(request.url);
      if (url.pathname === '/rooms' && request.method === 'POST') {
        if (await limited(env, 'CREATE_LIMITER', ip)) return deny('create-edge-limit', 429, 'Too many requests');
        let options;
        try { options = await roomOptions(request); }
        catch { return deny('body', 400, 'Invalid room configuration'); }
        const decision = await env.LIMITS.get(env.LIMITS.idFromName(ip)).creation();
        if (!decision.allowed) return deny('create-limit', 429, 'Too many requests');
        if (decision.challenge) {
          if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) return deny('challenge-unavailable', 429, 'Too many requests');
          let passed = false;
          try { passed = await verifyChallenge(env, request, options, origin); } catch {}
          if (!passed) {
            securityEvent('challenge');
            return response({ error: 'Verification required', siteKey: env.TURNSTILE_SITE_KEY }, 428, origin);
          }
        }
        const room = options?.room || token(), sender = token(), receiver = options ? null : token();
        const guard = admission(env), reservation = await guard.reserve(room);
        if (!reservation.allowed) return deny('admission-' + reservation.reason, reservation.reason === 'duplicate' ? 409 : 503, reservation.reason === 'duplicate' ? 'Room already exists' : 'New shares temporarily paused');
        let created = false;
        try {
          created = await env.ROOMS.get(env.ROOMS.idFromName(room)).initialize(await digest(sender), options?.receiverHash || await digest(receiver), !!options?.multi, { room, lease: reservation.lease });
          if (!created) return deny('collision', 409, 'Room already exists');
        } finally { if (!created) await guard.release(room, reservation.lease); }
        return response({ v: options ? 2 : 1, ...(options?.multi ? { multi: true } : {}), room, sender, ...(receiver ? { receiver } : {}), expiresAt: Date.now() + TTL }, 201, origin);
      }
      const match = url.pathname.match(/^\/rooms\/([a-f0-9]{64})$/);
      if (!match || !['GET', 'POST'].includes(request.method)) return deny('route', 404, 'Not found');
      const websocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      const role = url.searchParams.get('role'), client = url.searchParams.get('client') || '';
      const credential = request.headers.get('Authorization')?.replace(/^Bearer /, '') || url.searchParams.get('token') || '';
      if (!['sender', 'receiver'].includes(role) || (client && !validToken(client)) || !(websocket && validToken(url.searchParams.get('ticket')) || validToken(credential))) return deny('credential-shape', 401, 'Unauthorized');
      for (const [key, expiry] of blocked) if (expiry <= Date.now()) blocked.delete(key);
      if (blocked.has(ip)) return deny('auth-block', 429, 'Too many requests');
      if (await limited(env, websocket ? 'HANDSHAKE_LIMITER' : request.method === 'POST' ? 'WRITE_LIMITER' : 'READ_LIMITER', ip)) return deny('route-limit', 429, 'Too many requests');
      let forwarded = request;
      if (request.method === 'POST') {
        let body;
        try { body = await readBody(request, 2048); } catch { return deny('body', 400, 'Invalid request'); }
        const headers = new Headers(request.headers); headers.delete('content-length');
        forwarded = new Request(request, { headers, body: JSON.stringify(body ?? {}) });
      }
      const result = await env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(forwarded);
      if (result.status === 401) {
        securityEvent('auth-failure');
        if (await limited(env, 'AUTH_FAILURE_LIMITER', ip)) {
          if (blocked.size >= 2048) blocked.delete(blocked.keys().next().value);
          blocked.set(ip, Date.now() + 60000);
        }
      }
      if (result.status === 101) return result;
      return new Response(result.body, { status: result.status, headers: { ...Object.fromEntries(result.headers), 'access-control-allow-origin': origin, 'vary': 'Origin', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
    } catch { return deny('unavailable', 503, 'Pairing temporarily unavailable'); }
  }
};
export class RateLimit extends DurableObject {
  async creation() {
    const result = await this.ctx.storage.transaction(async storage => {
      const now = Date.now(), bucket = await storage.get('bucket') || { at: now, count: 0 };
      if (now - bucket.at >= 60000) { bucket.at = now; bucket.count = 0; }
      bucket.count = Math.min(bucket.count + 1, 11); await storage.put('bucket', bucket);
      return { allowed: bucket.count <= 10, challenge: bucket.count > 3 };
    });
    await this.ctx.storage.setAlarm(Date.now() + 120000); return result;
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
export class Admission extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.runtime = env; }
  async reserve(room) {
    const limit = (key, fallback, maximum) => { const n = Number(this.runtime[key]); return Number.isInteger(n) && n > 0 ? Math.min(n, maximum) : fallback; };
    return this.ctx.storage.transaction(async storage => {
      const now = Date.now(), day = Math.floor(now / 86400000), minute = Math.floor(now / 60000);
      const state = await storage.get('admission') || { day, minute, daily: 0, burst: 0, active: {} };
      for (const [id, value] of Object.entries(state.active)) if (value.expires <= now) delete state.active[id];
      if (state.day !== day) { state.day = day; state.daily = 0; }
      if (state.minute !== minute) { state.minute = minute; state.burst = 0; }
      if (state.active[room]) return { allowed: false, reason: 'duplicate' };
      if (state.daily >= limit('MAX_SHARES_PER_DAY', 1000, 10000)) return { allowed: false, reason: 'daily' };
      if (state.burst >= limit('MAX_SHARES_PER_MINUTE', 60, 200)) return { allowed: false, reason: 'burst' };
      if (Object.keys(state.active).length >= limit('MAX_ACTIVE_SHARES', 128, 512)) return { allowed: false, reason: 'active' };
      const lease = token(); state.active[room] = { lease, expires: now + MAX_ACTIVE_TTL }; state.daily++; state.burst++;
      await storage.put('admission', state); return { allowed: true, lease };
    });
  }
  async release(room, lease) {
    await this.ctx.storage.transaction(async storage => {
      const state = await storage.get('admission');
      if (state?.active[room]?.lease === lease) { delete state.active[room]; await storage.put('admission', state); }
    });
  }
}
export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.runtime = env; }
  sockets(role) { return this.ctx.getWebSockets(role).filter(socket => socket.readyState === WebSocket.OPEN); }
  async initialize(sender, receiver, multi = false, reservation) {
    const created = await this.ctx.storage.transaction(async storage => {
      if (await storage.get('room')) return false;
      const now = Date.now();
      await storage.put('room', { sender, receiver, inviteExpiresAt: now + TTL, expiresAt: now + TTL, maxExpiresAt: now + MAX_ACTIVE_TTL, ended: false, ...(reservation ? { reservation } : {}), ...(multi ? { multi: true, members: {}, closedClients: [] } : {}) });
      return true;
    });
    if (created) await this.ctx.storage.setAlarm(Date.now() + TTL);
    return created;
  }
  async fetch(request) {
    const state = await this.ctx.storage.get('room');
    if (!state || state.ended || state.expiresAt <= Date.now()) return new Response('Session expired', { status: 410 });
    const url = new URL(request.url), role = url.searchParams.get('role'), client = url.searchParams.get('client') || '';
    if (!['sender', 'receiver'].includes(role)) return new Response('Unauthorized', { status: 401 });
    const ticket = url.searchParams.get('ticket');
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && ticket) {
      if (!await this.consumeTicket(ticket, role, client)) return new Response('Unauthorized', { status: 401 });
    } else {
      const secret = request.headers.get('Authorization')?.replace(/^Bearer /, '') || url.searchParams.get('token') || '';
      if (!validToken(secret) || await digest(secret) !== state[role]) return new Response('Unauthorized', { status: 401 });
    }
    if (client && !/^[a-f0-9]{64}$/.test(client)) return new Response('Invalid client', { status: 400 });
    if (request.method === 'POST') {
      let body;
      try { body = await readBody(request.clone(), 2048); } catch { return new Response('Invalid request', { status: 400 }); }
      if (body?.type === 'connect') return this.issueTicket(role, client);
    }
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
  async issueTicket(role, client) {
    if (!validToken(client)) return new Response('Invalid client', { status: 400 });
    return this.ctx.storage.transaction(async storage => {
      const state = await storage.get('room'), now = Date.now();
      if (!state || state.ended || state.expiresAt <= now) return new Response('Session expired', { status: 410 });
      if (state.multi && role !== 'sender') return new Response('Unauthorized', { status: 401 });
      if (state[role + 'Client'] && state[role + 'Client'] !== client) return new Response('Session occupied', { status: 409 });
      if (role === 'receiver' && !state.receiverClient && (state.inviteExpiresAt ?? state.expiresAt) <= now) return new Response('Invitation expired', { status: 410 });
      const tickets = (await storage.get('tickets') || []).filter(t => t.expires > now && !(t.role === role && t.client === client));
      const value = token(); tickets.push({ hash: await digest(value), role, client, expires: now + 30000 });
      await storage.put('tickets', tickets.slice(-8)); return Response.json({ ticket: value });
    });
  }
  async consumeTicket(value, role, client) {
    if (!validToken(value) || !validToken(client)) return false;
    const hash = await digest(value);
    return this.ctx.storage.transaction(async storage => {
      const tickets = await storage.get('tickets') || [], now = Date.now();
      const match = tickets.find(t => t.hash === hash && t.role === role && t.client === client && t.expires > now);
      if (!match) return false;
      await storage.put('tickets', tickets.filter(t => t !== match && t.expires > now)); return true;
    });
  }
  async releaseReservation(state) {
    if (state?.reservation) await admission(this.runtime).release(state.reservation.room, state.reservation.lease);
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
    await this.ctx.storage.setAlarm(Date.now());
    for (const socket of this.sockets()) { socket.send(JSON.stringify({ type: 'ended' })); socket.close(1000, 'Sender ended session'); }
    if (state.multi) {
      const closed = await Promise.allSettled(Object.values(state.members).map(member => this.endMember(member)));
      if (closed.some(result => result.status === 'rejected')) return; // The alarm retries before releasing admission.
    }
    await this.releaseReservation(state);
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
    if (reserved.status === 429) return Response.json({ error: 'Recipient limit reached' }, { status: 429 });
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
        await this.releaseReservation(state); await this.ctx.storage.setAlarm(Date.now());
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
    if (state?.multi) {
      const closed = await Promise.allSettled(Object.values(state.members).map(member => this.endMember(member)));
      if (closed.some(result => result.status === 'rejected')) throw Error('Cleanup temporarily unavailable');
    }
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'Session expired');
    await this.releaseReservation(state);
    await this.ctx.storage.deleteAll();
  }
}


import { DurableObject } from 'cloudflare:workers';

const TTL = 30 * 60 * 1000;
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
function response(body, status, origin) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, 'vary': 'Origin', 'cache-control': 'no-store', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
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
      const room = token(), sender = token(), receiver = token();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      await stub.initialize(await digest(sender), await digest(receiver));
      return response({ room, sender, receiver, expiresAt: Date.now() + TTL }, 201, origin);
    }
    const match = url.pathname.match(/^\/rooms\/([a-f0-9]{64})$/);
    if (!match || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return response({ error: 'Not found' }, 404, origin);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
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
  async initialize(sender, receiver) {
    if (await this.ctx.storage.get('room')) throw Error('Room already exists');
    await this.ctx.storage.put('room', { sender, receiver, expiresAt: Date.now() + TTL, ended: false });
    await this.ctx.storage.setAlarm(Date.now() + TTL);
  }
  async fetch(request) {
    const state = await this.ctx.storage.get('room');
    if (!state || state.ended || state.expiresAt <= Date.now()) return new Response('Session expired', { status: 410 });
    const url = new URL(request.url), role = url.searchParams.get('role'), secret = url.searchParams.get('token') || '';
    if (!['sender', 'receiver'].includes(role) || !/^[a-f0-9]{64}$/.test(secret) || await digest(secret) !== state[role]) return new Response('Unauthorized', { status: 401 });
    if (this.ctx.getWebSockets(role).length) return new Response('Session already occupied', { status: 409 });
    if (role === 'receiver' && !this.ctx.getWebSockets('sender').length) return new Response('Sender is offline', { status: 410 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment({ role, count: 0, window: Date.now() });
    const opposite = role === 'sender' ? 'receiver' : 'sender';
    for (const other of this.ctx.getWebSockets(opposite)) other.send(JSON.stringify({ type: 'peer-ready' }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(socket, data) {
    const state = await this.ctx.storage.get('room');
    if (!state || state.ended || state.expiresAt <= Date.now()) { socket.close(1008, 'Session expired'); return; }
    const meta = socket.deserializeAttachment();
    if (typeof data !== 'string' || data.length > 128000) { socket.close(1009, 'Message too large'); return; }
    if (Date.now() - meta.window > 60000) { meta.window = Date.now(); meta.count = 0; }
    meta.count++; socket.serializeAttachment(meta);
    if (meta.count > 30) { socket.close(1008, 'Rate limit'); return; }
    try {
      const message = JSON.parse(data);
      if (message.type !== 'signal' || typeof message.payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(message.payload)) throw Error('Invalid signal');
      for (const other of this.ctx.getWebSockets(meta.role === 'sender' ? 'receiver' : 'sender')) other.send(JSON.stringify({ type: 'signal', payload: message.payload }));
    } catch { socket.close(1008, 'Invalid message'); }
  }
  async webSocketClose(socket, code, reason) {
    const meta = socket.deserializeAttachment();
    if (code === 1005 || code === 1006 || code === 1015) code = 1000;
    try { socket.close(code, reason); } catch {}
    if (meta.role === 'sender') {
      const state = await this.ctx.storage.get('room');
      if (state) { state.ended = true; await this.ctx.storage.put('room', state); }
      for (const other of this.ctx.getWebSockets('receiver')) { other.send(JSON.stringify({ type: 'peer-left' })); other.close(1000, 'Sender left'); }
    } else {
      for (const other of this.ctx.getWebSockets('sender')) other.send(JSON.stringify({ type: 'peer-left' }));
    }
  }
  async webSocketError(socket) { await this.webSocketClose(socket, 1011, 'Socket error'); }
  async alarm() {
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'Session expired');
    await this.ctx.storage.deleteAll();
  }
}


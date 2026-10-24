import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import { webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import { createServer } from 'node:http';
const hex = (n: number) => n.toString(16).padStart(64, '0');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const origin = 'https://pizzasend.dpdns.org';
function memory() {
  const data = new Map<string, any>(); let lock = Promise.resolve();
  const storage = { get: async (k: string) => structuredClone(data.get(k)), put: async (k: string, v: any) => { data.set(k, structuredClone(v)); },
    transaction: (fn: any) => { const next = lock.then(() => fn(storage)); lock = next.then(() => {}, () => {}); return next; },
    setAlarm: async (_: number) => {}, deleteAll: async () => { data.clear(); } };
  return { data, storage, getWebSockets: () => [] };
}
async function fixture(overrides: any = {}) {
  const clock = { now: 1000000 }, logs: string[] = [], access = { rooms: 0, limits: 0, siteverify: 0 }, stores = new Map<string, any>(), rooms = new Map<string, any>();
  class Clock extends Date { static now() { return clock.now; } }
  const scope: any = { Date: Clock, crypto: webcrypto, TextEncoder, TextDecoder, Request, Headers, Response, URL, AbortSignal, WebSocket: { OPEN: 1 },
    console: { log: (s: string) => logs.push(s) }, fetch: async () => { access.siteverify++; return Response.json(scope.verification); },
    DurableObject: class { ctx: any; constructor(ctx: any) { this.ctx = ctx; } } };
  const source = (await readFile('signal/worker.js', 'utf8')).replace("import { DurableObject } from 'cloudflare:workers';", '').replace('export default', 'const handler =').replaceAll('export class', 'class');
  vm.runInNewContext(source + '\nglobalThis.exports = { handler, Room, Admission, RateLimit };', scope);
  const counts = new Map<string, number>();
  const rate = (name: string, max: number) => ({ limit: async ({ key }: any) => { const id = name + key, count = (counts.get(id) || 0) + 1; counts.set(id, count); return { success: count <= max }; } });
  const env: any = { ALLOWED_ORIGINS: origin, REQUEST_LIMITER: rate('all', 600), CREATE_LIMITER: rate('create', 10), READ_LIMITER: rate('read', 180), WRITE_LIMITER: rate('write', 120), HANDSHAKE_LIMITER: rate('handshake', 90), AUTH_FAILURE_LIMITER: rate('auth', 30), ...overrides };
  const gateContext = memory(), gate = new scope.exports.Admission(gateContext, env);
  env.ADMISSION = { idFromName: (s: string) => s, get: () => gate };
  env.LIMITS = { idFromName: (s: string) => s, get: (s: string) => { access.limits++; if (!stores.has(s)) stores.set(s, new scope.exports.RateLimit(memory(), env)); return stores.get(s); } };
  env.ROOMS = { idFromName: (s: string) => s, get: (s: string) => { access.rooms++; if (!rooms.has(s)) rooms.set(s, new scope.exports.Room(memory(), env)); return rooms.get(s); } };
  const request = (path: string, init: RequestInit = {}, ip = 'test-ip') => {
    const headers = new Headers({ Origin: origin, 'CF-Connecting-IP': ip });
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    return scope.exports.handler.fetch(new Request('https://signal.test' + path, { ...init, headers }), env);
  };
  const create = (id: number, ip = 'test-ip', challenge?: string) => request('/rooms', { method: 'POST', body: JSON.stringify({ v: 2, room: hex(id), receiverHash: hash(hex(900)), ...(challenge ? { challenge } : {}) }) }, ip);
  return { ...scope.exports, scope, env, clock, logs, access, gate, gateContext, request, create, rooms };
}
test('malformed credentials, large bodies and edge creation limits stop before room storage', async () => {
  const f = await fixture();
  expect((await f.request('/rooms/' + hex(1) + '?role=sender&token=bad')).status).toBe(401);
  expect((await f.request('/rooms', { method: 'POST', body: 'a'.repeat(4097) })).status).toBe(400);
  expect(f.access.rooms).toBe(0); expect(f.access.limits).toBe(0);
  f.env.CREATE_LIMITER = { limit: async () => ({ success: false }) };
  expect((await f.create(2)).status).toBe(429); expect(f.access.limits).toBe(0);
});
test('read and handshake budgets apply across room IDs; Origin does not grant authentication', async () => {
  const f = await fixture();
  for (let i = 0; i < 181; i++) {
    const result = await f.request('/rooms/' + hex(i + 1) + '?role=sender', { headers: { Authorization: 'Bearer ' + hex(900) } });
    expect(result.status).toBe(i < 180 ? 410 : 429);
  }
  expect(f.access.rooms).toBe(180);
  f.env.HANDSHAKE_LIMITER = { limit: async () => ({ success: false }) };
  expect((await f.request('/rooms/' + hex(900) + '?role=sender&client=' + hex(1) + '&ticket=' + hex(2), { headers: { Upgrade: 'websocket' } })).status).toBe(429);
  expect(f.access.rooms).toBe(180);
});
test('failed credentials are temporarily blocked before further room lookups', async () => {
  const f = await fixture(); await f.create(1);
  for (let i = 0; i < 31; i++) expect((await f.request('/rooms/' + hex(1) + '?role=sender', { headers: { Authorization: 'Bearer ' + hex(902) } })).status).toBe(401);
  const reads = f.access.rooms;
  expect((await f.request('/rooms/' + hex(1) + '?role=sender&token=' + hex(902))).status).toBe(429); expect(f.access.rooms).toBe(reads);
  f.clock.now += 60001;
  expect((await f.request('/rooms/' + hex(1) + '?role=sender&token=' + hex(902))).status).toBe(401);
});
test('global active cap is atomic; lease-checked release cannot free another share', async () => {
  const f = await fixture({ MAX_ACTIVE_SHARES: '2' });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.gate.reserve(hex(i + 1))));
  expect(results.filter(r => r.allowed)).toHaveLength(2);
  await f.gate.release(hex(1), 'wrong'); expect((await f.gate.reserve(hex(99))).reason).toBe('active');
  await f.gate.release(hex(1), results[0].lease); expect((await f.gate.reserve(hex(99))).allowed).toBe(true);
});
test('daily and burst budgets persist after release; UTC reset preserves active reservations', async () => {
  const f = await fixture({ MAX_SHARES_PER_DAY: '2', MAX_SHARES_PER_MINUTE: '1' });
  const first = await f.gate.reserve(hex(1)); await f.gate.release(hex(1), first.lease);
  expect((await f.gate.reserve(hex(2))).reason).toBe('burst'); f.clock.now += 60000;
  expect((await f.gate.reserve(hex(2))).allowed).toBe(true); f.clock.now += 60000;
  expect((await f.gate.reserve(hex(3))).reason).toBe('daily');
  f.clock.now = 86400001; expect((await f.gate.reserve(hex(3))).allowed).toBe(true);
  expect(Object.keys(f.gateContext.data.get('admission').active)).toHaveLength(2);
  f.clock.now += 86400001; expect((await f.gate.reserve(hex(4))).allowed).toBe(true);
  expect(Object.keys(f.gateContext.data.get('admission').active)).toHaveLength(1);
});
test('full creation budget leaves existing authenticated sessions and connection tickets usable', async () => {
  const f = await fixture({ MAX_SHARES_PER_DAY: '1' }), created = await (await f.create(1)).json();
  expect((await f.create(2)).status).toBe(503);
  const path = '/rooms/' + hex(1) + '?role=sender&client=' + hex(7);
  expect((await f.request(path, { headers: { Authorization: 'Bearer ' + created.sender } })).status).toBe(200);
  expect((await f.request(path, { method: 'POST', headers: { Authorization: 'Bearer ' + created.sender }, body: JSON.stringify({ type: 'connect' }) })).status).toBe(200);
});
test('conditional verification validates hostname, action and room server-side before allocation', async () => {
  const f = await fixture({ TURNSTILE_SITE_KEY: 'public-site-key', TURNSTILE_SECRET_KEY: 'private-secret' });
  for (let i = 1; i <= 3; i++) expect((await f.create(i)).status).toBe(201);
  const access = f.access.rooms;
  expect((await f.create(4)).status).toBe(428); expect(f.access.siteverify).toBe(0);
  for (const wrong of [{ success: false }, { hostname: 'evil.test' }, { action: 'wrong' }, { cdata: hex(5) }]) {
    f.scope.verification = { success: true, hostname: 'pizzasend.dpdns.org', action: 'create-share', cdata: hex(4), ...wrong };
    expect((await f.create(4, 'test-ip', 'fake-token')).status).toBe(428); expect(f.access.rooms).toBe(access);
  }
  f.scope.verification = { success: true, hostname: 'pizzasend.dpdns.org', action: 'create-share', cdata: hex(4) };
  expect((await f.create(4, 'test-ip', 'real-token')).status).toBe(201);
});
test('unavailable verification fails closed, malformed legacy payloads do not allocate rooms', async () => {
  const f = await fixture();
  for (const body of ['[]', '"invalid"', '123', 'false', '0']) expect((await f.request('/rooms', { method: 'POST', body })).status).toBe(400);
  for (let i = 1; i <= 3; i++) await f.create(i);
  expect((await f.create(4)).status).toBe(429);
  const g = await fixture({ TURNSTILE_SITE_KEY: 'public-site-key', TURNSTILE_SECRET_KEY: 'private' });
  for (let i = 1; i <= 3; i++) await g.create(i);
  g.scope.fetch = async () => { throw Error('secret-bearing upstream error'); };
  expect((await g.create(4, 'test-ip', 'fake')).status).toBe(428);
  expect(g.access.rooms).toBe(3);
});
test('short-lived connection ticket is role/client-bound, single-use, and rejected after expiry or ending', async () => {
  const f = await fixture(), created = await (await f.create(1)).json(), room = f.rooms.get(hex(1));
  const issue = () => f.request('/rooms/' + hex(1) + '?role=sender&client=' + hex(7), { method: 'POST', headers: { Authorization: 'Bearer ' + created.sender }, body: JSON.stringify({ type: 'connect' }) });
  const first = await (await issue()).json();
  expect(await room.consumeTicket(first.ticket, 'receiver', hex(7))).toBe(false);
  expect(await room.consumeTicket(first.ticket, 'sender', hex(8))).toBe(false);
  expect(await room.consumeTicket(first.ticket, 'sender', hex(7))).toBe(true);
  expect(await room.consumeTicket(first.ticket, 'sender', hex(7))).toBe(false);
  const second = await (await issue()).json(); f.clock.now += 30001;
  expect(await room.consumeTicket(second.ticket, 'sender', hex(7))).toBe(false);
  await room.setEnded(); expect((await issue()).status).toBe(410);
  expect(Object.keys(f.gateContext.data.get('admission').active)).toHaveLength(0);
});
test('aggregate security logs omit URLs, secrets, raw IPs and upstream errors; automatic URL logs disabled', async () => {
  const f = await fixture(); await f.request('/rooms/' + hex(1) + '?role=sender&token=private-marker', {}, 'private-ip');
  f.clock.now += 60001; await f.request('/missing');
  expect(f.logs.join('')).toContain('credential-shape');
  for (const value of ['private-marker', 'private-ip', 'https:', 'token=']) expect(f.logs.join('')).not.toContain(value);
  const config = JSON.parse(await readFile('signal/wrangler.jsonc', 'utf8'));
  expect(config.observability.logs.invocation_logs).toBe(false);
});
test('missing security binding returns a safe failure instead of bypassing protection', async () => {
  const f = await fixture({ REQUEST_LIMITER: undefined }); expect((await f.create(1)).status).toBe(503); expect(f.access.rooms).toBe(0);
});

test('real transfer and recovery preserve original files; credentials stay out of request URLs', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'Real WebRTC transfer is covered by Chromium; this WebKit runner lacks transport support.');
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    const Peer = RTCPeerConnection; (window as any).__pcs = [];
    (window as any).RTCPeerConnection = class extends Peer { constructor(c: any) { super(c); (window as any).__pcs.push(this); } };
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  const requests: { url: string; auth: string | undefined }[] = [], sockets: string[] = [];
  context.on('request', r => { if (new URL(r.url()).pathname.startsWith('/rooms')) requests.push({ url: r.url(), auth: r.headers().authorization }); });
  const receiver = await context.newPage(), second = await context.newPage();
  for (const p of [page, receiver, second]) p.on('websocket', ws => { if (new URL(ws.url()).pathname.startsWith('/rooms/')) sockets.push(ws.url()); });
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'security-original.txt', mimeType: 'text/plain', buffer: Buffer.from('same original bytes') });
  await page.locator('#start-send').click(); await expect(page.locator('#share-qr')).toBeVisible();
  const link = await page.locator('#share-link').inputValue();
  await receiver.goto(link); await expect(receiver.locator('#accept-files')).toBeVisible();
  await receiver.evaluate(() => (window as any).__pcs.at(-1).close());
  await expect.poll(() => receiver.evaluate(() => (window as any).__pcs.length), { timeout: 40000 }).toBeGreaterThan(1);
  await expect.poll(() => receiver.evaluate(() => (window as any).__pcs.at(-1).connectionState), { timeout: 40000 }).toBe('connected');
  await second.goto(link); await expect(second.locator('#accept-files')).toBeVisible();
  await receiver.locator('#accept-files').click(); await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click(); const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe('security-original.txt'); expect((await readFile((await downloaded.path())!)).toString()).toBe('same original bytes');
  expect(requests.length).toBeGreaterThan(5); expect(requests.every(r => !new URL(r.url).searchParams.has('token'))).toBe(true);
  expect(requests.filter(r => new URL(r.url).pathname !== '/rooms').every(r => /^Bearer [a-f0-9]{64}$/.test(r.auth || ''))).toBe(true);
  expect(sockets.length).toBeGreaterThan(3); expect(sockets.every(url => !new URL(url).searchParams.has('token') && /^[a-f0-9]{64}$/.test(new URL(url).searchParams.get('ticket') || ''))).toBe(true);
  await receiver.setViewportSize({ width: 320, height: 800 });
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#cancel').click();
});

test('conditional challenge loads only on demand, retries with token and cancels without a stale callback creating a share', async ({ page, context }) => {
  await context.addInitScript(() => localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'));
  let creations = 0, submitted = '', scripts = 0;
  await page.route('**/rooms', route => {
    if (route.request().method() !== 'POST') return route.continue();
    creations++; submitted = route.request().postDataJSON().challenge;
    return route.fulfill({ status: submitted ? 503 : 428, contentType: 'application/json', body: JSON.stringify(submitted ? { error: 'New shares temporarily paused' } : { siteKey: 'public-site-key' }) });
  });
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => { scripts++; return route.fulfill({ contentType: 'text/javascript', body: 'window.turnstile={render:(node,options)=>{window.__challenge=options;return "widget"},remove:()=>{}}' }); });
  await page.goto('./'); expect(scripts).toBe(0);
  await page.locator('#file-input').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') }); await page.locator('#start-send').click();
  await expect(page.locator('#verification-dialog')).toBeVisible(); await expect.poll(() => page.evaluate(() => !!(window as any).__challenge)).toBe(true);
  await page.evaluate(() => (window as any).__challenge.callback('server-validated-token'));
  await expect(page.locator('#notice')).toContainText('服务限额'); expect(submitted).toBe('server-validated-token'); expect(creations).toBe(2); expect(scripts).toBe(1);
  await page.locator('#cancel').click(); await page.locator('#start-send').click(); await expect(page.locator('#verification-dialog')).toBeVisible();
  await page.locator('#cancel-verification').click(); await expect(page.locator('#verification-dialog')).toBeHidden();
  await page.evaluate(() => (window as any).__challenge.callback('too-late'));
  await expect(page.locator('#notice')).toContainText('验证已取消'); expect(creations).toBe(3); expect(scripts).toBe(1);
});
test('challenge script failure shows an actionable message and closes its dialog', async ({ page, context }) => {
  await context.addInitScript(() => localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'));
  await page.route('**/rooms', r => r.fulfill({ status: 428, contentType: 'application/json', body: JSON.stringify({ siteKey: 'public-site-key' }) }));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', r => r.abort());
  await page.goto('./'); await page.locator('#file-input').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') }); await page.locator('#start-send').click();
  await expect(page.locator('#notice')).toContainText('验证服务暂不可用'); await expect(page.locator('#verification-dialog')).toBeHidden();
});

test('cleanup failures retain admission until child closure succeeds and alarm retries', async () => {
  const f = await fixture(); await f.create(1); const root = f.rooms.get(hex(1));
  const state = await root.ctx.storage.get('room'); state.multi = true; state.members = { guest: { room: hex(2), sender: hex(500), receiverHash: hash(hex(501)) } }; await root.ctx.storage.put('room', state);
  let failing = true;
  f.env.ROOMS.get = () => ({ belongsTo: async () => true, setEnded: async () => { if (failing) throw Error('temporary'); } });
  await root.setEnded(); expect(Object.keys(f.gateContext.data.get('admission').active)).toHaveLength(1);
  const failure = await root.alarm().then(() => '', (e: Error) => e.message); expect(failure).toBe('Cleanup temporarily unavailable');
  failing = false; await root.alarm(); expect(Object.keys(f.gateContext.data.get('admission').active)).toHaveLength(0); expect(await root.ctx.storage.get('room')).toBeUndefined();
});
test('recipient capacity, request limiting and backend outages keep distinct explanations', async ({ page, context }) => {
  await context.addInitScript(() => localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'));
  let reason = 'Too many requests', status = 429;
  await page.route(url => url.pathname.startsWith('/rooms'), route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: reason }) }));
  await page.goto('./');
  const request = () => page.evaluate(async () => {
    const { groupRequest } = await import('/src/group.ts');
    try { await groupRequest('http://127.0.0.1:8787/rooms/' + 'a'.repeat(64) + '?role=receiver&token=' + 'b'.repeat(64)); return ''; } catch (e) { return (e as Error).message; }
  });
  expect(await request()).toContain('请求过于频繁'); reason = 'Recipient limit reached'; expect(await request()).toContain('10 位');
  reason = 'Pairing temporarily unavailable'; status = 503;
  await page.locator('#file-input').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') }); await page.locator('#start-send').click();
  await expect(page.locator('#notice')).toContainText('配对服务暂不可用'); await expect(page.locator('#notice')).not.toContainText('服务限额');
});

// Validate the deployed allowlist, rather than only the fixture's default.
test('production signaling accepts the custom frontend origin and rejects the retired Pages origin', async () => {
  const config = JSON.parse(await readFile('signal/wrangler.jsonc', 'utf8'));
  const f = await fixture({ ALLOWED_ORIGINS: config.vars.ALLOWED_ORIGINS });
  const allowed = await f.request('/rooms', { method: 'OPTIONS' });
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get('access-control-allow-origin')).toBe(origin);
  expect(allowed.headers.get('access-control-max-age')).toBe('600');
  const retired = await f.request('/rooms', { method: 'OPTIONS', headers: { Origin: 'https://tatsuhiroc.github.io' } });
  expect(retired.status).toBe(403);
  expect(retired.headers.has('access-control-max-age')).toBe(false);
  expect(f.access.rooms).toBe(0);
});

test('browser reuses preflight permission beyond five seconds while every request still needs credentials', async ({ browser }) => {
  const f = await fixture(), creation = await f.create(1), created = await creation.json();
  expect(creation.status).toBe(201); expect(creation.headers.has('access-control-max-age')).toBe(false);
  // Request interception can suppress native preflights. Use an un-routed
  // context so this exercises the browser's actual CORS permission cache.
  const context = await browser.newContext(), page = await context.newPage();
  await context.addInitScript(() => localStorage.setItem('pizza-send-signal', ''));
  await page.goto('./');
  f.env.ALLOWED_ORIGINS = new URL(page.url()).origin;
  let preflights = 0, requests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'OPTIONS') preflights++; else requests++;
      const result = await f.request(request.url!, { method: request.method, headers: {
        Origin: request.headers.origin || '', Authorization: request.headers.authorization || ''
      } });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No test address');
    const url = `http://127.0.0.1:${address.port}/rooms/${hex(1)}?role=sender`;
    const get = (credential: string) => page.evaluate(async ({ url, credential }) => {
      const response = await fetch(url, { headers: { Authorization: 'Bearer ' + credential } });
      await response.text();
      return { status: response.status, cache: response.headers.get('cache-control') };
    }, { url, credential });
    expect(await get(created.sender)).toEqual({ status: 200, cache: 'no-store' });
    // The previous omitted Max-Age falls back to five seconds in the browser.
    await new Promise(resolve => setTimeout(resolve, 5500));
    expect(await get(created.sender)).toEqual({ status: 200, cache: 'no-store' });
    expect(await get(hex(999))).toEqual({ status: 401, cache: 'no-store' });
    // Even a still-cached preflight cannot bypass a changed server allowlist.
    f.env.ALLOWED_ORIGINS = 'https://different.invalid';
    expect(await get(created.sender)).toEqual({ status: 403, cache: 'no-store' });
    expect(preflights).toBe(1); expect(requests).toBe(4);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

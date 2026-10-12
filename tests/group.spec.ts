import { test, expect, type BrowserContext, type Page } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function setup(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    const Peer = RTCPeerConnection, Socket = WebSocket, state = window as any;
    state.__pcs = []; state.__sockets = []; state.__starts = []; state.__ack = 0;
    state.RTCPeerConnection = class extends Peer { constructor(c: any) { super(c); state.__pcs.push(this); } };
    state.WebSocket = class extends Socket { constructor(url: string, p?: string | string[]) { super(url, p); state.__sockets.push(this); } };
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: any) {
      if (typeof data === 'string') { const m = JSON.parse(data); if (m.type === 'file-start') state.__starts.push(m); if (m.type === 'ack') state.__ack = m.bytes; }
      return send.call(this, data);
    } as any;
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function() { if (this.size <= 32768) await new Promise(r => setTimeout(r, 3)); return read.call(this); };
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
  });
}
async function share(sender: Page, buffer: Buffer) {
  await sender.goto('./');
  await sender.locator('#file-input').setInputFiles({ name: '多人-原样.mp4', mimeType: 'video/mp4', buffer });
  await sender.locator('#start-send').click();
  await expect(sender.locator('#share-qr')).toBeVisible();
  return sender.locator('#share-link').inputValue();
}
async function join(receiver: Page, url: string) { await receiver.goto(url); await expect(receiver.locator('#accept-files')).toBeVisible(); }
async function downloaded(receiver: Page, buffer: Buffer) {
  await expect(receiver.locator('#status')).toHaveText('传输完成，原样送达。', { timeout: 60000 });
  const result = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  const download = await result;
  expect(download.suggestedFilename()).toBe('多人-原样.mp4');
  expect(hash(await readFile((await download.path())!))).toBe(hash(buffer));
}
test('three concurrent receivers: independent progress and recovery, verified original files, same invitation for a later receiver', async ({ page, context }) => {
  await setup(context);
  const receivers = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  const errors: string[] = []; for (const p of [page, ...receivers]) p.on('pageerror', e => errors.push(e.message));
  const buffer = Buffer.alloc(12 * 1048576, 81), url = await share(page, buffer);
  const rootRoom = await page.evaluate(async url => (await (await import('/src/share.ts')).parseShare(new URL(url).hash)).room, url);
  let parentReads = 0;
  page.on('request', r => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/rooms/' + rootRoom) parentReads++; });
  await Promise.all(receivers.map(r => join(r, url)));
  await Promise.all(receivers.map(r => r.locator('#accept-files').click()));
  await expect(page.locator('.recipient-row[data-phase="sending"]')).toHaveCount(3);
  await expect.poll(() => receivers[0].evaluate(() => (window as any).__ack)).toBeGreaterThan(1048576);
  await receivers[0].evaluate(() => { const s = window as any; s.__pcs.at(-1).close(); for (const ws of s.__sockets) if (ws.url.includes('/rooms/')) ws.close(); });
  await expect.poll(() => page.evaluate(() => (window as any).__starts.some((s: any) => s.offset > 0)), { timeout: 40000 }).toBe(true);
  await Promise.all(receivers.map(r => downloaded(r, buffer)));
  await expect(page.locator('.recipient-row[data-phase="done"]')).toHaveCount(3);
  for (const r of receivers.slice(1)) expect(await r.evaluate(() => (window as any).__pcs.length)).toBe(1);
  expect(await page.locator('#share-link').inputValue()).toBe(url);
  await expect(page.locator('#share-qr')).toBeVisible();
  // Healthy membership updates use one WebSocket instead of HTTP polling.
  expect(parentReads).toBeLessThanOrEqual(1);
  const late = await context.newPage(); await join(late, url); await late.locator('#accept-files').click(); await downloaded(late, buffer);
  await expect(page.locator('.recipient-row[data-phase="done"]')).toHaveCount(4);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('one recipient cancels during transfer while another finishes; ending the share rejects all later joins', async ({ page, context }) => {
  await setup(context);
  const a = await context.newPage(), b = await context.newPage(), buffer = Buffer.alloc(8 * 1048576, 29), url = await share(page, buffer);
  await Promise.all([join(a, url), join(b, url)]);
  await Promise.all([a.locator('#accept-files').click(), b.locator('#accept-files').click()]);
  await expect(page.locator('.recipient-row[data-phase="sending"]')).toHaveCount(2);
  await a.locator('#cancel').click();
  await downloaded(b, buffer);
  await expect(page.locator('.recipient-row[data-phase="left"]')).toHaveCount(1);
  await expect(page.locator('.recipient-row[data-phase="done"]')).toHaveCount(1);
  const waiting = await context.newPage(); await join(waiting, url);
  await page.locator('#cancel').click();
  await expect(waiting.locator('#notice')).toContainText(/结束|关闭|取消/);
  const later = await context.newPage(); await later.goto(url);
  await expect(later.locator('#notice')).toContainText(/已过期|已结束/);
  await expect(later.locator('#accept-files')).toBeHidden();
});
test('group API isolates receiver credentials, enforces ten slots and releases only the requesting recipient', async ({ page, context }) => {
  await setup(context); await page.goto('./');
  const result = await page.evaluate(async () => {
    const s = await import('/src/share.ts'), p = await import('/src/protocol.ts'), g = await import('/src/group.ts');
    const api = 'http://127.0.0.1:8787', secret = p.randomToken(), root = await s.deriveShare(secret);
    const created = await (await fetch(api + '/rooms', { method: 'POST', body: JSON.stringify({ v: 2, room: root.room, receiverHash: await s.receiverDigest(root.receiver), multi: true }) })).json();
    const host = g.groupURL(api, root.room, 'sender', created.sender, p.randomToken()); await fetch(host);
    const guests = await Promise.all(Array.from({ length: 11 }, async () => {
      const client = p.randomToken(), child = await s.deriveRecipientShare(secret, client);
      return { url: g.groupURL(api, root.room, 'receiver', root.receiver, client), client, child };
    }));
    const statuses = await Promise.all(guests.slice(0, 10).map(async guest => (await fetch(guest.url, { method: 'POST', body: JSON.stringify({ type: 'join', room: guest.child.room, receiverHash: await s.receiverDigest(guest.child.receiver) }) })).status));
    const receiverView = await (await fetch(guests[0].url)).json();
    const join = async (i: number) => (await fetch(guests[i].url, { method: 'POST', body: JSON.stringify({ type: 'join', room: guests[i].child.room, receiverHash: await s.receiverDigest(guests[i].child.receiver) }) })).status;
    const full = await join(10), duplicate = await join(0);
    await fetch(guests[0].url, { method: 'POST', body: JSON.stringify({ type: 'leave', client: guests[1].client }) });
    const closed = await join(0), freed = await join(10), members = (await (await fetch(host)).json()).members;
    const takeover = (await fetch(g.groupURL(api, root.room, 'sender', created.sender, p.randomToken()))).status;
    const crossCredential = (await fetch(g.groupURL(api, guests[1].child.room, 'receiver', guests[2].child.receiver, guests[1].client))).status;
    const forbiddenEnd = (await fetch(guests[1].url, { method: 'POST', body: JSON.stringify({ type: 'end' }) })).status;
    const tooLarge = (await fetch(guests[1].url, { method: 'POST', body: JSON.stringify({ type: 'join', data: 'a'.repeat(3000) }) })).status;
    await fetch(host, { method: 'POST', body: JSON.stringify({ type: 'end' }) });
    const ended = (await fetch(guests[1].url)).status;
    return { statuses, receiverView, full, duplicate, closed, freed, count: members.length, otherRetained: members.some((m: any) => m.client === guests[1].client), uniqueKeys: new Set(guests.map(x => x.child.secret)).size, takeover, crossCredential, forbiddenEnd, tooLarge, ended };
  });
  expect(result.statuses).toEqual(Array(10).fill(200));
  expect(result.receiverView).not.toHaveProperty('members');
  expect(result.receiverView).not.toHaveProperty('sender');
  expect(result).toMatchObject({ full: 429, duplicate: 200, closed: 410, freed: 200, count: 10, otherRetained: true, uniqueKeys: 11, takeover: 409, crossCredential: 401, forbiddenEnd: 400, tooLarge: 400, ended: 410 });
});

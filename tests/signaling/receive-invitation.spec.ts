import { test, expect } from '../fixtures';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';

test('receiver QR opens an existing sender share and preserves download bytes', async ({ page: sender, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await sender.setViewportSize({ width: 375, height: 812 });
  const receiver = await context.newPage();
  await receiver.setViewportSize({ width: 375, height: 812 });
  await Promise.all([sender.goto('./'), receiver.goto('./')]);
  const payload = { name: 'PizzaSend-扫码.txt', mimeType: 'text/plain', buffer: Buffer.from('反向扫码配对 🍕') };
  await sender.locator('#file-input').setInputFiles(payload);
  await sender.locator('#start-send').click();
  const scan = sender.getByRole('button', { name: '扫描接收二维码' });
  await expect(scan).toBeVisible();
  const share = await sender.locator('#share-link').inputValue();
  await expect(sender.locator('#share-qr')).toBeVisible();

  await receiver.locator('#receive-tab').click();
  await receiver.getByRole('button', { name: '显示接收二维码' }).click();
  const qr = receiver.locator('#receive-qr');
  await expect(qr).toBeVisible();
  const image = await qr.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL().split(',')[1]);
  await scan.click();
  await expect(sender.getByRole('dialog', { name: '扫描接收二维码' })).toBeVisible();
  await sender.locator('#qr-image-input').setInputFiles({
    name: 'wrong-qr.png', mimeType: 'image/png', buffer: await QRCode.toBuffer(share, { width: 320, margin: 4 })
  });
  await expect(sender.locator('#scan-status')).toHaveText('这不是有效的 PizzaSend 接收二维码。');
  await sender.locator('#qr-image-input').setInputFiles({ name: 'receive-qr.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  await expect(receiver.getByRole('dialog', { name: '接收二维码' })).toBeHidden();
  await expect(receiver.locator('#incoming-files')).toContainText(payload.name);
  await expect(sender.locator('#scan-dialog')).toBeHidden();
  await expect(sender.locator('#share-link')).toHaveValue(share);
  await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  const download = receiver.waitForEvent('download');
  await receiver.locator('.download-file').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(payload.name);
  expect(await readFile((await file.path())!)).toEqual(payload.buffer);
  await sender.locator('#cancel').click();
});

test('receive invitations are short-lived, single-use and role scoped', async ({ request }) => {
  const api = 'http://127.0.0.1:8787/rooms', origin = 'http://127.0.0.1:5173';
  const token = () => randomBytes(32).toString('hex');
  const room = token(), owner = token(), guest = token();
  const headers = { Origin: origin, 'cf-connecting-ip': 'isolated-test-' + room };
  const invitations = 'http://127.0.0.1:8787/receive-invitations';
  expect((await request.post(invitations, { headers })).status()).toBe(400);
  const created = await request.post(invitations, { headers, data: {
    v: 2, room, multi: false, creationToken: owner,
    receiverHash: createHash('sha256').update(guest).digest('hex')
  } });
  expect(created.status()).toBe(201);
  const body = await created.json();
  expect(body.receiveInvite).toBe(true);
  expect(body.expiresAt - Date.now()).toBeGreaterThan(110_000);
  expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
  const url = (role: string) => api + '/' + room + '?role=' + role;
  const auth = (token: string) => ({ ...headers, Authorization: 'Bearer ' + token });
  const deliver = (sealed: string, credential = guest) => request.post(url('receiver'), { headers: auth(credential), data: { type: 'deliver', sealed } });
  const sealed = 'A'.repeat(100);
  expect((await request.get(url('sender'), { headers: auth(guest) })).status()).toBe(401);
  expect((await request.get(url('receiver'), { headers: auth(guest) })).status()).toBe(405);
  expect((await deliver(sealed, owner)).status()).toBe(401);
  expect((await deliver(sealed)).status()).toBe(200);
  expect((await deliver(sealed)).status()).toBe(200);
  expect((await deliver('B'.repeat(100))).status()).toBe(409);
  expect(await (await request.get(url('sender'), { headers: auth(owner) })).json()).toEqual({ sealed });
  expect((await request.post(url('sender'), { headers: auth(owner), data: { type: 'end' } })).status()).toBe(200);
  expect((await deliver(sealed)).status()).toBe(410);
});

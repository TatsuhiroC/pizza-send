import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function setup(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787');
    localStorage.setItem('pizza-send-stun', '');
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
}
async function share(sender: Page) {
  await sender.goto('./');
  await sender.locator('#file-input').setInputFiles({ name: 'connect.txt', mimeType: 'text/plain', buffer: Buffer.from('late candidates still deliver the complete file') });
  await sender.locator('#start-send').click();
  await expect(sender.locator('#share-box')).toBeVisible();
  return sender.locator('#share-link').inputValue();
}

test('candidates arriving after the old eight-second cutoff still connect and deliver', async ({ page, context }) => {
  await setup(context);
  await context.addInitScript(() => {
    const Peer = RTCPeerConnection;
    const local = Object.getOwnPropertyDescriptor(Peer.prototype, 'localDescription')!.get!;
    (window as any).__candidateCount = 0;
    (window as any).RTCPeerConnection = class extends Peer {
      get localDescription() {
        const description = local.call(this);
        if (!description) return null;
        return new RTCSessionDescription({ type: description.type, sdp: description.sdp.split('\r\n').filter((line: string) => !/^a=(candidate:|end-of-candidates)/.test(line)).join('\r\n') });
      }
      set onicecandidate(handler: ((event: RTCPeerConnectionIceEvent) => void) | null) {
        super.onicecandidate = handler ? event => {
          setTimeout(() => { (window as any).__candidateCount++; handler(event); }, 10000);
        } : null;
      }
    };
  });
  const receiver = await context.newPage();
  const errors: string[] = [];
  for (const p of [page, receiver]) p.on('pageerror', error => errors.push(error.message));
  const link = await share(page);
  await receiver.goto(link);
  await expect(receiver.locator('#status')).toHaveText('配对信息已交换，正在寻找直连路径');
  expect(await page.evaluate(() => (window as any).__candidateCount)).toBe(0);
  await expect(receiver.locator('#accept-files')).toBeVisible({ timeout: 25000 });
  expect(await page.evaluate(() => (window as any).__candidateCount)).toBeGreaterThan(0);
  await receiver.locator('#accept-files').click();
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  const download = receiver.waitForEvent('download');
  await receiver.locator('.download-file').click();
  expect((await readFile((await (await download).path())!)).toString()).toBe('late candidates still deliver the complete file');
  expect(errors).toEqual([]);
});

test('explicit receiver departure frees the link before acceptance but does not replace an active receiver', async ({ page, context }) => {
  await setup(context);
  const first = await context.newPage(), second = await context.newPage();
  const link = await share(page);
  await first.goto(link);
  await expect(first.locator('#accept-files')).toBeVisible();
  await second.goto(link);
  await expect(second.locator('#notice')).toContainText('另一接收页面占用');
  await first.locator('#cancel').click();
  await expect(page.locator('#status')).toHaveText('等待接收方');
  await second.reload();
  await expect(second.locator('#accept-files')).toBeVisible();
  await second.locator('#accept-files').click();
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
});

test('expired and ended links report their cause without an endless connecting screen', async ({ page, context }) => {
  await setup(context);
  const receiver = await context.newPage();
  const link = await share(page);
  await page.locator('#cancel').click();
  await receiver.goto(link);
  await expect(receiver.locator('#notice')).toContainText('已过期或发送方已结束');
  await expect(receiver.locator('#accept-files')).toBeHidden();
});

test('signaling reconnect during initial negotiation preserves the offer and eventual file checksum', async ({ page, context }) => {
  await setup(context);
  await context.addInitScript(() => {
    const Peer = RTCPeerConnection, Socket = WebSocket;
    const state = window as any;
    state.__pcs = []; state.__sockets = [];
    state.RTCPeerConnection = class extends Peer {
      constructor(config: RTCConfiguration) { super(config); state.__pcs.push(this); }
      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        if (description.type === 'answer') await new Promise(resolve => setTimeout(resolve, 4000));
        return super.setRemoteDescription(description);
      }
    };
    state.WebSocket = class extends Socket { constructor(url: string) { super(url); state.__sockets.push(this); } };
  });
  const receiver = await context.newPage();
  const link = await share(page);
  await receiver.goto(link);
  await expect(receiver.locator('#status')).toHaveText('配对信息已交换，正在寻找直连路径');
  await page.evaluate(() => { for (const socket of (window as any).__sockets) if (socket.url.includes('/rooms/')) socket.close(); });
  await expect(receiver.locator('#accept-files')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pcs.length)).toBe(1);
  await receiver.locator('#accept-files').click();
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  const download = receiver.waitForEvent('download');
  await receiver.locator('.download-file').click();
  const received = await readFile((await (await download).path())!);
  expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update('late candidates still deliver the complete file').digest('hex'));
});

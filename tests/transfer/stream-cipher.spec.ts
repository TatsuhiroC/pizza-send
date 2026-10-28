import { test, expect } from '../fixtures';

test('encrypted stream preserves ordered binary/text records in both directions without exposing plaintext', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { StreamCipher } = await import('/src/stream-cipher.ts');
    const [sender, receiver] = await Promise.all(['sender', 'receiver'].map(role => StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), role as any)));
    const original = ['私密文件名.png', new Uint8Array([0, 1, 255]).buffer, '', new ArrayBuffer(0)];
    const encrypted = await Promise.all(original.map(value => sender.encrypt(value)));
    const decoded = await Promise.all(encrypted.map(value => receiver.decrypt(value)));
    const reply = await sender.decrypt(await receiver.encrypt('ack'));
    return { decoded: decoded.map(value => typeof value === 'string' ? value : [...new Uint8Array(value)]), reply,
      plaintextLeaked: encrypted.some(value => new TextDecoder().decode(value).includes('私密文件名.png')) };
  });
  expect(result).toEqual({ decoded: ['私密文件名.png', [0, 1, 255], '', []], reply: 'ack', plaintextLeaked: false });
});
for (const attack of ['tamper', 'header', 'replay', 'reorder', 'wrong-secret', 'wrong-room', 'wrong-session', 'reflection', 'oversize']) test(`encrypted stream rejects ${attack} and closes its decoder permanently`, async ({ page }) => {
  await page.goto('./');
  expect(await page.evaluate(async attack => {
    const { StreamCipher } = await import('/src/stream-cipher.ts');
    const sender = await StreamCipher.create('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'sender');
    const receiver = await StreamCipher.create(attack === 'wrong-secret' ? 'd'.repeat(64) : 'a'.repeat(64), attack === 'wrong-room' ? 'd'.repeat(64) : 'b'.repeat(64), attack === 'wrong-session' ? 'd'.repeat(64) : 'c'.repeat(64), attack === 'reflection' ? 'sender' : 'receiver');
    const valid = await sender.encrypt('confidential'); let frame = valid.slice(0);
    if (attack === 'tamper') new Uint8Array(frame)[10] ^= 1;
    if (attack === 'header') new Uint8Array(frame)[1] ^= 1;
    if (attack === 'replay') await receiver.decrypt(valid);
    if (attack === 'reorder') frame = await sender.encrypt('second');
    if (attack === 'oversize') frame = new ArrayBuffer(262145);
    let rejected = false, terminal = false;
    try { await receiver.decrypt(frame); } catch { rejected = true; }
    try { await receiver.decrypt(valid); } catch { terminal = true; }
    return rejected && terminal;
  }, attack)).toBe(true);
});

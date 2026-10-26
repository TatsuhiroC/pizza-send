// Independent, directional record keys. The relay receives only ciphertext;
// the 256-bit share secret stays in the browser's URL fragment / memory.
const raw = (hex: string) => {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw Error('Invalid stream context');
  return Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
};
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export const MAX_STREAM_FRAME = 262144;

export class StreamCipher {
  private outgoing = 0;
  private incoming = 0;
  private sendFailed = false;
  private receiveFailed = false;
  private sending = Promise.resolve();
  private receiving = Promise.resolve();
  private constructor(private sendKey: CryptoKey, private receiveKey: CryptoKey) {}
  static async create(secret: string, room: string, session: string, role: 'sender' | 'receiver') {
    raw(room);
    const root = await crypto.subtle.importKey('raw', raw(secret), 'HKDF', false, ['deriveKey']);
    const derive = (direction: string) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: raw(session),
      info: encoder.encode('PizzaSend/stream/v1/' + room + '/' + direction) }, root,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const [sender, receiver] = await Promise.all([derive('sender'), derive('receiver')]);
    return role === 'sender' ? new StreamCipher(sender, receiver) : new StreamCipher(receiver, sender);
  }
  // Calls are serialized: WebCrypto promises must not reorder file records.
  encrypt(value: string | ArrayBuffer): Promise<ArrayBuffer> {
    const task = this.sending.then(async () => {
      if (this.sendFailed) throw Error('Stream closed');
      const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
      if (bytes.byteLength > MAX_STREAM_FRAME - 24 || this.outgoing >= 0xffffffff) throw Error('Invalid stream frame');
      const header = new Uint8Array(8), view = new DataView(header.buffer);
      header[0] = 1; header[1] = typeof value === 'string' ? 1 : 0;
      const sequence = this.outgoing++; view.setUint32(4, sequence);
      const iv = new Uint8Array(12); new DataView(iv.buffer).setUint32(8, sequence);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, this.sendKey, bytes);
      const frame = new Uint8Array(8 + ciphertext.byteLength); frame.set(header); frame.set(new Uint8Array(ciphertext), 8);
      return frame.buffer;
    });
    // A failed stream is terminal. Never send again with a skipped / reused nonce.
    this.sending = task.then(() => {}, () => { this.sendFailed = true; }); return task;
  }
  decrypt(frame: ArrayBuffer): Promise<string | ArrayBuffer> {
    const task = this.receiving.then(async () => {
      if (this.receiveFailed) throw Error('Stream closed');
      if (frame.byteLength < 24 || frame.byteLength > MAX_STREAM_FRAME) throw Error('Invalid stream frame');
      const header = new Uint8Array(frame, 0, 8), sequence = new DataView(frame).getUint32(4);
      if (header[0] !== 1 || header[1] > 1 || header[2] || header[3] || sequence !== this.incoming || this.incoming >= 0xffffffff) throw Error('Invalid stream sequence');
      const iv = new Uint8Array(12); new DataView(iv.buffer).setUint32(8, sequence);
      const value = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header, tagLength: 128 }, this.receiveKey, frame.slice(8));
      this.incoming++;
      return header[1] ? decoder.decode(value) : value;
    });
    this.receiving = task.then(() => {}, () => { this.receiveFailed = true; }); return task;
  }
}

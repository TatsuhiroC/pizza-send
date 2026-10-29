import { supportsCompression } from './compression';

export const hex = (b: Uint8Array) => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
function requireManualCompression() {
  if (!supportsCompression()) throw Error('当前浏览器不支持手动配对码，请使用分享链接或更新浏览器。');
}
export async function packDescription(d: RTCSessionDescriptionInit): Promise<string> {
  requireManualCompression();
  const input = new Blob([JSON.stringify({ v: 1, type: d.type, sdp: d.sdp })]);
  const compressed = await new Response(input.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return 'PS1.' + toBase64(new Uint8Array(compressed));
}
export async function unpackDescription(code: string, expected: 'offer' | 'answer'): Promise<RTCSessionDescriptionInit> {
  if (!code.startsWith('PS1.') || code.length > 120000) throw Error('这不是有效的 PizzaSend 配对码');
  requireManualCompression();
  const reader = new Blob([fromBase64(code.slice(4))]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 200000) throw Error('配对信息过大');
      parts.push(new Uint8Array(value));
    }
  } finally { await reader.cancel(); }
  const d = JSON.parse(await new Blob(parts).text());
  if (d.v !== 1 || d.type !== expected || typeof d.sdp !== 'string' || !d.sdp.startsWith('v=0')) throw Error('配对码类型不正确');
  return { type: d.type, sdp: d.sdp };
}
export async function signalKey(secret: string): Promise<CryptoKey> {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error('分享链接不完整');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, n => parseInt(n, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(key: CryptoKey, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const packed = new Uint8Array(12 + encrypted.byteLength);
  packed.set(iv); packed.set(new Uint8Array(encrypted), 12);
  return toBase64(packed);
}
export async function unseal(key: CryptoKey, payload: string): Promise<any> {
  const packed = fromBase64(payload);
  const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
  return JSON.parse(new TextDecoder().decode(decoded));
}

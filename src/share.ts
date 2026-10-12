const hex = (value: Uint8Array) => Array.from(value, n => n.toString(16).padStart(2, '0')).join('');
const rawSecret = (secret: string) => {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error('分享链接不完整');
  return Uint8Array.from(secret.match(/../g)!, n => parseInt(n, 16));
};
export type Share = { room: string; receiver: string; secret: string };

// One 256-bit capability stays in the URL fragment. Independent HKDF labels
// derive the room and receiver credentials without revealing the AES key.
export async function deriveShare(secret: string): Promise<Share> {
  const key = await crypto.subtle.importKey('raw', rawSecret(secret), 'HKDF', false, ['deriveBits']);
  const derive = async (label: string) => hex(new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('PizzaSend/v2'), info: new TextEncoder().encode(label)
  }, key, 256)));
  const [room, receiver] = await Promise.all([derive('room'), derive('receiver')]);
  return { room, receiver, secret };
}
export async function receiverDigest(receiver: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receiver))));
}
export function shareFragment(secret: string): string {
  return '2.' + btoa(String.fromCharCode(...rawSecret(secret))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function parseShare(fragment: string): Promise<Share> {
  const value = fragment.replace(/^#/, '');
  if (value.startsWith('2.')) {
    if (!/^2\.[A-Za-z0-9_-]{43}$/.test(value)) throw Error('分享链接不完整');
    const decoded = Uint8Array.from(atob(value.slice(2).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const secret = hex(decoded);
    if (shareFragment(secret) !== value) throw Error('分享链接不完整');
    return deriveShare(secret);
  }
  const params = new URLSearchParams(value);
  const room = params.get('r') || '', receiver = params.get('t') || '', secret = params.get('k') || '';
  if (![room, receiver, secret].every(s => /^[a-f0-9]{64}$/.test(s))) throw Error('分享链接不完整');
  return { room, receiver, secret };
}

export function isSharingURL(url: URL, base: URL): boolean {
  return url.origin === base.origin && url.pathname.replace(/\/$/, '') === base.pathname.replace(/\/$/, '');
}

// Each recipient gets independent credentials and an independent encryption key.
// Only the sender can list recipient IDs through the authenticated group room.
export async function deriveRecipientShare(secret: string, client: string): Promise<Share> {
  if (!/^[a-f0-9]{64}$/.test(client)) throw Error('配对信息无效');
  const key = await crypto.subtle.importKey('raw', rawSecret(secret), 'HKDF', false, ['deriveBits']);
  const bytes = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('PizzaSend/group/v1'), info: new TextEncoder().encode(client) }, key, 256);
  return deriveShare(hex(new Uint8Array(bytes)));
}

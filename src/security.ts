export function authenticatedRequest(value: string | URL, options: RequestInit = {}) {
  const url = new URL(value), credential = url.searchParams.get('token');
  url.searchParams.delete('token');
  const headers = new Headers(options.headers);
  if (credential) headers.set('authorization', 'Bearer ' + credential);
  return fetch(url, { ...options, headers, referrerPolicy: 'no-referrer' });
}

export async function ticketURL(value: string) {
  const url = new URL(value), websocketProtocol = url.protocol;
  url.protocol = websocketProtocol === 'wss:' ? 'https:' : 'http:';
  const response = await authenticatedRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'connect' }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error(response.status === 409 ? '分享链接已被另一接收页面占用，请关闭原页面或创建新链接。' : response.status === 410 ? '分享链接已过期或发送方已结束，请创建新链接。' : '无法连接配对服务');
  const state = await response.json();
  if (typeof state.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(state.ticket)) throw Error('配对信息无效');
  url.protocol = websocketProtocol; url.searchParams.delete('token'); url.searchParams.set('ticket', state.ticket);
  return url.toString();
}

// Compare over a trusted channel. This binds the code to both actual DTLS
// certificate fingerprints, rather than to the reusable invitation secret.
export async function connectionCode(local: string, remote: string) {
  const fingerprints = (sdp: string) => {
    const values = [...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map(match => match[1].replace(/:/g, '').toLowerCase());
    if (!values.length || values.some(value => !/^[a-f0-9]{64}$/.test(value))) throw Error('配对信息无效');
    return [...new Set(values)].sort().join(',');
  };
  const pair = [fingerprints(local), fingerprints(remote)].sort();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('PizzaSend/connection-check/v1\n' + pair.join('\n'))));
  return Array.from(bytes.slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g)!.join(' ');
}

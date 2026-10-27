import { fetchWithTimeout } from './request-timeout';

export function authenticatedRequest<T = Response>(value: string | URL, options: RequestInit = {}, milliseconds?: number, consume?: (response: Response) => Promise<T>): Promise<T> {
  const url = new URL(value), credential = url.searchParams.get('token');
  url.searchParams.delete('token');
  const headers = new Headers(options.headers);
  if (credential) headers.set('authorization', 'Bearer ' + credential);
  const request = { ...options, headers, referrerPolicy: 'no-referrer' as const };
  return milliseconds === undefined ? fetch(url, request).then(response => consume ? consume(response) : response as T) : fetchWithTimeout(url, request, milliseconds, consume);
}

// Only callers whose request can safely be repeated use this helper. Keep the
// same room/client and credentials; never retry share creation or signal sends.
export async function retryPairingRequest<T = Response>(value: string | URL, options: RequestInit = {}, consume?: (response: Response) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await authenticatedRequest(value, options, 10000, consume); }
    catch (error) {
      if (options.signal?.aborted || attempt || !(error instanceof DOMException) || !['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

export async function ticketURL(value: string, streamSession?: string) {
  const url = new URL(value), websocketProtocol = url.protocol;
  url.protocol = websocketProtocol === 'wss:' ? 'https:' : 'http:';
  if (streamSession !== undefined && !/^[a-f0-9]{64}$/.test(streamSession)) throw Error('加密转发暂时不可用');
  const state = await retryPairingRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(streamSession ? { type: 'stream-connect', session: streamSession } : { type: 'connect' }) }, async response => {
    if (streamSession && !response.ok) throw Error('加密转发暂时不可用');
    if (!response.ok) throw Error(response.status === 409 ? '分享链接已被另一接收页面占用，请关闭原页面或创建新链接。' : response.status === 410 ? '分享链接已过期或发送方已结束，请创建新链接。' : '无法连接配对服务');
    return response.json();
  });
  if (typeof state.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(state.ticket)) throw Error('配对信息无效');
  url.protocol = websocketProtocol; url.searchParams.delete('token'); url.searchParams.set('ticket', state.ticket);
  if (streamSession) { url.searchParams.set('transport', 'stream'); url.searchParams.set('session', streamSession); }
  return url.toString();
}

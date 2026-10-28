import { abortableDelay, fetchWithTimeout } from './request-timeout';

export class PairingResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export class PairingConnectionError extends Error {}
export function temporaryPairingError(error: unknown) {
  return error instanceof PairingResponseError ? error.status === 408 || error.status >= 500 :
    error instanceof PairingConnectionError || error instanceof TypeError ||
    error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name);
}

// Keep the same room/client during startup. A temporary failure must not reach
// the UI's session cleanup, but auth/expiry errors and user cancellation must.
export async function retryInitialPairing(attempt: (signal: AbortSignal) => Promise<void>, source: AbortSignal, onRetry = () => {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(source.reason ?? new DOMException('Cancelled', 'AbortError'));
  if (source.aborted) cancel(); else source.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('配对服务连接超时', 'TimeoutError')), 60000);
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', interrupt, { once: true });
  });
  void interrupted.catch(() => {});
  try {
    for (let count = 0; ; count++) {
      if (controller.signal.aborted) throw controller.signal.reason;
      try {
        await Promise.race([attempt(controller.signal), interrupted]);
        if (controller.signal.aborted) throw controller.signal.reason;
        return;
      }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!temporaryPairingError(error) || count >= 3) throw error;
        onRetry();
        await abortableDelay(500 * 2 ** count, controller.signal);
      }
    }
  } finally {
    clearTimeout(timer); source.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', interrupt);
  }
}

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
      await abortableDelay(300, options.signal ?? undefined);
    }
  }
}

export async function ticketURL(value: string, streamSession?: string, signal?: AbortSignal) {
  const url = new URL(value), websocketProtocol = url.protocol;
  url.protocol = websocketProtocol === 'wss:' ? 'https:' : 'http:';
  if (streamSession !== undefined && !/^[a-f0-9]{64}$/.test(streamSession)) throw Error('加密转发暂时不可用');
  const state = await retryPairingRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(streamSession ? { type: 'stream-connect', session: streamSession } : { type: 'connect' }), signal }, async response => {
    if (streamSession && !response.ok) throw Error('加密转发暂时不可用');
    if (!response.ok) throw new PairingResponseError(response.status === 409 ? '分享链接已被另一接收页面占用，请关闭原页面或创建新链接。' : response.status === 410 ? '分享链接已过期或发送方已结束，请创建新链接。' : '无法连接配对服务', response.status);
    return response.json();
  });
  if (typeof state.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(state.ticket)) throw Error('配对信息无效');
  url.protocol = websocketProtocol; url.searchParams.delete('token'); url.searchParams.set('ticket', state.ticket);
  if (streamSession) { url.searchParams.set('transport', 'stream'); url.searchParams.set('session', streamSession); }
  return url.toString();
}

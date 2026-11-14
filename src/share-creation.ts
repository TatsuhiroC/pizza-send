import { abortableDelay, fetchWithTimeout } from './request-timeout';
import { PairingResponseError, temporaryPairingError } from './security';
import { throwIfAborted } from './cancellation';

type Creation = { v: 2; room: string; receiverHash: string; creationToken: string } &
  ({ multi: true; receiveInvite?: never } | { multi: false; receiveInvite: true });
type Session = { v: 2; room: string; sender: string; expiresAt?: number; creationRetry?: number; receiveInvite?: true };
type Hooks = { signal: AbortSignal; retry(): void; challenge(siteKey: string, room: string): Promise<string> };
const timeoutMessage = '未能及时连接配对服务，文件尚未开始传输。请稍后重试。';

// One independent sender capability makes replaying creation safe on the new
// service. Old services may still create once, but cannot recover a lost reply.
export async function createShare(api: string, creation: Creation, hooks: Hooks): Promise<Session> {
  const { receiveInvite, ...room } = creation;
  const options = { ...room, challenge: '' };
  const route = receiveInvite ? '/receive-invitations' : '/rooms';
  let remaining = 30000, retried = false, verified = false;
  while (true) {
    throwIfAborted(hooks.signal);
    const at = performance.now();
    let result: { response: Response; payload: any };
    try {
      if (remaining <= 0) throw new DOMException('Creation timed out', 'TimeoutError');
      result = await fetchWithTimeout(api + route, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options), referrerPolicy: 'no-referrer', signal: hooks.signal
      }, Math.min(15000, remaining), async response => ({ response,
        payload: await response.json().catch(error => { if (response.ok || response.status === 428) throw error; return {}; }) }));
      const { response, payload } = result;
      if (!response.ok && response.status !== 428) {
        const quota = response.status === 503 && payload?.error === 'New shares temporarily paused';
        if (quota) throw Error('新分享暂时达到服务限额，请稍后重试或使用手动配对。');
        throw new PairingResponseError(response.status === 429 ? '请求过于频繁，请稍后重试或使用手动配对。' :
          '配对服务暂不可用（' + response.status + '），请使用手动配对', response.status);
      }
    } catch (error) {
      remaining -= performance.now() - at;
      throwIfAborted(hooks.signal);
      if (!(error instanceof PairingResponseError ? [408, 500, 502, 503, 504].includes(error.status) : temporaryPairingError(error))) throw error;
      if (retried || remaining <= 1000) throw Error(error instanceof PairingResponseError ? '配对服务暂不可用，文件尚未开始传输。请稍后重试。' : timeoutMessage);
      retried = true; hooks.retry();
      const waiting = performance.now();
      await abortableDelay(1000, hooks.signal);
      remaining -= performance.now() - waiting;
      continue;
    }
    remaining -= performance.now() - at;
    throwIfAborted(hooks.signal);
    if (result.response.status === 428) {
      if (verified) throw Error('验证服务暂不可用，请稍后重试或使用手动配对。');
      verified = true;
      // Human verification has its own deadline; do not spend the network
      // budget while the user is interacting with the challenge.
      options.challenge = await hooks.challenge(result.payload?.siteKey, creation.room);
      continue;
    }
    const session = result.payload;
    if (session?.v !== 2 || !!session.receiveInvite !== !!receiveInvite || session.room !== creation.room || !/^[a-f0-9]{64}$/.test(session.sender) ||
      session.creationRetry !== undefined && (session.creationRetry !== 1 || session.sender !== creation.creationToken)) throw Error('配对服务返回信息无效');
    return session;
  }
}

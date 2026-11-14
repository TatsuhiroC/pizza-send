import { groupURL } from './group';
import { randomToken, seal, signalKey, unseal } from './protocol-codec';
import { abortableDelay } from './request-timeout';
import { authenticatedRequest, PairingResponseError, temporaryPairingError } from './security';
import { deriveShare, isSharingURL, parseShare, receiverDigest, shareFragment } from './share';
import { createShare } from './share-creation';

type Hooks = Parameters<typeof createShare>[2];
const prefix = 'receive-qr=';
const expired = '接收二维码已失效，请关闭后重新生成。';
const expiredForSender = '接收二维码已失效，请让接收方重新生成。';

function link(base: URL, fragment: string) {
  const url = new URL(base);
  url.search = ''; url.hash = fragment;
  return url;
}

async function invitationRequest(url: string, signal?: AbortSignal, body?: unknown, keepalive = false) {
  return authenticatedRequest(url, { signal, keepalive, ...(body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  } : {}) }, 6000, async response => {
    if (!response.ok) throw new PairingResponseError(response.status === 410 ? (body ? expiredForSender : expired) : response.status === 409 ?
      '接收二维码已被使用，请让接收方重新生成。' : '无法发送分享链接，请检查网络后重试。', response.status);
    return response.json();
  });
}

export async function openReceiveInvitation(api: string, base: URL, hooks: Hooks) {
  const secret = randomToken(), creationToken = randomToken();
  const { room, receiver } = await deriveShare(secret);
  const owner = groupURL(api, room, 'sender', creationToken, randomToken());
  const close = () => { void invitationRequest(owner, undefined, { type: 'end' }, true).catch(() => {}); };
  try {
    await createShare(api, { v: 2, room, receiverHash: await receiverDigest(receiver), multi: false, creationToken, receiveInvite: true }, hooks);
    // Use a local monotonic clock so a device with a skewed wall clock can wait.
    // The service remains authoritative about whether the invitation has expired.
    const deadline = performance.now() + 120000;
    return {
      code: link(base, prefix + shareFragment(secret)).toString(),
      close,
      async wait() {
        const key = await signalKey(secret);
        while (performance.now() < deadline) {
          try {
            const { sealed } = await invitationRequest(owner, hooks.signal);
            if (typeof sealed === 'string') {
              const fragment = await unseal(key, sealed);
              if (typeof fragment !== 'string' || !fragment.startsWith('2.')) throw Error('配对信息无效');
              await parseShare(fragment);
              const url = link(base, fragment);
              url.searchParams.set('receive', '1');
              return url.toString();
            }
          } catch (error) {
            if (hooks.signal.aborted || !temporaryPairingError(error)) throw error;
          }
          await abortableDelay(2000, hooks.signal);
        }
        throw Error(expired);
      }
    };
  } catch (error) {
    close();
    throw error;
  }
}

export async function readReceiveInvitation(value: string, base: URL) {
  const url = new URL(value);
  if (!isSharingURL(url, base) || !url.hash.startsWith('#' + prefix + '2.')) throw Error('这不是有效的 PizzaSend 接收二维码。');
  return parseShare(url.hash.slice(1 + prefix.length));
}

export async function deliverReceiveInvitation(api: string, invite: Awaited<ReturnType<typeof readReceiveInvitation>>, shareLink: string, signal: AbortSignal) {
  const fragment = new URL(shareLink).hash.slice(1);
  const sealed = await seal(await signalKey(invite.secret), fragment);
  const address = groupURL(api, invite.room, 'receiver', invite.receiver, randomToken());
  try {
    await invitationRequest(address, signal, { type: 'deliver', sealed });
  } catch (error) {
    if (signal.aborted || !temporaryPairingError(error)) throw error;
    await invitationRequest(address, signal, { type: 'deliver', sealed });
  }
}

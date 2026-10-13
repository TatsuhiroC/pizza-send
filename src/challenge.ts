type Turnstile = { render(container: HTMLElement, options: Record<string, unknown>): string; remove(id: string): void };
const api = () => (window as Window & { turnstile?: Turnstile }).turnstile;
let loading: Promise<Turnstile> | undefined;
let cancel: (() => void) | undefined;
export function cancelChallenge() { cancel?.(); }
function load() {
  if (api()) return Promise.resolve(api()!);
  if (loading) return loading;
  loading = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    const finish = () => { clearTimeout(timeout); script.onload = script.onerror = null; };
    const timeout = setTimeout(() => { finish(); script.remove(); loading = undefined; reject(Error('验证服务暂不可用，请稍后重试或使用手动配对。')); }, 15000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.referrerPolicy = 'no-referrer';
    script.onload = () => { finish(); if (api()) resolve(api()!); else { loading = undefined; reject(Error('验证服务暂不可用，请稍后重试或使用手动配对。')); } };
    script.onerror = () => { finish(); script.remove(); loading = undefined; reject(Error('验证服务暂不可用，请稍后重试或使用手动配对。')); };
    document.head.append(script);
  });
  return loading;
}
export async function challenge(siteKey: string, room: string, current: () => boolean) {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(siteKey)) throw Error('配对信息无效');
  cancelChallenge();
  const dialog = document.getElementById('verification-dialog') as HTMLDialogElement;
  const container = document.getElementById('verification-widget')!;
  return new Promise<string>((resolve, reject) => {
    let widget: string | undefined, settled = false;
    const timer = setTimeout(() => finish(undefined, '验证已超时，请重试或使用手动配对。'), 120000);
    const finish = (token?: string, error = '验证已取消，请重试或使用手动配对。') => {
      if (settled) return; settled = true; clearTimeout(timer); cancel = undefined;
      dialog.removeEventListener('cancel', onCancel); dialog.removeEventListener('close', onClose);
      if (widget) api()?.remove(widget); container.replaceChildren(); dialog.close();
      if (token && current()) resolve(token); else reject(Error(error));
    };
    const onCancel = (event: Event) => { event.preventDefault(); finish(); };
    const onClose = () => finish();
    cancel = () => finish();
    dialog.addEventListener('cancel', onCancel); dialog.addEventListener('close', onClose); dialog.showModal();
    void load().then(service => {
      if (settled || !current()) { finish(); return; }
      widget = service.render(container, { sitekey: siteKey, action: 'create-share', cData: room, size: 'flexible', language: document.documentElement.lang === 'en' ? 'en' : 'zh-CN',
        callback: (token: string) => finish(token), 'error-callback': () => finish(undefined, '验证服务暂不可用，请稍后重试或使用手动配对。'), 'expired-callback': () => finish(undefined, '验证已超时，请重试或使用手动配对。') });
      if (settled && widget) service.remove(widget);
    }).catch(() => finish(undefined, '验证服务暂不可用，请稍后重试或使用手动配对。'));
  });
}

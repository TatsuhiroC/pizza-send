import { setText } from './i18n';
import type { RouteState, TransferRoute } from './stream-fallback';

export function renderRouteControls(container: HTMLElement, state: RouteState | undefined, choose: (route: TransferRoute) => void, available = true) {
  container.hidden = !available || !state?.available;
  if (container.hidden || !state) return;
  if (!container.firstChild) container.innerHTML = '<fieldset><legend></legend><p class="route-message" role="status" aria-atomic="true"></p><div class="route-options"><button type="button" data-route="direct"></button><button type="button" data-route="stream"></button></div><p class="route-hint"></p></fieldset>';
  container.dataset.route = state.current; container.dataset.busy = String(state.busy);
  setText(container.querySelector('legend')!, '传输路线');
  setText(container.querySelector('.route-message')!, state.busy || state.recovering ? state.target === 'direct' ? '正在切回直连，已接收进度会保留。' : '正在连接加密转发，已接收进度会保留。' :
    state.failed ? state.connected === false ? '连接尚未建立，可重试加密转发或等待直连。' : '加密转发暂时不可用，继续使用直连。' : state.directFailed && state.current === 'stream' ? '直连暂时不可用，已恢复加密转发。' : state.current === 'stream' ? '当前使用加密转发' : '当前使用直连');
  setText(container.querySelector('.route-hint')!, state.directUnavailable ? '一端浏览器不支持直连，使用端到端加密转发。' : state.manual ? '已手动选择，本次传输不再自动切换。' : '可以切换路线，已接收进度会保留。');
  for (const route of ['direct', 'stream'] as const) {
    const button = container.querySelector<HTMLButtonElement>('[data-route="' + route + '"]')!;
    setText(button, route === 'direct' ? '直连' : '加密转发');
    button.setAttribute('aria-pressed', String(state.current === route)); button.disabled = state.busy || route === 'direct' && !!state.directUnavailable;
    button.onclick = () => choose(route);
  }
}

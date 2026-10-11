import { registerStatic, setText, t, toggleLanguage } from './i18n';
import QRCode from 'qrcode';
import { Transfer, Signaling, bytes, randomToken, packDescription, unpackDescription, signalKey, type Config, type FileInfo, type TransferEvent } from './protocol';
import './style.css';

const icon = (name: string) => {
  const paths: Record<string, string> = {
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
    down: '<path d="M12 4v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
    file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h-3zM21 15v6h-6"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>'
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.file) + '</svg>';
};
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = [
  '<header class="header"><a class="brand" href="./"><img src="./pizza.svg" alt="" width="38" height="38"/><span>PizzaSend<small>文件快传</small></span></a><div class="header-right"><span class="version">第一片 · v0.1</span><button id="language-toggle" class="language-toggle" type="button"><span data-language="zh">中</span><span class="language-divider" aria-hidden="true">/</span><span data-language="en">EN</span></button><a class="github" href="https://github.com/TatsuhiroC/pizza-send" target="_blank" rel="noopener">GitHub ↗</a></div></header>',
  '<main><section class="intro"><div class="eyebrow"><span></span>好东西，直接分享。</div><h1>文件送到，<br/><span>热乎刚好。</span><img class="hero-pizza" src="./pizza.svg" alt="" width="104" height="104"/></h1><p>不用安装，不用注册。<br class="mobile-break"/>打开网页，把文件直接送到另一台设备。</p></section>',
  '<section class="transfer-card" aria-label="文件传输"><div class="card-top"><div class="tabs" role="tablist" aria-label="传输角色"><button id="send-tab" class="tab active" role="tab" aria-selected="true">'+icon('upload')+'发送文件</button><button id="receive-tab" class="tab" role="tab" aria-selected="false">'+icon('down')+'接收文件</button></div><span class="secure">'+icon('lock')+'加密直传</span></div>',
  '<div id="send-view"><button id="drop-zone" class="drop-zone" type="button"><span class="drop-icon">'+icon('upload')+'</span><strong>把文件放在这里</strong><span>拖放文件，或点击选择</span><small>支持多个文件 · 文件内容不上传到服务器</small></button><input id="file-input" type="file" multiple hidden/><div id="files" class="file-list" aria-live="polite"></div><div class="send-bottom"><span id="selection-summary">先选一个文件，就可以开始。</span><button id="start-send" class="primary" disabled>创建传输 '+icon('arrow')+'</button></div></div>',
  '<div id="receive-view" hidden><div class="receive-intro"><span class="drop-icon">'+icon('down')+'</span><h2>接住这一份分享</h2><p>打开对方发来的分享链接即可连接。<br/>也可以在这里粘贴链接或配对码。</p></div><label class="sr-only" for="receive-code">分享链接或配对码</label><textarea id="receive-code" rows="3" placeholder="粘贴 PizzaSend 分享链接或 PS1. 配对码"></textarea><button id="connect-receive" class="primary wide">连接发送方 '+icon('arrow')+'</button><div id="incoming-files" class="file-list"></div><button id="accept-files" class="primary wide" hidden>选择保存位置并接收 '+icon('down')+'</button><p id="save-note" class="subtle" hidden></p><div id="downloads" class="downloads"></div></div>',
  '<div id="session-panel" class="session-panel" hidden><div class="session-heading"><span id="status-dot" class="status-dot"></span><h2 id="status">等待接收方</h2><button id="cancel" class="text-button">结束传输</button></div><p id="status-detail" class="subtle">传输期间请保持双方页面打开。</p><div id="share-box" hidden><label for="share-link">把链接发给对方，或者让对方扫码</label><div class="link-row"><input id="share-link" readonly/><button id="copy-link" class="icon-button" aria-label="复制分享链接">'+icon('copy')+'</button><button id="show-qr" class="icon-button" aria-label="显示分享二维码">'+icon('qr')+'</button></div><canvas id="share-qr" hidden></canvas><p class="subtle">链接 30 分钟内可配对，仅限一位接收方。请只分享给预期接收者。</p></div><div id="progress-box" hidden><div class="progress-meta"><span id="current-file"></span><span id="percent">0%</span></div><progress id="progress" max="100" value="0" aria-label="传输进度"></progress><div class="metrics"><div><span id="transferred">0 B</span><small>已接收</small></div><div><span id="speed">—</span><small>平均速度</small></div><div><span id="remaining">—</span><small>预计剩余</small></div></div><div class="path-label">'+icon('lock')+'<span id="connection-path">浏览器之间加密传输</span><span>SHA-256 校验</span></div></div></div>',
  '<div id="notice" class="notice" role="alert" hidden></div></section>',
  '<section class="benefits"><div>'+icon('bolt')+'<h3>直接送达</h3><p>两端连接后，即传即收。</p></div><div>'+icon('lock')+'<h3>加密传输</h3><p>文件在浏览器之间加密传递。</p></div><div>'+icon('file')+'<h3>原样分享</h3><p>保留内容，逐个校验文件。</p></div></section>',
  '<details class="faq"><summary>开始之前，你可能想知道</summary><div><p><strong>要一直打开页面吗？</strong> 是的。发送和接收期间请保持页面打开，手机尽量不要锁屏。关闭页面会中断传输。</p><p><strong>大文件能传吗？</strong> 桌面 Chrome / Edge 支持直接写入磁盘。其他浏览器会先缓存在内存里，首版限制为总计 256 MB。</p><p><strong>所有网络都能连上吗？</strong> 首版使用直连，不提供文件中继。部分移动、公司或受限网络可能无法连接，可以尝试同一 Wi-Fi。</p><p><strong>可以断点续传吗？</strong> 首版中断后需要重新创建传输，暂不支持刷新或断线续传。</p><p><strong>“加密”意味着什么？</strong> WebRTC 数据通道使用 DTLS 加密。自动配对信息也在浏览器里加密，配对密钥放在链接片段中。使用网页仍需要信任本站提供的程序代码。</p></div></details>',
  '<details class="settings"><summary>连接设置</summary><div class="settings-body"><label for="signal-url">配对服务地址</label><input id="signal-url" placeholder="https://pizza-send-signal.…workers.dev"/><label for="stun-url">STUN 服务地址</label><input id="stun-url" placeholder="stun:stun.cloudflare.com:3478"/><button id="save-settings" class="secondary">保存设置</button><p class="subtle">没有配对服务时，可用手动配对码连接。STUN 只帮助建立连接，不中转文件。</p></div></details>',
  '</main><footer><span>🍕 一点披萨精神，一份直接的分享。</span><span>受 <a href="https://github.com/kern/filepizza" target="_blank" rel="noopener">FilePizza</a> 启发 · 开源制作</span></footer>',
  '<dialog id="pair-dialog"><div class="dialog-heading"><h2>手动配对</h2><button id="close-dialog" class="icon-button" aria-label="关闭配对窗口">'+icon('close')+'</button></div><p id="pair-instructions"></p><label id="outgoing-label" for="outgoing-code">配对码</label><textarea id="outgoing-code" rows="4" readonly></textarea><div class="dialog-actions"><button id="copy-code" class="secondary">'+icon('copy')+'复制配对码</button><button id="pair-qr-button" class="secondary">'+icon('qr')+'二维码</button></div><canvas id="pair-qr" hidden></canvas><div id="answer-section"><label for="answer-code">对方返回的应答码</label><textarea id="answer-code" rows="3" placeholder="粘贴接收方返回的 PS1. 应答码"></textarea><button id="apply-answer" class="primary wide">完成配对 '+icon('arrow')+'</button></div><p class="subtle">仅交换连接信息，文件仍通过加密直连发送。请只向预期接收者提供配对码。</p></dialog>',
  '<div id="toast" class="toast" role="status" hidden></div>'
].join('');
registerStatic(app);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
let config: Config = { signalUrl: '', iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], memoryLimitBytes: 268435456 };
let files: File[] = [];
let transfer: Transfer | undefined;
let signaling: Signaling | undefined;
let shareLink = '';
let pairingKind: 'offer' | 'answer' = 'offer';
let busy = false;
let toastTimer: ReturnType<typeof setTimeout>;
let originalHash = location.hash;
function toast(message: string) { setText($('toast'), message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 2600); }
function notice(message: string) { setText($('notice'), message); $('notice').hidden = false; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
async function run(fn: () => Promise<void>) {
  try { await fn(); } catch (e) { if (e instanceof DOMException && e.name === 'AbortError') toast('已取消选择保存位置'); else notice(errorMessage(e)); }
}
function view(role: 'sender' | 'receiver') {
  $('send-view').hidden = role !== 'sender'; $('receive-view').hidden = role !== 'receiver';
  $('send-tab').classList.toggle('active', role === 'sender'); $('receive-tab').classList.toggle('active', role === 'receiver');
  $('send-tab').setAttribute('aria-selected', String(role === 'sender')); $('receive-tab').setAttribute('aria-selected', String(role === 'receiver'));
}
function status(title: string, detail?: string, mode = 'waiting') {
  $('session-panel').hidden = false; setText($('status'), title); $('status-dot').className = 'status-dot ' + mode;
  if (detail) setText($('status-detail'), detail);
}
function fileMarkup(list: { name: string; size: number }[], removable = false) {
  return list.map((f, i) => '<div class="file-row"><span class="file-symbol">'+icon('file')+'</span><div><strong>'+escapeHtml(f.name)+'</strong><small>'+bytes(f.size)+'</small></div>'+(removable ? '<button class="icon-button remove-file" data-index="'+i+'" aria-label="'+escapeHtml(t('移除 {name}', { name: f.name }))+'">'+icon('close')+'</button>' : '<span class="file-ready">'+t('待接收')+'</span>')+'</div>').join('');
}
function select(next: File[]) {
  if (busy) return;
  const combined = [...files, ...next];
  if (combined.length > 100) { notice('一次最多选择 100 个文件'); return; }
  if (combined.some(f => f.name.length > 255)) { notice('文件名过长，请缩短后重试'); return; }
  files = combined; renderFiles();
}
function renderFiles() {
  $('files').innerHTML = fileMarkup(files, true); $('drop-zone').classList.toggle('compact', files.length > 0);
  setText($('selection-summary'), files.length ? '{count} 个文件 · {size}' : '先选一个文件，就可以开始。', { count: files.length, size: bytes(files.reduce((n, f) => n + f.size, 0)) });
  $<HTMLButtonElement>('start-send').disabled = !files.length || busy;
}
function setBusy(value: boolean) {
  busy = value; renderFiles();
  $<HTMLButtonElement>('drop-zone').disabled = value;
  document.querySelectorAll<HTMLButtonElement>('.remove-file').forEach(b => b.disabled = value);
  $<HTMLButtonElement>('connect-receive').disabled = value;
}
function reset() {
  signaling?.close(); signaling = undefined;
  transfer?.close(); transfer = undefined;
  shareLink = ''; setBusy(false);
  $('share-box').hidden = true; $('progress-box').hidden = true; $('session-panel').hidden = true;
  $('notice').hidden = true; $('incoming-files').innerHTML = ''; $('downloads').innerHTML = '';
  $('accept-files').hidden = true; $('save-note').hidden = true;
  setText($('cancel'), '结束传输');
  $<HTMLButtonElement>('accept-files').disabled = false;
  $<HTMLDialogElement>('pair-dialog').close();
  history.replaceState(null, '', location.pathname + location.search);
}
function events(event: TransferEvent) {
  if (event.type === 'connected') {
    $<HTMLDialogElement>('pair-dialog').close();
    status(transfer?.role === 'sender' ? '已连接，等待对方确认' : '已连接，准备接收', '请保持双方页面打开。', 'connected');
  } else if (event.type === 'manifest') {
    const manifest = event.data as FileInfo[];
    $('incoming-files').innerHTML = fileMarkup(manifest);
    $('accept-files').hidden = false; $('save-note').hidden = false;
    const supportsDisk = manifest.length === 1 ? typeof (window as any).showSaveFilePicker === 'function' : typeof (window as any).showDirectoryPicker === 'function';
    setText($('save-note'), supportsDisk ? '选择保存位置后开始传输。文件会写入磁盘，并在完成时校验。' : '当前浏览器将文件暂存在内存中，总计最多 {size}。完成后请点击保存。', { size: bytes(config.memoryLimitBytes) });
  } else if (event.type === 'started') {
    $('progress-box').hidden = false; $('share-box').hidden = true; $('accept-files').hidden = true;
    status('正在传输', '请保持页面打开，手机不要锁屏。', 'connected');
    $('progress').setAttribute('value', '0'); setText($('percent'), '0%');
  } else if (event.type === 'file') $('current-file').textContent = event.data;
  else if (event.type === 'path') setText($('connection-path'), '{path} · DTLS 加密', { path: event.data });
  else if (event.type === 'progress') {
    const p = event.data; const percent = p.total ? Math.min(100, p.transferred / p.total * 100) : 0;
    $<HTMLProgressElement>('progress').value = percent; setText($('percent'), Math.floor(percent) + '%');
    setText($('transferred'), bytes(p.transferred) + ' / ' + bytes(p.total));
    setText($('speed'), bytes(p.speed) + '/s');
    const seconds = p.speed > 0 ? Math.ceil((p.total - p.transferred) / p.speed) : 0;
    setText($('remaining'), seconds > 60 ? Math.ceil(seconds / 60) + ' 分钟' : seconds ? seconds + ' 秒' : '即将完成');
  } else if (event.type === 'download') {
    const a = document.createElement('a'); a.href = event.data.url; a.download = event.data.info.name;
    a.className = 'download-file'; a.innerHTML = icon('down') + '<span></span>'+icon('check');
    setText(a.querySelector('span')!, '保存 {name}', { name: event.data.info.name });
    $('downloads').append(a);
  } else if (event.type === 'done') {
    status('传输完成，原样送达。', transfer?.role === 'sender' ? '接收方已收到并校验全部文件。' : '全部文件通过 SHA-256 校验；若下方有保存按钮，请点击保存。', 'done');
    $<HTMLProgressElement>('progress').value = 100; setText($('percent'), '100%'); setText($('remaining'), '完成');
    setText($('cancel'), '开始新的传输');
    signaling?.close(); signaling = undefined;
  } else if (event.type === 'error') {
    $('downloads').innerHTML = ''; $('accept-files').hidden = true;
    notice(event.data); status('传输未完成', '可以结束这次传输，重新配对后再试。', 'error');
    signaling?.close(); signaling = undefined; setText($('cancel'), '重新开始');
    $<HTMLDialogElement>('pair-dialog').close();
  }
}
function createTransfer(role: 'sender' | 'receiver') {
  const next = new Transfer(config, role, event => { if (transfer === next) events(event); });
  transfer = next; setBusy(true); $('notice').hidden = true;
  return transfer;
}
function endpoint() {
  const saved = localStorage.getItem('pizza-send-signal');
  const value = saved !== null ? saved : config.signalUrl;
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw Error('配对服务需要 HTTPS 地址');
  if (url.username || url.password || url.search || url.hash) throw Error('配对地址不能包含凭据或额外参数');
  return url.origin;
}
function signalFailure(message: string) {
  if (transfer?.completed || transfer?.stopped) return;
  if (transfer?.pc.connectionState === 'connected') toast('配对服务已断开，文件直传继续');
  else { notice(message); status('配对服务不可用', '可以结束后使用手动配对，或检查连接设置。', 'error'); }
}
async function automaticSender(t: Transfer) {
  const api = endpoint();
  const response = await fetch(api + '/rooms', { method: 'POST', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('配对服务暂不可用（' + response.status + '），请使用手动配对');
  const session = await response.json();
  const secret = randomToken(), key = await signalKey(secret);
  if (transfer !== t || t.stopped) return;
  if (!/^[a-f0-9]{64}$/.test(session.room) || !/^[a-f0-9]{64}$/.test(session.receiver)) throw Error('配对服务返回信息无效');
  let offered = false;
  const connection = new Signaling(key, async message => {
    if (transfer !== t || t.stopped) return;
    if (message.type === 'peer-ready' && !offered) { offered = true; status('正在连接接收方', '双方正在建立加密直连。'); await connection.send({ type: 'offer', description: await t.offer() }); }
    else if (message.type === 'answer') await t.finish(message.description);
    else if (message.type === 'peer-left') signalFailure('接收方已离开，请重新创建传输。');
  }, message => { if (transfer === t && !t.stopped) signalFailure(message); });
  signaling = connection;
  await connection.connect(api, session.room, 'sender', session.sender);
  if (transfer !== t || t.stopped) { connection.close(); return; }
  const url = new URL(location.href); url.hash = new URLSearchParams({ r: session.room, t: session.receiver, k: secret }).toString();
  shareLink = url.toString();
  $<HTMLInputElement>('share-link').value = shareLink; $('share-box').hidden = false;
  status('等待接收方', '把分享链接发给对方。传输期间请保持本页打开。');
}
async function automaticReceiver(params: URLSearchParams) {
  const api = endpoint();
  if (!api) throw Error('本站尚未配置自动配对服务，请使用手动配对码');
  const room = params.get('r') || '', token = params.get('t') || '', secret = params.get('k') || '';
  if (!/^[a-f0-9]{64}$/.test(room) || !/^[a-f0-9]{64}$/.test(token)) throw Error('分享链接不完整');
  const t = createTransfer('receiver');
  status('正在连接发送方', '确认连接后，会显示对方分享的文件。');
  let answered = false;
  const key = await signalKey(secret);
  if (transfer !== t || t.stopped) return;
  const connection = new Signaling(key, async message => {
    if (transfer !== t || t.stopped) return;
    if (message.type === 'offer' && !answered) { answered = true; await connection.send({ type: 'answer', description: await t.answer(message.description) }); }
    else if (message.type === 'peer-left') signalFailure('发送方已结束分享。');
  }, message => { if (transfer === t && !t.stopped) signalFailure(message); });
  signaling = connection;
  await connection.connect(api, room, 'receiver', token);
  if (transfer !== t || t.stopped) { connection.close(); return; }
  history.replaceState(null, '', location.pathname + location.search);
}
async function manualSender(t: Transfer) {
  status('正在准备配对码', '正在收集直连信息，通常需要几秒钟。');
  const code = await packDescription(await t.offer());
  if (transfer !== t || t.stopped) return;
  pairingKind = 'offer'; $<HTMLTextAreaElement>('outgoing-code').value = code;
  setText($('pair-instructions'), '把配对码发给对方。对方在「接收文件」中粘贴后，会得到应答码，再把应答码返回这里。');
  setText($('outgoing-label'), '发给接收方的配对码'); $('answer-section').hidden = false;
  $('pair-qr').hidden = true; $<HTMLTextAreaElement>('answer-code').value = '';
  $<HTMLDialogElement>('pair-dialog').showModal();
  status('等待手动配对', '没有自动配对服务时，双方交换配对码即可直连。');
}
async function manualReceiver(code: string) {
  const description = await unpackDescription(code.trim(), 'offer');
  const t = createTransfer('receiver');
  status('正在准备应答码', '正在建立连接信息，通常需要几秒钟。');
  const answer = await packDescription(await t.answer(description));
  if (transfer !== t || t.stopped) return;
  pairingKind = 'answer'; $<HTMLTextAreaElement>('outgoing-code').value = answer;
  setText($('pair-instructions'), '把下面的应答码复制给发送方。对方完成配对后，这里会显示文件列表。');
  setText($('outgoing-label'), '返回给发送方的应答码'); $('answer-section').hidden = true; $('pair-qr').hidden = true;
  $<HTMLDialogElement>('pair-dialog').showModal(); status('等待发送方完成配对', '请将应答码返回给发送方。');
}
async function receiveInput(input: string) {
  if (busy) return;
  const value = input.trim();
  if (value.startsWith('PS1.')) await manualReceiver(value);
  else {
    let url: URL;
    try { url = new URL(value); } catch { throw Error('请粘贴完整的分享链接或 PS1. 配对码'); }
    const params = new URLSearchParams(url.hash.slice(1));
    if (params.has('offer')) await manualReceiver(params.get('offer')!);
    else await automaticReceiver(params);
  }
}
$('language-toggle').onclick = () => {
  toggleLanguage(); setBusy(busy);
  if (transfer?.manifest.length && transfer.role === 'receiver') $('incoming-files').innerHTML = fileMarkup(transfer.manifest);
};
$('send-tab').onclick = () => { if (busy && transfer?.role !== 'sender') { toast('请先结束当前传输'); return; } view('sender'); };
$('receive-tab').onclick = () => { if (busy && transfer?.role !== 'receiver') { toast('请先结束当前传输'); return; } view('receiver'); };
$('drop-zone').onclick = () => $<HTMLInputElement>('file-input').click();
$<HTMLInputElement>('file-input').onchange = event => { const input = event.target as HTMLInputElement; select(Array.from(input.files || [])); input.value = ''; };
$('files').onclick = event => { const button = (event.target as HTMLElement).closest<HTMLElement>('.remove-file'); if (button && !busy) { files.splice(Number(button.dataset.index), 1); renderFiles(); } };
for (const event of ['dragenter', 'dragover']) $('drop-zone').addEventListener(event, e => { e.preventDefault(); if (!busy) $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragging'));
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); select(Array.from((event as DragEvent).dataTransfer?.files || [])); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('start-send').onclick = () => run(async () => {
  if (busy || !files.length) return;
  const t = createTransfer('sender'); t.prepare(files);
  status('正在创建传输', '正在准备连接，请稍候。');
  try { if (endpoint()) await automaticSender(t); else await manualSender(t); }
  catch (e) { if (transfer !== t || t.stopped) return; t.close(false); signaling?.close(); transfer = undefined; setBusy(false); throw e; }
});
$('connect-receive').onclick = () => run(async () => {
  try { await receiveInput($<HTMLTextAreaElement>('receive-code').value); }
  catch (e) { transfer?.close(false); signaling?.close(); transfer = undefined; setBusy(false); throw e; }
});
$('accept-files').onclick = () => run(async () => {
  $<HTMLButtonElement>('accept-files').disabled = true;
  try { await transfer?.accept(); } finally { $<HTMLButtonElement>('accept-files').disabled = false; }
});
$('cancel').onclick = reset;
$('close-dialog').onclick = () => $<HTMLDialogElement>('pair-dialog').close();
$('copy-link').onclick = () => run(async () => { await navigator.clipboard.writeText(shareLink); toast('分享链接已复制'); });
$('show-qr').onclick = () => run(async () => { $('share-qr').hidden = !$('share-qr').hidden; if (!$('share-qr').hidden) await QRCode.toCanvas($<HTMLCanvasElement>('share-qr'), shareLink, { width: 224, margin: 2, color: { dark: '#342c24', light: '#ffffff' } }); });
$('copy-code').onclick = () => run(async () => { await navigator.clipboard.writeText($<HTMLTextAreaElement>('outgoing-code').value); toast('配对码已复制'); });
$('pair-qr-button').onclick = () => run(async () => {
  const canvas = $<HTMLCanvasElement>('pair-qr'); canvas.hidden = !canvas.hidden;
  if (!canvas.hidden) {
    const code = $<HTMLTextAreaElement>('outgoing-code').value;
    const url = new URL(location.href); url.hash = new URLSearchParams({ [pairingKind]: code }).toString();
    await QRCode.toCanvas(canvas, pairingKind === 'offer' ? url.toString() : code, { width: 288, margin: 2 });
  }
});
$('apply-answer').onclick = () => run(async () => {
  const answer = await unpackDescription($<HTMLTextAreaElement>('answer-code').value.trim(), 'answer');
  if (!transfer || transfer.role !== 'sender') throw Error('请先创建一次发送');
  await transfer.finish(answer); status('正在建立加密直连', '配对信息已交换，请稍候。'); $<HTMLDialogElement>('pair-dialog').close();
});
$('save-settings').onclick = () => run(async () => {
  if (busy) throw Error('请先结束当前传输，再修改连接设置');
  const url = $<HTMLInputElement>('signal-url').value.trim();
  const stun = $<HTMLInputElement>('stun-url').value.trim();
  if (url) { const parsed = new URL(url); if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) throw Error('请使用 HTTPS 配对服务地址'); }
  if (stun && !/^stuns?:[^\s]+$/.test(stun)) throw Error('请输入有效的 stun: 或 stuns: 地址');
  localStorage.setItem('pizza-send-signal', url); localStorage.setItem('pizza-send-stun', stun);
  config.iceServers = stun ? [{ urls: stun }] : [];
  toast('连接设置已保存');
});
window.addEventListener('beforeunload', event => {
  if (transfer && !transfer.completed && !transfer.stopped) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { signaling?.close(); transfer?.close(false); });
async function init() {
  try {
    const response = await fetch('./app.config.json', { cache: 'no-store' });
    if (response.ok) config = { ...config, ...await response.json() };
  } catch {}
  const stun = localStorage.getItem('pizza-send-stun');
  if (stun !== null) config.iceServers = stun ? [{ urls: stun }] : [];
  $<HTMLInputElement>('signal-url').value = localStorage.getItem('pizza-send-signal') ?? config.signalUrl;
  $<HTMLInputElement>('stun-url').value = String(config.iceServers[0]?.urls || '');
  if (!('RTCPeerConnection' in window) || !crypto.subtle) { notice('请在支持 WebRTC 的现代浏览器中，通过 HTTPS 打开本站。'); $<HTMLButtonElement>('drop-zone').disabled = true; return; }
  const params = new URLSearchParams(originalHash.slice(1));
  if (params.has('r') || params.has('offer')) {
    view('receiver');
    await run(async () => {
      try { if (params.has('offer')) await manualReceiver(params.get('offer')!); else await automaticReceiver(params); }
      catch (e) { transfer?.close(false); signaling?.close(); transfer = undefined; setBusy(false); throw e; }
    });
  }
}
void init();


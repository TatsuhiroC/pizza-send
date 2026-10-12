import { registerStatic, setText, t, toggleLanguage } from './i18n';
import QRCode from 'qrcode';
import { deriveShare, deriveRecipientShare, receiverDigest, shareFragment, parseShare, isSharingURL } from './share';
import { CameraScanner } from './scanner';
import { supportsTemporaryStorage, listTemporaryFiles, temporaryURL, retainTemporaryFile, deleteTemporaryFile, storedKey, temporaryBusyCount, suspendTemporaryStorage, type StoredFile } from './received-storage';
import { Transfer, AutoPair, bytes, randomToken, packDescription, unpackDescription, signalKey, type Config, type FileInfo, type TransferEvent } from './protocol';
import { GroupSender, groupURL, groupRequest, type Recipient } from './group';
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
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    camera: '<path d="M4 6h4l2-3h4l2 3h4v15H4z"/><circle cx="12" cy="13" r="4"/>',
    qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h-3zM21 15v6h-6"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>'
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.file) + '</svg>';
};
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = [
  '<header class="header"><a class="brand" href="./"><img src="./pizza.svg" alt="" width="38" height="38"/><span>PizzaSend<small>文件快传</small></span></a><div class="header-right"><span class="version">第二片 · v0.2</span><button id="language-toggle" class="language-toggle" type="button"><span data-language="zh">中</span><span class="language-divider" aria-hidden="true">/</span><span data-language="en">EN</span></button><a class="github" href="https://github.com/TatsuhiroC/pizza-send" target="_blank" rel="noopener">GitHub ↗</a></div></header>',
  '<main><section class="intro"><div class="eyebrow"><span></span>好东西，直接分享。</div><h1>文件送到，<br/><span>热乎刚好。</span><img class="hero-pizza" src="./pizza.svg" alt="" width="104" height="104"/></h1><p>不用安装，不用注册。<br class="mobile-break"/>打开网页，把文件直接送到另一台设备。</p></section>',
  '<section class="transfer-card" aria-label="文件传输"><div class="card-top"><div class="tabs" role="tablist" aria-label="传输角色"><button id="send-tab" class="tab active" role="tab" aria-selected="true">'+icon('upload')+'发送文件</button><button id="receive-tab" class="tab" role="tab" aria-selected="false">'+icon('down')+'接收文件</button></div><span class="secure">'+icon('lock')+'加密直传</span></div>',
  '<div id="send-view"><button id="drop-zone" class="drop-zone" type="button"><span class="drop-icon">'+icon('upload')+'</span><strong>把文件放在这里</strong><span>拖放文件，或点击选择</span><small>支持多个文件 · 文件内容不上传到服务器</small></button><input id="file-input" type="file" multiple hidden/><div id="files" class="file-list" aria-live="polite"></div><div class="send-bottom"><span id="selection-summary">先选一个文件，就可以开始。</span><button id="start-send" class="primary" disabled>创建传输 '+icon('arrow')+'</button></div></div>',
  '<div id="receive-view" hidden><div class="receive-intro"><span class="drop-icon">'+icon('down')+'</span><h2>接住这一份分享</h2><p>打开对方发来的分享链接即可连接。<br/>也可以在这里粘贴链接或配对码。</p></div><button id="open-scanner" class="secondary wide scan-button" type="button">'+icon('camera')+'打开相机扫描</button><p class="scan-alternative subtle">或粘贴分享链接／配对码</p><label class="sr-only" for="receive-code">分享链接或配对码</label><textarea id="receive-code" rows="3" placeholder="粘贴 PizzaSend 分享链接或 PS1. 配对码"></textarea><button id="connect-receive" class="primary wide">连接发送方 '+icon('arrow')+'</button><div id="incoming-files" class="file-list"></div><button id="accept-files" class="primary wide" hidden>选择保存位置并接收 '+icon('down')+'</button><p id="save-note" class="subtle" hidden></p></div>',
  '<div id="session-panel" class="session-panel" hidden><div class="session-heading"><span id="status-dot" class="status-dot"></span><h2 id="status">等待接收方</h2><button id="cancel" class="session-action" type="button">结束传输</button></div><p id="status-detail" class="subtle">传输期间请保持双方页面打开。</p><section id="save-panel" class="save-panel" aria-labelledby="save-heading" hidden><h3 id="save-heading" tabindex="-1">保存到设备</h3><p id="save-location-note" class="subtle">文件目前保存在浏览器暂存中，保存后才能在手机的“文件”App 或浏览器下载记录中找到。</p><div id="save-files"></div><div id="downloads" class="downloads"></div><p id="save-empty" class="subtle" hidden>暂存已清理或到期。如未保存，请让发送方重新分享。</p><p id="save-retention" class="subtle"></p><p id="save-feedback" class="save-feedback" role="status" hidden></p></section><div id="share-box" hidden><label for="share-link">把链接发给对方，或者让对方扫码</label><div class="link-row"><input id="share-link" readonly/><button id="copy-link" class="icon-button" aria-label="复制分享链接">'+icon('copy')+'</button></div><canvas id="share-qr" hidden></canvas><p id="share-note" class="subtle">链接 30 分钟内可加入，最多 10 位同时接收。请只分享给预期接收者。</p></div><div id="recipients" class="recipients" hidden></div><div id="progress-box" hidden><div class="progress-meta"><button id="current-file" class="filename-button" type="button" aria-haspopup="dialog"></button><span id="percent">0%</span></div><progress id="progress" max="100" value="0" aria-label="传输进度"></progress><div class="metrics"><div><span id="transferred">0 B</span><small>已接收</small></div><div><span id="speed">—</span><small>平均速度</small></div><div><span id="remaining">—</span><small>预计剩余</small></div></div><div class="path-label">'+icon('lock')+'<span id="connection-path">浏览器之间加密传输</span><span>SHA-256 校验</span></div></div></div>',
  '<div id="notice" class="notice" role="alert" hidden></div></section>',
  '<section id="stored-panel" class="stored-panel" aria-labelledby="stored-heading" hidden><div class="stored-heading"><div><h2 id="stored-heading">本机暂存</h2><span id="stored-size"></span></div><button id="clear-stored" class="secondary cleanup-stored" type="button" hidden>'+icon('trash')+'<span>清理全部暂存</span></button></div><p class="subtle">文件暂存在这台设备的磁盘里，整批接收完成后保留 10 分钟。点击保存会为该文件重新预留 10 分钟；下载完成后，也可以立即清理全部暂存。</p><p id="stored-busy" class="subtle" hidden>部分暂存正在另一个页面使用。请关闭该页面后，再清理全部暂存。</p><div id="stored-files"></div><p class="subtle">到期自动清理。网页关闭或暂停时，下次打开或返回再清理；不会删除已经下载的副本。刷新不会延长保存时间，未完成的传输不能在刷新后续传。浏览器也可能提前回收暂存，请及时保存。</p></section>',
  '<section class="benefits"><div>'+icon('bolt')+'<h3>直接送达</h3><p>两端连接后，即传即收。</p></div><div>'+icon('lock')+'<h3>加密传输</h3><p>文件在浏览器之间加密传递。</p></div><div>'+icon('file')+'<h3>原样分享</h3><p>保留内容，逐个校验文件。</p></div></section>',
  '<details class="faq"><summary>开始之前，你可能想知道</summary><div><p><strong>要一直打开页面吗？</strong> 是的。发送和接收期间请保持页面打开，手机尽量不要锁屏。关闭页面会中断传输。</p><p><strong>大文件能传吗？</strong> 桌面 Chrome / Edge 支持直接保存。支持写盘的 Safari 等浏览器先在本机磁盘暂存，再点击保存；大小取决于设备空间和浏览器额度，保存时可能同时占用两份空间。不支持写盘时仍限制为总计 256 MB。</p><p><strong>所有网络都能连上吗？</strong> 首版使用直连，不提供文件中继。部分移动、公司或受限网络可能无法连接，可以尝试同一 Wi-Fi。</p><p><strong>可以断点续传吗？</strong> 自动配对支持页面保持打开时断线重连、从已接收位置续传。刷新或关闭页面后不能续传；手动配对暂不支持自动重连。</p><p><strong>“加密”意味着什么？</strong> WebRTC 数据通道使用 DTLS 加密。自动配对信息也在浏览器里加密，配对密钥放在链接片段中。使用网页仍需要信任本站提供的程序代码。</p></div></details>',
  '<details class="settings"><summary>连接设置</summary><div class="settings-body"><label for="signal-url">配对服务地址</label><input id="signal-url" placeholder="https://pizza-send-signal.…workers.dev"/><label for="stun-url">STUN 服务地址</label><input id="stun-url" placeholder="stun:stun.cloudflare.com:3478"/><button id="save-settings" class="secondary">保存设置</button><p class="subtle">没有配对服务时，可用手动配对码连接。STUN 只帮助建立连接，不中转文件。</p></div></details>',
  '</main><footer><span>🍕 一点披萨精神，一份直接的分享。</span><span>受 <a href="https://github.com/kern/filepizza" target="_blank" rel="noopener">FilePizza</a> 启发 · 开源制作</span></footer>',
  '<dialog id="pair-dialog"><div class="dialog-heading"><h2>手动配对</h2><button id="close-dialog" class="icon-button" aria-label="关闭配对窗口">'+icon('close')+'</button></div><p id="pair-instructions"></p><label id="outgoing-label" for="outgoing-code">配对码</label><textarea id="outgoing-code" rows="4" readonly></textarea><div class="dialog-actions"><button id="copy-code" class="secondary">'+icon('copy')+'复制配对码</button><button id="pair-qr-button" class="secondary">'+icon('qr')+'二维码</button></div><canvas id="pair-qr" hidden></canvas><div id="answer-section"><label for="answer-code">对方返回的应答码</label><textarea id="answer-code" rows="3" placeholder="粘贴接收方返回的 PS1. 应答码"></textarea><button id="apply-answer" class="primary wide">完成配对 '+icon('arrow')+'</button></div><p class="subtle">仅交换连接信息，文件仍通过加密直连发送。请只向预期接收者提供配对码。</p></dialog>',
  '<dialog id="scan-dialog" class="scan-dialog"><div class="dialog-heading"><h2>扫描分享二维码</h2><button id="close-scanner" class="icon-button" aria-label="关闭相机">'+icon('close')+'</button></div><div class="scan-frame"><video id="scan-video" autoplay muted playsinline aria-label="相机画面"></video><div class="scan-guide" aria-hidden="true"></div></div><p id="scan-status" role="status">请允许相机权限，将对方的二维码放入画面。</p><p class="subtle">画面仅在本机识别，关闭后相机会停止。</p><div class="dialog-actions"><button id="scan-again" class="secondary" hidden>重试相机</button><button id="choose-qr-image" class="secondary">'+icon('file')+'从图片识别</button></div><input id="qr-image-input" type="file" accept="image/*" hidden/></dialog>',
  '<dialog id="cleanup-dialog"><div class="dialog-heading"><h2>清理全部暂存？</h2></div><p id="cleanup-name"></p><p>请确认所有文件已保存，并且浏览器下载已经完成。清理后无法再从本站保存这些暂存；本地下载的副本会保留。</p><div class="dialog-actions"><button id="keep-stored" class="secondary">保留暂存</button><button id="confirm-cleanup" class="primary">确认清理</button></div><p id="cleanup-error" class="subtle" role="alert" hidden></p></dialog>',
  '<dialog id="filename-dialog" aria-labelledby="filename-heading"><div class="dialog-heading"><h2 id="filename-heading">完整文件名</h2><button id="close-filename" class="icon-button" type="button" aria-label="关闭文件名窗口">'+icon('close')+'</button></div><p id="full-filename"></p></dialog>',
  '<div id="toast" class="toast" role="status" hidden></div>'
].join('');
registerStatic(app);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
let config: Config = { signalUrl: '', iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], memoryLimitBytes: 268435456 };
let files: File[] = [];
let transfer: Transfer | undefined;
let signaling: AutoPair | undefined;
let senderGroup: GroupSender | undefined;
let receiverGroupURL = "";
let shareLink = '';
let shareQRRevision = 0;
let pairingKind: 'offer' | 'answer' = 'offer';
let busy = false;
let toastTimer: ReturnType<typeof setTimeout>;
const originalHash = location.hash;
let sessionRevision = 0;
let scannerSession = 0;
let diskStorageAvailable = false;
let storedFiles: StoredFile[] = [];
let filenameSequence = 0;
let cleanupTargets: StoredFile[] = [];
let clearingStored = false;
let storedRevision = 0;
let storedFingerprint = '';
let storedRetry: ReturnType<typeof setTimeout> | undefined;
const saveRequests = new Set<string>();
let pendingSaveScroll: number | undefined;
const storageReady = supportsTemporaryStorage().then(value => diskStorageAvailable = value);
function saveNote(manifest: FileInfo[]) {
  const native = manifest.length === 1 ? typeof (window as any).showSaveFilePicker === 'function' : typeof (window as any).showDirectoryPicker === 'function';
  setText($('save-note'), native ? '选择保存位置后开始传输。文件会写入磁盘，并在完成时校验。' : diskStorageAvailable ? '文件会分块写入本机磁盘，完成后请点击保存。保存时可能同时占用两份空间，下载完成后请清理暂存。' : '当前浏览器将文件暂存在内存中，总计最多 {size}。完成后请点击保存。', { size: bytes(config.memoryLimitBytes) });
  setText($('accept-files'), native ? '选择保存位置并接收' : '接收文件');
}
async function refreshStored() {
  const revision = ++storedRevision;
  try {
    const records = (await listTemporaryFiles()).sort((a, b) =>
      (b.receivedAt ?? b.createdAt) - (a.receivedAt ?? a.createdAt) || b.createdAt - a.createdAt || b.info.id - a.info.id || a.session.localeCompare(b.session));
    const links = await Promise.all(records.map(async record => ({ record, url: record.unavailable ? '' : await temporaryURL(record) })));
    if (revision !== storedRevision) return;
    storedFiles = records;
    $('clear-stored').hidden = !records.length;
    $<HTMLButtonElement>('clear-stored').disabled = clearingStored || !!temporaryBusyCount();
    clearTimeout(storedRetry);
    const deadlines = records.flatMap(record => record.expiresAt === undefined ? [] : [record.expiresAt]);
    if (temporaryBusyCount() || deadlines.length) {
      const delay = Math.max(100, Math.min(60000, temporaryBusyCount() ? 2000 : Infinity, ...deadlines.map(time => time - Date.now())));
      storedRetry = setTimeout(() => { void refreshStored(); }, delay);
    }
    $('stored-busy').hidden = !temporaryBusyCount();
    $('stored-panel').hidden = !links.length && !temporaryBusyCount();
    setText($('stored-size'), '暂存占用 {size}', { size: bytes(records.reduce((sum, item) => sum + item.info.size, 0)) });
    const currentSession = currentTemporarySession();
    const fingerprint = JSON.stringify({ links, currentSession });
    if (fingerprint === storedFingerprint) { updateStoredDeadlines(); updateSaveAvailability(); return; }
    storedFingerprint = fingerprint;
    $('stored-files').replaceChildren(); $('save-files').replaceChildren();
    for (const { record, url } of links) {
      const row = document.createElement('div'); row.className = 'stored-file'; row.dataset.key = storedKey(record);
      const a = document.createElement('a'); a.download = record.info.name; a.className = 'download-file';
      if (url) {
        a.href = url;
        // Preserve Safari's direct download gesture; extending retention runs alongside it.
        a.onclick = () => { markSaveRequested(storedKey(record)); void retainTemporaryFile(record).catch(error => notice(errorMessage(error))); };
      } else { a.setAttribute('aria-disabled', 'true'); a.classList.add('unavailable-file'); }
      const prominent = record.session === currentSession;
      const download = downloadRow(record.info.name, a, prominent);
      const detail = document.createElement('div'); detail.className = 'stored-detail';
      const size = document.createElement('span');
      if (record.unavailable) setText(size, '暂存文件不可用，可以清理记录'); else size.textContent = bytes(record.info.size);
      const deadline = document.createElement('span'); deadline.className = 'stored-deadline';
      detail.append(size, deadline); row.append(download, detail);
      restoreSaveRequest(row, storedKey(record));
      $(prominent ? 'save-files' : 'stored-files').append(row);
    }
    updateStoredDeadlines(); updateSaveAvailability();
  } catch (error) {
    if (revision === storedRevision) {
      notice(errorMessage(error)); clearTimeout(storedRetry);
      storedRetry = setTimeout(() => { void refreshStored(); }, 60000);
    }
  }
}
function updateStoredDeadlines() {
  const rows = new Map(Array.from(document.querySelectorAll<HTMLElement>('.stored-file'), row => [row.dataset.key, row]));
  for (const record of storedFiles) {
    const label = rows.get(storedKey(record))?.querySelector<HTMLElement>('.stored-deadline');
    if (label) setText(label, record.expiresAt === undefined ? '本次传输结束后保留 10 分钟' : '约 {minutes} 分钟后清理', { minutes: Math.max(1, Math.ceil(((record.expiresAt ?? 0) - Date.now()) / 60000)) });
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refreshStored(); revealSaveActions(); } });
document.addEventListener('close', () => revealSaveActions(), true);
window.addEventListener('focus', () => { void refreshStored(); });
window.addEventListener('pizzasend-storage-change', () => { void refreshStored(); });
void storageReady.then(() => {
  if (transfer?.role === 'receiver' && transfer.manifest.length) saveNote(transfer.manifest);
  return refreshStored();
});
$('keep-stored').onclick = () => $<HTMLDialogElement>('cleanup-dialog').close();
function filenameButton(name: string) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'filename-button';
  button.id = 'filename-' + ++filenameSequence;
  button.textContent = name; button.title = name; button.setAttribute('aria-haspopup', 'dialog');
  return button;
}
function downloadRow(name: string, link: HTMLAnchorElement, prominent = false) {
  const row = document.createElement('div'); row.className = 'download-row';
  link.innerHTML = icon('down') + '<span></span>';
  setText(link.querySelector('span')!, prominent ? '保存到设备' : '保存');
  const button = filenameButton(name); link.setAttribute('aria-describedby', button.id);
  row.append(button, link); return row;
}
app.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.filename-button');
  if (!button || !button.textContent) return;
  $('full-filename').textContent = button.textContent;
  $<HTMLDialogElement>('filename-dialog').showModal();
});
$('close-filename').onclick = () => $<HTMLDialogElement>('filename-dialog').close();
function cleanupSummary() {
  setText($('cleanup-name'), '{count} 个文件 · {size}', { count: cleanupTargets.length, size: bytes(cleanupTargets.reduce((sum, file) => sum + file.info.size, 0)) });
}
$('clear-stored').onclick = () => {
  if (clearingStored || !storedFiles.length || temporaryBusyCount()) return;
  // Confirm the files visible now; files arriving later need their own confirmation.
  cleanupTargets = [...storedFiles]; cleanupSummary();
  $('cleanup-error').hidden = true; $<HTMLDialogElement>('cleanup-dialog').showModal();
};
$('confirm-cleanup').onclick = () => run(async () => {
  if (clearingStored || !cleanupTargets.length) return;
  clearingStored = true; $<HTMLButtonElement>('clear-stored').disabled = true;
  $('cleanup-error').hidden = true;
  $<HTMLButtonElement>('confirm-cleanup').disabled = true; $<HTMLButtonElement>('keep-stored').disabled = true;
  setText($('confirm-cleanup'), '正在清理…');
  try {
    while (cleanupTargets.length) {
      try { await deleteTemporaryFile(cleanupTargets[0]); }
      catch (error) {
        // The automatic deadline may already have removed a confirmed file.
        const current = await listTemporaryFiles();
        if (temporaryBusyCount() || current.some(file => storedKey(file) === storedKey(cleanupTargets[0]))) throw error;
      }
      cleanupTargets.shift();
    }
    $<HTMLDialogElement>('cleanup-dialog').close(); toast('暂存已清理，本地下载的文件会保留。');
  } catch (error) {
    cleanupSummary(); setText($('cleanup-error'), errorMessage(error)); $('cleanup-error').hidden = false;
  } finally {
    clearingStored = false;
    setText($('confirm-cleanup'), '确认清理');
    $<HTMLButtonElement>('confirm-cleanup').disabled = false; $<HTMLButtonElement>('keep-stored').disabled = false;
    await refreshStored();
  }
});
$<HTMLDialogElement>('cleanup-dialog').addEventListener('cancel', event => { if (clearingStored) event.preventDefault(); });
const scanner = new CameraScanner($<HTMLVideoElement>('scan-video'), scannedCode, message => scanMessage(message, true));
function scanMessage(message: string, retry = false) {
  setText($('scan-status'), message); $('scan-again').hidden = !retry;
}
function closeScanner() {
  scannerSession++; scanner.stop();
  if ($<HTMLDialogElement>('scan-dialog').open) $<HTMLDialogElement>('scan-dialog').close();
}
async function openScanner() {
  if (busy) return;
  const dialog = $<HTMLDialogElement>('scan-dialog');
  if (!dialog.open) { scannerSession++; dialog.showModal(); }
  scanMessage('请允许相机权限，将对方的二维码放入画面。');
  await scanner.start();
}
async function connectValue(input: string) {
  if (busy) return;
  const revision = ++sessionRevision;
  setBusy(true);
  try { await receiveInput(input, revision); }
  catch (e) {
    if (revision !== sessionRevision) return;
    leaveReceiverGroup(); transfer?.close(false); signaling?.close(); signaling = undefined; transfer = undefined; setBusy(false); throw e;
  }
}
async function scannedCode(text: string): Promise<boolean> {
  const session = scannerSession, value = text.trim();
  if (!$<HTMLDialogElement>('scan-dialog').open || busy) return false;
  try {
    if (value.startsWith('PS1.')) await unpackDescription(value, 'offer');
    else {
      const url = new URL(value);
      if (!isSharingURL(url, new URL(location.href))) throw Error('Unknown website');
      const params = new URLSearchParams(url.hash.slice(1));
      if (params.has('offer')) await unpackDescription(params.get('offer')!, 'offer');
      else await parseShare(url.hash);
    }
  } catch {
    if (session === scannerSession) scanMessage('这不是有效的 PizzaSend 分享二维码，请扫描对方生成的二维码。');
    return false;
  }
  if (session !== scannerSession || !$<HTMLDialogElement>('scan-dialog').open || busy) return false;
  closeScanner(); view('receiver'); $<HTMLTextAreaElement>('receive-code').value = value;
  await run(() => connectValue(value));
  return true;
}
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
  return list.map((f, i) => '<div class="file-row"><span class="file-symbol">'+icon('file')+'</span><div><button class="filename-button" type="button" aria-haspopup="dialog" title="'+escapeHtml(f.name)+'"><strong>'+escapeHtml(f.name)+'</strong></button><small>'+bytes(f.size)+'</small></div>'+(removable ? '<button class="icon-button remove-file" data-index="'+i+'" aria-label="'+escapeHtml(t('移除 {name}', { name: f.name }))+'">'+icon('close')+'</button>' : '<span class="file-ready">'+t('待接收')+'</span>')+'</div>').join('');
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
  $<HTMLButtonElement>('open-scanner').disabled = value;
}
function clearShareQR() {
  shareQRRevision++;
  const canvas = $<HTMLCanvasElement>('share-qr');
  canvas.hidden = true; canvas.width = canvas.height = 0;

}
function reset() {
  sessionRevision++; pendingSaveScroll = undefined; saveRequests.clear();
  closeScanner();
  senderGroup?.close(); senderGroup = undefined; leaveReceiverGroup();
  signaling?.close(); signaling = undefined;
  transfer?.close(); transfer = undefined;
  shareLink = ''; $<HTMLInputElement>('share-link').value = ''; clearShareQR(); setBusy(false);
  $('recipients').replaceChildren(); $('recipients').hidden = true;
  $('share-box').hidden = true; $('progress-box').hidden = true; $('session-panel').hidden = true;
  $('notice').hidden = true; $('incoming-files').innerHTML = ''; $('downloads').innerHTML = '';
  $('save-panel').hidden = true; $('save-feedback').hidden = true; $('save-files').replaceChildren();
  void refreshStored();
  $('accept-files').hidden = true; $('save-note').hidden = true;
  setText($('cancel'), '结束传输');
  $<HTMLButtonElement>('accept-files').disabled = false;
  $<HTMLDialogElement>('pair-dialog').close();
  history.replaceState(null, '', location.pathname + location.search);
}
function events(event: TransferEvent) {
  if (event.type === 'pairing') {
    status(event.data, event.data === '配对信息已交换，正在寻找直连路径' ? '请保持手机在发送页面；VPN 需要允许本地网络和 WebRTC。' : '请让发送方保持页面打开，手机不要锁屏。');
  } else if (event.type === 'connected') {
    $<HTMLDialogElement>('pair-dialog').close();
    status(transfer?.role === 'sender' ? '已连接，等待对方确认' : '已连接，准备接收', '请保持双方页面打开。', 'connected');
  } else if (event.type === 'manifest') {
    const manifest = event.data as FileInfo[];
    $('incoming-files').innerHTML = fileMarkup(manifest);
    $('accept-files').hidden = false; $('save-note').hidden = false;
    saveNote(manifest);
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
    a.className = 'download-file';
    const key = 'memory:' + sessionRevision + ':' + event.data.info.id;
    const row = document.createElement('div'); row.className = 'memory-file'; row.dataset.saveKey = key;
    row.append(downloadRow(event.data.info.name, a, true));
    a.onclick = () => markSaveRequested(key); $('downloads').append(row);
  } else if (event.type === 'done') {
    if (transfer?.role === 'receiver') completeReception(transfer);
    else status('传输完成，原样送达。', '接收方已收到并校验全部文件。', 'done');
    $<HTMLProgressElement>('progress').value = 100; setText($('percent'), '100%'); setText($('remaining'), '完成');
    setText($('cancel'), '开始新的传输');
    // The receiver keeps pairing available until the sender confirms completion,
    // so a lost final receipt can be recovered without re-downloading the files.
    if (transfer?.role === 'sender') { signaling?.close(); signaling = undefined; }
  } else if (event.type === 'recovering') {
    status('网络切换，正在恢复连接', '已接收的进度会保留，请保持双方页面打开。正在寻找可用的直连路径。');
    setText($('remaining'), '等待网络恢复');
  } else if (event.type === 'resumed') {
    status('连接已恢复，继续传输', '从接收方确认的位置继续，完成后仍会校验整个文件。', 'connected');
  } else if (event.type === 'error') {
    $('downloads').innerHTML = ''; $('save-panel').hidden = true; pendingSaveScroll = undefined; $('accept-files').hidden = true;
    notice(event.data); status('传输未完成', '可以结束这次传输，重新配对后再试。', 'error');
    leaveReceiverGroup(); signaling?.close(); signaling = undefined; setText($('cancel'), '重新开始');
    $<HTMLDialogElement>('pair-dialog').close();
  }
}
function currentTemporarySession() {
  return transfer?.role === 'receiver' && transfer.completed ? transfer.temporarySession : undefined;
}
function restoreSaveRequest(row: HTMLElement, key: string) {
  row.dataset.saveKey = key;
  if (!saveRequests.has(key)) return;
  let state = row.querySelector<HTMLElement>('.save-request-state');
  if (!state) { state = document.createElement('p'); state.className = 'save-request-state'; row.append(state); }
  setText(state, '已发起保存，请确认下载提示');
}
function markSaveRequested(key: string) {
  saveRequests.add(key);
  for (const row of document.querySelectorAll<HTMLElement>('[data-save-key]')) if (row.dataset.saveKey === key) restoreSaveRequest(row, key);
  setText($('save-feedback'), '已发起保存，请确认浏览器的下载提示。下载完成后，可在手机的“文件”App 或浏览器下载记录中查找。');
  // A download click is not proof of a completed or accepted browser download.
  $('save-feedback').hidden = $('save-panel').hidden;
  const currentRows = Array.from($('save-panel').querySelectorAll<HTMLElement>('[data-save-key]'));
  if (transfer?.role === 'receiver' && transfer.completed && currentRows.length === transfer.manifest.length && currentRows.every(row => saveRequests.has(row.dataset.saveKey!))) {
    status('已发起保存，请确认下载提示', '请在浏览器中确认保存，并等待下载完成。');
  }
}
function updateSaveAvailability() {
  if (transfer?.role !== 'receiver' || !transfer.completed || transfer.saveMode === 'device') return;
  const available = !!$('save-panel').querySelector('a.download-file[href]');
  $('save-empty').hidden = available; $('save-retention').hidden = !available;
}
function revealSaveActions() {
  const revision = pendingSaveScroll;
  if (revision === undefined || document.hidden || document.querySelector('dialog[open]')) return;
  requestAnimationFrame(() => {
    if (pendingSaveScroll !== revision || sessionRevision !== revision || transfer?.role !== 'receiver' || !transfer.completed || document.hidden || document.querySelector('dialog[open]')) return;
    pendingSaveScroll = undefined;
    $('session-panel').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    $('save-heading').focus({ preventScroll: true });
  });
}
function completeReception(current: Transfer) {
  $('save-note').hidden = true;
  if (current.saveMode === 'device') {
    status('已保存到设备', '文件已写入你选择的位置，并通过 SHA-256 校验。', 'done');
    return;
  }
  status('文件已收到，请保存到设备', '全部文件通过 SHA-256 校验，还需要点击下面的保存按钮。');
  $('save-panel').hidden = false; $('save-panel').classList.toggle('single-file', current.manifest.length === 1);
  $('save-feedback').hidden = true;
  setText($('save-retention'), current.saveMode === 'disk' ? '浏览器暂存保留 10 分钟。点击保存会为该文件重新预留 10 分钟；请确认下载完成后再清理。' : '文件暂存在浏览器内存中，请保持页面打开并及时保存；刷新或关闭页面会丢失。');
  const revision = sessionRevision;
  // Obtain disk-backed URLs first; scrolling must reveal a usable save action.
  void refreshStored().then(() => {
    if (transfer !== current || !current.completed || current.stopped || revision !== sessionRevision) return;
    updateSaveAvailability(); pendingSaveScroll = revision; revealSaveActions();
  });
}
function leaveReceiverGroup() {
  const url = receiverGroupURL; receiverGroupURL = '';
  if (url) void groupRequest(url, { type: 'leave' }, true).catch(() => {});
}
function renderRecipients(peers: Recipient[], expired: boolean) {
  $('share-box').hidden = !shareLink;
  setText($('share-note'), expired ? '邀请已过期，正在进行的传输可以继续。' : '链接 30 分钟内可加入，最多 10 位同时接收。请只分享给预期接收者。');
  $('recipients').hidden = !peers.length;
  const active = peers.filter(peer => !['done', 'error', 'left'].includes(peer.phase));
  const done = peers.filter(peer => peer.phase === 'done').length;
  const failed = peers.filter(peer => peer.phase === 'error').length;
  if (!peers.length || (!active.length && !done && !failed)) status('等待接收方', '把同一个链接或二维码发给多位接收者，请保持本页打开。');
  else if (!active.length && done && !failed) status('传输完成，原样送达。', '已完成 {count} 位接收者，分享仍可继续。', 'done');
  else if (!active.length && failed) status('部分接收未完成', '可以继续分享给其他接收者，未完成的设备可重新加入。', 'error');
  else if (active.length === 1 && peers.length === 1) {
    const peer = active[0];
    status(peer.phase === 'sending' ? '正在传输' : peer.message, '同一分享可继续加入其他接收者，请保持本页打开。', peer.phase === 'sending' ? 'connected' : 'waiting');
  } else status('多人分享进行中', '每位接收者独立传输；一人断线不会中断其他人。', 'connected');
  if (done && !active.length) setText($('status-detail'), '已完成 {count} 位接收者，分享仍可继续。', { count: done });
  setText($('cancel'), '结束分享');
  // Keep the familiar single-transfer summary; concurrent transfers have their own rows.
  $('progress-box').hidden = peers.length !== 1 || !peers[0]?.started;
  if (peers.length === 1) {
    const peer = peers[0], percentage = peer.total ? peer.transferred / peer.total * 100 : peer.phase === 'done' ? 100 : 0;
    $('current-file').textContent = peer.file; $<HTMLProgressElement>('progress').value = percentage;
    setText($('percent'), Math.floor(percentage) + '%'); setText($('transferred'), bytes(peer.transferred) + ' / ' + bytes(peer.total));
    setText($('speed'), bytes(peer.speed) + '/s'); setText($('remaining'), peer.phase === 'done' ? '完成' : peer.phase === 'recovering' ? '等待网络恢复' : '即将完成');
    if (peer.path) setText($('connection-path'), '{path} · DTLS 加密', { path: peer.path });
  }
  const rows = new Map(Array.from($('recipients').querySelectorAll<HTMLElement>('.recipient-row'), row => [row.dataset.client, row]));
  const clients = new Set(peers.map(peer => peer.client));
  for (const [client, row] of rows) if (!clients.has(client!)) row.remove();
  for (const peer of peers) {
    let row = rows.get(peer.client);
    if (!row) {
      row = document.createElement('div'); row.className = 'recipient-row'; row.dataset.client = peer.client;
      row.innerHTML = '<div class="recipient-heading"><strong></strong><span></span></div><button class="filename-button" type="button" aria-haspopup="dialog"></button><progress max="100" value="0"></progress><div class="recipient-detail"><span></span><span></span></div>';
      $('recipients').append(row);
    }
    row.dataset.phase = peer.phase;
    setText(row.querySelector('strong')!, '接收者 {number}', { number: peer.number }); setText(row.querySelector('.recipient-heading span')!, peer.message);
    const name = row.querySelector<HTMLButtonElement>('.filename-button')!; name.textContent = peer.file; name.hidden = !peer.file;
    const percent = peer.total ? Math.min(100, peer.transferred / peer.total * 100) : peer.phase === 'done' ? 100 : 0;
    const bar = row.querySelector('progress')!; bar.value = percent; bar.setAttribute('aria-label', t('接收者 {number} 的进度', { number: peer.number }));
    const detail = row.querySelectorAll<HTMLElement>('.recipient-detail span');
    setText(detail[0], bytes(peer.transferred) + ' / ' + bytes(peer.total)); setText(detail[1], Math.floor(percent) + '% · ' + bytes(peer.speed) + '/s');
  }
}
function createTransfer(role: 'sender' | 'receiver') {
  const next = new Transfer(config, role, event => { if (transfer === next) { if (role === 'sender' && senderGroup) senderGroup.firstEvent(event); else events(event); } });
  transfer = next; setBusy(true); $('notice').hidden = true;
  return transfer;
}
function preferredSignalUrl() {
  const saved = readPreference('pizza-send-signal');
  // Follow the moved production default without replacing custom or manual settings.
  if (config.signalUrl === 'https://signal.pizzasend.dpdns.org' &&
    (saved === 'https://pizza-send-signal.jimchenqizheng.workers.dev' || saved === 'https://pizza-send-signal.jimchenqizheng.workers.dev/')) return config.signalUrl;
  return saved ?? config.signalUrl;
}
function endpoint() {
  const value = preferredSignalUrl();
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
  const secret = randomToken(), credentials = await deriveShare(secret);
  if (transfer !== t || t.stopped) return;
  const response = await fetch(api + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 2, room: credentials.room, receiverHash: await receiverDigest(credentials.receiver), multi: true }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('配对服务暂不可用（' + response.status + '），请使用手动配对');
  const session = await response.json();
  if (session.v !== 2 || session.room !== credentials.room || !/^[a-f0-9]{64}$/.test(session.sender)) throw Error('配对服务返回信息无效');
  if (transfer !== t || t.stopped) {
    void groupRequest(groupURL(api, session.room, 'sender', session.sender, randomToken()), { type: 'end' }, true).catch(() => {});
    return;
  }
  const group = new GroupSender(t, config, [...files], secret, api, session.room, session.sender,
    (peers, expired) => { if (senderGroup === group) renderRecipients(peers, expired); },
    message => { if (senderGroup === group) notice(message); });
  senderGroup = group;
  await group.connect();
  if (transfer !== t || t.stopped) { group.close(); return; }
  const url = new URL(location.href); url.search = ''; url.hash = shareFragment(secret);
  clearShareQR();
  shareLink = url.toString();
  $<HTMLInputElement>('share-link').value = shareLink; $('share-box').hidden = false;
  status('等待接收方', '把同一个链接或二维码发给多位接收者，请保持本页打开。');
  await renderShareQR();
}
async function automaticReceiver(fragment: string, revision: number) {
  const api = endpoint();
  if (!api) throw Error('本站尚未配置自动配对服务，请使用手动配对码');
  const { room, receiver: token, secret } = await parseShare(fragment);
  if (revision !== sessionRevision) return;
  const t = createTransfer('receiver');
  status('正在连接发送方', '确认连接后，会显示对方分享的文件。');
  const client = randomToken(), parent = groupURL(api, room, 'receiver', token, client);
  const state = await groupRequest(parent);
  if (transfer !== t || t.stopped) return;
  let pairedRoom = room, pairedToken = token, pairedSecret = secret;
  if (state.multi === true) {
    receiverGroupURL = parent;
    const share = await deriveRecipientShare(secret, client);
    if (transfer !== t || t.stopped) { void groupRequest(parent, { type: 'leave' }, true).catch(() => {}); return; }
    await groupRequest(parent, { type: 'join', room: share.room, receiverHash: await receiverDigest(share.receiver) });
    if (transfer !== t || t.stopped) { void groupRequest(parent, { type: 'leave' }, true).catch(() => {}); return; }
    pairedRoom = share.room; pairedToken = share.receiver; pairedSecret = share.secret;
  }
  const key = await signalKey(pairedSecret);
  if (transfer !== t || t.stopped) return;
  const connection = new AutoPair(t, key, message => { if (transfer === t && !t.stopped) signalFailure(message); });
  signaling = connection;
  await connection.connect(api, pairedRoom, 'receiver', pairedToken);
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
  await renderPairQR();
}
async function manualReceiver(code: string, revision: number) {
  const description = await unpackDescription(code.trim(), 'offer');
  if (revision !== sessionRevision) return;
  const t = createTransfer('receiver');
  status('正在准备应答码', '正在建立连接信息，通常需要几秒钟。');
  const answer = await packDescription(await t.answer(description));
  if (transfer !== t || t.stopped) return;
  pairingKind = 'answer'; $<HTMLTextAreaElement>('outgoing-code').value = answer;
  setText($('pair-instructions'), '把下面的应答码复制给发送方。对方完成配对后，这里会显示文件列表。');
  setText($('outgoing-label'), '返回给发送方的应答码'); $('answer-section').hidden = true; $('pair-qr').hidden = true;
  $<HTMLDialogElement>('pair-dialog').showModal(); status('等待发送方完成配对', '请将应答码返回给发送方。');
}
async function receiveInput(input: string, revision: number) {
  const value = input.trim();
  if (value.startsWith('PS1.')) await manualReceiver(value, revision);
  else {
    let url: URL;
    try { url = new URL(value); } catch { throw Error('请粘贴完整的分享链接或 PS1. 配对码'); }
    const params = new URLSearchParams(url.hash.slice(1));
    if (!isSharingURL(url, new URL(location.href))) throw Error('请粘贴本站的 PizzaSend 分享链接或 PS1. 配对码');
    if (params.has('offer')) await manualReceiver(params.get('offer')!, revision);
    else await automaticReceiver(url.hash, revision);
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
  sessionRevision++;
  const t = createTransfer('sender'); t.prepare(files);
  status('正在创建传输', '正在准备连接，请稍候。');
  try { if (endpoint()) await automaticSender(t); else await manualSender(t); }
  catch (e) { if (transfer !== t || t.stopped) return; senderGroup?.close(); senderGroup = undefined; t.close(false); signaling?.close(); transfer = undefined; setBusy(false); throw e; }
});
$('connect-receive').onclick = () => run(async () => {
  await connectValue($<HTMLTextAreaElement>('receive-code').value);
});
$('open-scanner').onclick = () => { void openScanner(); };
$('scan-again').onclick = () => { void openScanner(); };
$('close-scanner').onclick = closeScanner;
$<HTMLDialogElement>('scan-dialog').addEventListener('close', () => { scannerSession++; scanner.stop(); });
$<HTMLDialogElement>('scan-dialog').addEventListener('cancel', () => { scannerSession++; scanner.stop(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && $<HTMLDialogElement>('scan-dialog').open) {
    scannerSession++; scanner.stop(); scanMessage('扫描已暂停，点击重试相机继续。', true);
  }
});
$('choose-qr-image').onclick = () => {
  scannerSession++; scanner.stop(); scanMessage('请选择二维码图片，或点击重试相机。', true);
  $<HTMLInputElement>('qr-image-input').click();
};
$<HTMLInputElement>('qr-image-input').onchange = () => {
  const input = $<HTMLInputElement>('qr-image-input'), file = input.files?.[0];
  input.value = '';
  if (!file || !$<HTMLDialogElement>('scan-dialog').open) return;
  const session = ++scannerSession; scanner.stop();
  void (async () => {
    try {
      scanMessage('正在识别二维码图片…');
      const text = await scanner.readImage(file);
      if (session === scannerSession) await scannedCode(text);
    } catch (e) { if (session === scannerSession) scanMessage(errorMessage(e), true); }
  })();
};
$('accept-files').onclick = () => run(async () => {
  $('notice').hidden = true;
  $<HTMLButtonElement>('accept-files').disabled = true;
  try { await transfer?.accept(); } finally { $<HTMLButtonElement>('accept-files').disabled = false; }
});
$('cancel').onclick = reset;
$('close-dialog').onclick = () => $<HTMLDialogElement>('pair-dialog').close();
$('copy-link').onclick = () => run(async () => { await navigator.clipboard.writeText(shareLink); toast('分享链接已复制'); });
async function renderShareQR() {
  const canvas = $<HTMLCanvasElement>('share-qr'), revision = ++shareQRRevision, link = shareLink;
  if (!link) return;
  const rendered = document.createElement('canvas');
  await QRCode.toCanvas(rendered, link, { width: 224, margin: 2, color: { dark: '#342c24', light: '#ffffff' } });
  if (revision !== shareQRRevision || link !== shareLink) return;
  canvas.width = rendered.width; canvas.height = rendered.height;
  canvas.getContext('2d')!.drawImage(rendered, 0, 0); canvas.hidden = false;
}
$('copy-code').onclick = () => run(async () => { await navigator.clipboard.writeText($<HTMLTextAreaElement>('outgoing-code').value); toast('配对码已复制'); });
$('pair-qr-button').onclick = () => run(async () => {
  if (!$('pair-qr').hidden) $('pair-qr').hidden = true;
  else await renderPairQR();
});
async function renderPairQR() {
  const canvas = $<HTMLCanvasElement>('pair-qr'), code = $<HTMLTextAreaElement>('outgoing-code').value, kind = pairingKind, revision = sessionRevision;
  const url = new URL(location.href); url.hash = new URLSearchParams({ [kind]: code }).toString();
  const rendered = document.createElement('canvas');
  try { await QRCode.toCanvas(rendered, kind === 'offer' ? url.toString() : code, { width: 288, margin: 2 }); }
  catch { return; } // Long manual descriptions remain available as copyable codes.
  if (revision !== sessionRevision || code !== $<HTMLTextAreaElement>('outgoing-code').value || kind !== pairingKind) return;
  canvas.width = rendered.width; canvas.height = rendered.height; canvas.getContext('2d')!.drawImage(rendered, 0, 0); canvas.hidden = false;
}
$('apply-answer').onclick = () => run(async () => {
  const t = transfer;
  if (!t || t.role !== 'sender') throw Error('请先创建一次发送');
  const answer = await unpackDescription($<HTMLTextAreaElement>('answer-code').value.trim(), 'answer');
  if (transfer !== t || t.stopped) return;
  await t.finish(answer);
  if (transfer !== t || t.stopped) return;
  status('正在建立加密直连', '配对信息已交换，请稍候。'); $<HTMLDialogElement>('pair-dialog').close();
});
$('save-settings').onclick = () => run(async () => {
  if (busy) throw Error('请先结束当前传输，再修改连接设置');
  const url = $<HTMLInputElement>('signal-url').value.trim();
  const stun = $<HTMLInputElement>('stun-url').value.trim();
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) throw Error('请使用 HTTPS 配对服务地址');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw Error('配对地址不能包含凭据或额外参数');
  }
  if (stun && !/^stuns?:[^\s]+$/.test(stun)) throw Error('请输入有效的 stun: 或 stuns: 地址');
  localStorage.setItem('pizza-send-signal', url); localStorage.setItem('pizza-send-stun', stun);
  config.iceServers = stun ? [{ urls: stun }] : [];
  toast('连接设置已保存');
});
window.addEventListener('beforeunload', event => {
  if (senderGroup?.active || (transfer && !transfer.completed && !transfer.stopped)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { clearTimeout(storedRetry); closeScanner(); senderGroup?.close(); leaveReceiverGroup(); signaling?.close(); transfer?.close(false); suspendTemporaryStorage(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
function readPreference(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
async function init() {
  try {
    const response = await fetch('./app.config.json', { cache: 'no-store' });
    if (response.ok) config = { ...config, ...await response.json() };
  } catch {}
  const stun = readPreference('pizza-send-stun');
  if (stun !== null) config.iceServers = stun ? [{ urls: stun }] : [];
  $<HTMLInputElement>('signal-url').value = preferredSignalUrl();
  $<HTMLInputElement>('stun-url').value = String(config.iceServers[0]?.urls || '');
  if (!('RTCPeerConnection' in window) || !crypto.subtle) { notice('请在支持 WebRTC 的现代浏览器中，通过 HTTPS 打开本站。'); $<HTMLButtonElement>('drop-zone').disabled = true; return; }
  const params = new URLSearchParams(originalHash.slice(1));
  if (!busy && sessionRevision === 0 && (originalHash.startsWith('#2.') || params.has('r') || params.has('offer'))) {
    view('receiver');
    const url = new URL(location.href); url.hash = originalHash;
    await run(() => connectValue(url.toString()));
  }
}
void init();


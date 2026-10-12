export type Language = 'zh' | 'en';
type Params = Record<string, string | number>;
const messages: Record<string, string> = {
  '链接 30 分钟内可加入，最多 10 位同时接收。请只分享给预期接收者。': 'Join within 30 minutes. Up to 10 recipients at once. Share only with intended recipients.',
  '把同一个链接或二维码发给多位接收者，请保持本页打开。': 'Share the same link or QR code with multiple recipients. Keep this page open.',
  '邀请已过期，正在进行的传输可以继续。': 'The invitation has expired. Transfers in progress can continue.',
  '同时接收的人数已达 10 位，请稍后再试。': 'Ten recipients are already connected. Please try again later.',
  '配对服务尚不支持多人分享，请刷新后重试。': 'The signaling service does not support multiple recipients yet. Refresh and retry.',
  '结束分享': 'End sharing',
  '正在连接接收者': 'Connecting to recipient', '等待接收者确认': 'Waiting for recipient to accept', '接收者已退出': 'Recipient left',
  '接收者 {number}': 'Recipient {number}', '接收者 {number} 的进度': 'Progress for recipient {number}',
  '已完成 {count} 位接收者，分享仍可继续。': '{count} recipients completed. You can keep sharing.',
  '部分接收未完成': 'Some transfers did not finish',
  '可以继续分享给其他接收者，未完成的设备可重新加入。': 'Keep sharing with other recipients. Devices that did not finish can rejoin.',
  '同一分享可继续加入其他接收者，请保持本页打开。': 'More recipients can join this share. Keep this page open.',
  '多人分享进行中': 'Sharing with multiple recipients',
  '每位接收者独立传输；一人断线不会中断其他人。': 'Each recipient transfers independently. One disconnection does not interrupt the others.',

  '打开相机扫描': 'Open camera to scan',
  '或粘贴分享链接／配对码': 'Or paste a share link / pairing code',
  '扫描分享二维码': 'Scan a share QR code',
  '关闭相机': 'Close camera',
  '相机画面': 'Camera preview',
  '请允许相机权限，将对方的二维码放入画面。': 'Allow camera access and point it at the sender’s QR code.',
  '画面仅在本机识别，关闭后相机会停止。': 'Images are processed on this device. Closing this window stops the camera.',
  '重试相机': 'Retry camera',
  '从图片识别': 'Scan an image',
  '扫描已暂停，点击重试相机继续。': 'Scanning paused. Tap Retry camera to continue.',
  '请选择二维码图片，或点击重试相机。': 'Choose a QR code image, or tap Retry camera.',
  '正在识别二维码图片…': 'Reading the QR code image…',
  '这不是有效的 PizzaSend 分享二维码，请扫描对方生成的二维码。': 'This is not a valid PizzaSend share QR code. Scan the sender’s QR code.',
  '未获得相机权限，请在浏览器设置中允许相机，或从图片识别。': 'Camera access was denied. Allow it in browser settings, or scan an image.',
  '没有找到可用相机，可以从图片识别二维码。': 'No camera was found. You can scan a QR code image instead.',
  '相机可能被其他应用占用，请关闭后重试，或从图片识别。': 'Another app may be using the camera. Close it and retry, or scan an image.',
  '无法打开相机，请重试或从图片识别。': 'Unable to open the camera. Retry or scan an image.',
  '这个浏览器无法使用相机，请从图片识别或粘贴链接。': 'This browser cannot access a camera. Scan an image or paste the link.',
  '二维码识别暂不可用，请重试或粘贴链接。': 'QR scanning is unavailable. Retry or paste the link.',
  '图片过大，请选择 20 MB 以内的二维码图片。': 'This image is too large. Choose a QR code image under 20 MB.',
  '图片中没有识别到二维码，请使用清晰的二维码图片。': 'No QR code was found. Choose a clearer QR code image.',
  '无法读取这张图片，请选择其他二维码图片。': 'Unable to read this image. Choose another QR code image.',
  '找到发送方，正在交换连接信息': 'Sender found. Exchanging connection details',
  '找到接收方，正在交换连接信息': 'Receiver found. Exchanging connection details',
  '等待发送方回到页面': 'Waiting for the sender to return to the page',
  '配对信息已交换，正在寻找直连路径': 'Paired. Looking for a direct connection',
  '请保持手机在发送页面；VPN 需要允许本地网络和 WebRTC。': 'Keep the sending page visible on your phone. Your VPN must allow local networking and WebRTC.',
  '请让发送方保持页面打开，手机不要锁屏。': 'Keep the sending page open and the phone unlocked.',
  '未能建立直连。请让手机保持在发送页面，并检查 VPN 是否允许本地网络和 WebRTC；可先关闭双方 VPN 再试。': 'Unable to connect directly. Keep the sending page visible and check whether your VPN allows local networking and WebRTC. Try turning off both VPNs first.',
  '分享链接已被另一接收页面占用，请关闭原页面或创建新链接。': 'Another receiving page is using this link. Close that page or create a new link.',
  '分享链接已过期或发送方已结束，请创建新链接。': 'This link has expired or the sender ended the session. Create a new link.',
  '接收方已结束传输，请创建新链接。': 'The receiver ended the transfer. Create a new link.',
  '发送方尚未响应。请让发送方回到网页并保持手机解锁，或创建新链接。': 'The sender has not responded. Return to the sending page and keep the phone unlocked, or create a new link.',
  '配对信息无效': 'Invalid pairing information',
  '文件快传': 'File transfer',
  '网络切换，正在恢复连接': 'Network changed. Reconnecting',
  '已接收的进度会保留，请保持双方页面打开。正在寻找可用的直连路径。': 'Received data is preserved. Keep both pages open while a new direct connection is found.',
  '等待网络恢复': 'Waiting for the network',
  '连接已恢复，继续传输': 'Reconnected. Resuming transfer',
  '从接收方确认的位置继续，完成后仍会校验整个文件。': 'Resuming from the receiver’s confirmed position. The whole file will still be verified on completion.',
  '暂时无法恢复直连，已等待两分钟。请检查双方网络，或重新创建传输。': 'Unable to restore the direct connection after two minutes. Check both networks or start a new transfer.',
  '续传文件列表不一致': 'The file list changed during recovery',
  '续传位置无效': 'Invalid resume position',
  '重复或无效的续传信息': 'Duplicate or invalid resume information',
  '第二片 · v0.2': 'Second slice · v0.2',
  '好东西，直接分享。': 'Good things. Shared directly.',
  '文件送到，': 'Send files.',
  '热乎刚好。': 'Fresh & direct.',
  '不用安装，不用注册。': 'No installs. No sign-ups. ',
  '打开网页，把文件直接送到另一台设备。': 'Open a page. Send files straight to another device.',
  '文件传输': 'File transfer', '传输角色': 'Transfer role',
  '发送文件': 'Send files', '接收文件': 'Receive files', '加密直传': 'Encrypted',
  '把文件放在这里': 'Drop your files here',
  '拖放文件，或点击选择': 'Drag and drop, or click to choose',
  '支持多个文件 · 文件内容不上传到服务器': 'Multiple files · No file uploads to a server',
  '先选一个文件，就可以开始。': 'Choose a file to get started.',
  '创建传输': 'Start sharing',
  '接住这一份分享': 'Receive something good',
  '打开对方发来的分享链接即可连接。': 'Open the sender’s link to connect.',
  '也可以在这里粘贴链接或配对码。': 'Or paste a link or pairing code below.',
  '分享链接或配对码': 'Share link or pairing code',
  '粘贴 PizzaSend 分享链接或 PS1. 配对码': 'Paste a PizzaSend link or PS1. pairing code',
  '连接发送方': 'Connect to sender',
  '选择保存位置并接收': 'Save and receive',
  '等待接收方': 'Waiting for receiver', '结束传输': 'End transfer',
  '传输期间请保持双方页面打开。': 'Keep both pages open during the transfer.',
  '把链接发给对方，或者让对方扫码': 'Share this link, or let the receiver scan the QR code',
  '复制分享链接': 'Copy share link', '显示分享二维码': 'Show share QR code',
  '链接 30 分钟内可配对，仅限一位接收方。请只分享给预期接收者。': 'Pair within 30 minutes. One receiver only. Share with your intended recipient.',
  '传输进度': 'Transfer progress', '已接收': 'Received', '平均速度': 'Average speed', '预计剩余': 'Time remaining',
  '浏览器之间加密传输': 'Encrypted between browsers', 'SHA-256 校验': 'SHA-256 verified',
  '直接送达': 'Direct delivery', '两端连接后，即传即收。': 'Connect both devices and start sending.',
  '加密传输': 'Encrypted transfer', '文件在浏览器之间加密传递。': 'Files travel encrypted between browsers.',
  '原样分享': 'Every byte intact', '保留内容，逐个校验文件。': 'Original content. Every file verified.',
  '开始之前，你可能想知道': 'Before you start',
  '要一直打开页面吗？': 'Should I keep the pages open?',
  '是的。发送和接收期间请保持页面打开，手机尽量不要锁屏。关闭页面会中断传输。': 'Yes. Keep both pages open and avoid locking your phone. Closing a page interrupts the transfer.',
  '大文件能传吗？': 'Can I send large files?',
  '桌面 Chrome / Edge 支持直接保存。支持写盘的 Safari 等浏览器先在本机磁盘暂存，再点击保存；大小取决于设备空间和浏览器额度，保存时可能同时占用两份空间。不支持写盘时仍限制为总计 256 MB。': 'Desktop Chrome / Edge can save directly. Safari and other browsers with disk storage receive into temporary files on this device, then offer Save buttons. Capacity depends on free space and browser quota; saving may use space for two copies. Browsers without disk storage remain limited to 256 MB in total.',
  '所有网络都能连上吗？': 'Will every network connect?',
  '首版使用直连，不提供文件中继。部分移动、公司或受限网络可能无法连接，可以尝试同一 Wi-Fi。': 'This release uses direct connections without a file relay. Some mobile, corporate or restricted networks may not connect. Try the same Wi-Fi.',
  '可以断点续传吗？': 'Can I resume an interrupted transfer?',
  '自动配对支持页面保持打开时断线重连、从已接收位置续传。刷新或关闭页面后不能续传；手动配对暂不支持自动重连。': 'Automatic pairing can reconnect and resume from received bytes while both pages stay open. Refreshing or closing a page loses the session. Manual pairing does not reconnect automatically.',
  '“加密”意味着什么？': 'What does “encrypted” mean?',
  'WebRTC 数据通道使用 DTLS 加密。自动配对信息也在浏览器里加密，配对密钥放在链接片段中。使用网页仍需要信任本站提供的程序代码。': 'WebRTC data channels use DTLS encryption. Automatic pairing information is also encrypted in the browser, with its key in the link fragment. You still need to trust the code served by this site.',
  '连接设置': 'Connection settings', '配对服务地址': 'Pairing service URL', 'STUN 服务地址': 'STUN server URL', '保存设置': 'Save settings',
  '没有配对服务时，可用手动配对码连接。STUN 只帮助建立连接，不中转文件。': 'Use manual pairing codes without a pairing service. STUN helps establish connections; it does not relay files.',
  '🍕 一点披萨精神，一份直接的分享。': '🍕 A little pizza spirit. A direct connection.',
  '受': 'Inspired by', '启发 · 开源制作': '· Open source',
  '手动配对': 'Manual pairing', '关闭配对窗口': 'Close pairing dialog', '配对码': 'Pairing code', '复制配对码': 'Copy code', '二维码': 'QR code',
  '对方返回的应答码': 'Answer code from the receiver',
  '粘贴接收方返回的 PS1. 应答码': 'Paste the receiver’s PS1. answer code', '完成配对': 'Finish pairing',
  '仅交换连接信息，文件仍通过加密直连发送。请只向预期接收者提供配对码。': 'Only connection information is exchanged. Files use an encrypted direct connection. Share codes only with your intended recipient.',
  '已取消选择保存位置': 'Save location selection cancelled',
  '移除 {name}': 'Remove {name}', '待接收': 'Ready to receive',
  '一次最多选择 100 个文件': 'Choose up to 100 files at a time',
  '文件名过长，请缩短后重试': 'The filename is too long. Shorten it and try again.',
  '{count} 个文件 · {size}': '{count} files · {size}',
  '已连接，等待对方确认': 'Connected. Waiting for confirmation', '已连接，准备接收': 'Connected. Ready to receive',
  '请保持双方页面打开。': 'Keep both pages open.',
  '选择保存位置后开始传输。文件会写入磁盘，并在完成时校验。': 'Choose a save location to begin. Files are written to disk and verified on completion.',
  '文件会分块写入本机磁盘，完成后请点击保存。保存时可能同时占用两份空间，下载完成后请清理暂存。': 'Files are written to this device’s disk in chunks. Click Save when finished. Saving may require space for two copies; clear temporary files after the download finishes.',
  '完整文件名': 'Full filename', '关闭文件名窗口': 'Close filename window', '保存': 'Save',
  '本机暂存': 'Temporary files on this device',
  '部分暂存正在另一个页面使用。请关闭该页面后，再清理全部暂存。': 'Some temporary files are in use by another page. Close that page before clearing all temporary files.',
  '暂存文件不可用，可以清理记录': 'Temporary file unavailable; you can clear its record',
  '文件暂存在这台设备的磁盘里，整批接收完成后保留 10 分钟。点击保存会为该文件重新预留 10 分钟；下载完成后，也可以立即清理全部暂存。': 'Files stay on this device for 10 minutes after the batch finishes. Clicking Save gives that file another 10 minutes. You can also clear all temporary files once downloads finish.',
  '到期自动清理。网页关闭或暂停时，下次打开或返回再清理；不会删除已经下载的副本。刷新不会延长保存时间，未完成的传输不能在刷新后续传。浏览器也可能提前回收暂存，请及时保存。': 'Expired files are cleared automatically, or on your next visit if the page is closed or paused. Downloaded copies stay intact. Refreshing does not extend retention or resume unfinished transfers. Your browser may reclaim storage earlier, so save promptly.',
  '本次传输结束后保留 10 分钟': 'Kept for 10 minutes after this transfer ends',
  '约 {minutes} 分钟后清理': 'Cleared in about {minutes} min',
  '暂存占用 {size}': '{size} in temporary storage',
  '已保存，清理全部暂存': 'Saved · clear all temporary files',
  '清理全部暂存？': 'Clear all temporary files?',
  '请确认所有文件已保存，并且浏览器下载已经完成。清理后无法再从本站保存这些暂存；本地下载的副本会保留。': 'Make sure all files have been saved and browser downloads have finished. You cannot save these temporary files again after clearing them. Your downloaded copies will be kept.',
  '保留暂存': 'Keep temporary files', '确认清理': 'Clear temporary files', '正在清理…': 'Clearing…',
  '暂存已清理，本地下载的文件会保留。': 'Temporary files cleared. Your downloaded files are kept.',
  '浏览器暂存空间不足。请清理已保存的暂存文件，或释放设备空间后重试。': 'Browser storage is full. Clear temporary files you have saved, or free device space and retry.',
  '浏览器写盘失败。请检查剩余空间，保持页面打开后重新接收。': 'Writing to disk failed. Check free space, keep the page open, and start receiving again.',
  '浏览器暂存不可用，请刷新页面后重试。': 'Temporary storage is unavailable. Refresh the page and retry.',
  '浏览器写盘进程已停止，请刷新页面后重试。': 'The disk writer stopped. Refresh the page and retry.',
  '浏览器暂存文件大小不一致，请清理后重新接收。': 'The temporary file has an unexpected size. Clear it and receive it again.',
  '浏览器暂存记录无法读取，请在浏览器的网站数据设置中检查。': 'Temporary file records cannot be read. Check this site in your browser’s website data settings.',
  '当前浏览器将文件暂存在内存中，总计最多 {size}。完成后请点击保存。': 'This browser buffers files in memory, up to {size} in total. Click Save when finished.',
  '正在传输': 'Transferring', '请保持页面打开，手机不要锁屏。': 'Keep the pages open and your phone unlocked.',
  '{path} · DTLS 加密': '{path} · DTLS encrypted',
  '{count} 分钟': '{count} min', '{count} 秒': '{count}s', '即将完成': 'Almost done',
  '保存 {name}': 'Save {name}',
  '传输完成，原样送达。': 'Transfer complete. Every byte intact.',
  '接收方已收到并校验全部文件。': 'The receiver has received and verified all files.',
  '全部文件通过 SHA-256 校验；若下方有保存按钮，请点击保存。': 'All files passed SHA-256 verification. If Save buttons appear below, click them to save your files.',
  '完成': 'Done', '开始新的传输': 'Start a new transfer',
  '传输未完成': 'Transfer incomplete', '可以结束这次传输，重新配对后再试。': 'End this transfer and pair again to retry.', '重新开始': 'Start again',
  '配对服务需要 HTTPS 地址': 'The pairing service requires an HTTPS URL',
  '配对地址不能包含凭据或额外参数': 'The pairing URL cannot contain credentials or extra parameters',
  '配对服务已断开，文件直传继续': 'Pairing service disconnected. File transfer continues.',
  '配对服务不可用': 'Pairing service unavailable',
  '可以结束后使用手动配对，或检查连接设置。': 'End this session and use manual pairing, or check the connection settings.',
  '配对服务暂不可用（{code}），请使用手动配对': 'Pairing service unavailable ({code}). Use manual pairing.',
  '配对服务返回信息无效': 'The pairing service returned invalid information',
  '把分享链接发给对方。传输期间请保持本页打开。': 'Send the share link to the receiver. Keep this page open during the transfer.',
  '本站尚未配置自动配对服务，请使用手动配对码': 'Automatic pairing is not configured. Use manual pairing codes.',
  '分享链接不完整': 'The share link is incomplete',
  '请粘贴本站的 PizzaSend 分享链接或 PS1. 配对码': 'Paste a PizzaSend share link from this site or a PS1. pairing code',
  '正在连接发送方': 'Connecting to sender', '确认连接后，会显示对方分享的文件。': 'The shared files will appear once connected.',
  '正在准备配对码': 'Preparing pairing code', '正在收集直连信息，通常需要几秒钟。': 'Gathering connection information. This usually takes a few seconds.',
  '把配对码发给对方。对方在「接收文件」中粘贴后，会得到应答码，再把应答码返回这里。': 'Send this code to the receiver. They paste it under “Receive files” and return their answer code for you to paste below.',
  '发给接收方的配对码': 'Pairing code for the receiver',
  '等待手动配对': 'Waiting for manual pairing', '没有自动配对服务时，双方交换配对码即可直连。': 'Exchange pairing codes to connect without an automatic pairing service.',
  '正在准备应答码': 'Preparing answer code', '正在建立连接信息，通常需要几秒钟。': 'Preparing connection information. This usually takes a few seconds.',
  '把下面的应答码复制给发送方。对方完成配对后，这里会显示文件列表。': 'Copy this answer code to the sender. The file list will appear once they finish pairing.',
  '返回给发送方的应答码': 'Answer code for the sender', '等待发送方完成配对': 'Waiting for sender to finish pairing', '请将应答码返回给发送方。': 'Send the answer code back to the sender.',
  '请粘贴完整的分享链接或 PS1. 配对码': 'Paste a complete share link or PS1. pairing code',
  '请先结束当前传输': 'End the current transfer first',
  '正在创建传输': 'Creating transfer', '正在准备连接，请稍候。': 'Preparing the connection. Please wait.',
  '分享链接已复制': 'Share link copied', '配对码已复制': 'Pairing code copied',
  '请先创建一次发送': 'Start a sharing session first', '正在建立加密直连': 'Establishing encrypted connection', '配对信息已交换，请稍候。': 'Pairing information exchanged. Please wait.',
  '请先结束当前传输，再修改连接设置': 'End the current transfer before changing connection settings',
  '请使用 HTTPS 配对服务地址': 'Use an HTTPS pairing service URL', '请输入有效的 stun: 或 stuns: 地址': 'Enter a valid stun: or stuns: URL',
  '连接设置已保存': 'Connection settings saved',
  '请在支持 WebRTC 的现代浏览器中，通过 HTTPS 打开本站。': 'Open this site over HTTPS in a modern browser that supports WebRTC.',
  '文件列表无效（最多 100 个文件）': 'Invalid file list (up to 100 files)', '文件信息无效': 'Invalid file information', '文件总大小超出支持范围': 'The total file size exceeds the supported range',
  '这不是有效的 PizzaSend 配对码': 'This is not a valid PizzaSend pairing code', '配对信息过大': 'Pairing information is too large', '配对码类型不正确': 'Incorrect pairing code type',
  '连接已中断，请重新创建传输。': 'Connection interrupted. Start a new transfer.', '设备直连': 'Device-to-device', '网络直连': 'Direct network connection',
  '接收队列超出安全限制': 'The receive queue exceeds its safety limit', '对方已结束传输，或页面已关闭。': 'The other device ended the transfer or closed its page.',
  '连接已关闭': 'Connection closed', '对方长时间没有响应，请重新传输': 'The other device is not responding. Start a new transfer.',
  '接收到不符合文件信息的数据': 'Received data does not match the file information', '控制信息过大': 'Control message is too large', '重复的下载请求': 'Duplicate download request',
  '接收确认信息无效': 'Invalid receipt acknowledgement', '文件顺序无效': 'Invalid file order', '文件完整性校验失败，请重新传输': 'File integrity check failed. Send the file again.',
  '文件保存确认无效': 'Invalid save acknowledgement', '文件传输未完整结束': 'The file transfer has not finished', '文件尚未保存完整': 'Files have not been fully saved', '对方已取消传输。': 'The other device cancelled the transfer.', '收到不支持的传输消息': 'Unsupported transfer message',
  '这个浏览器暂不支持大文件流式保存。请使用桌面 Chrome 或 Edge；当前接收上限为 {size}': 'This browser cannot stream large files to disk. Use desktop Chrome or Edge. The current receive limit is {size}.',
  '对方浏览器的数据通道限制过小': 'The other browser’s data channel limit is too small',
  '配对服务连接超时': 'Pairing service connection timed out', '无法连接配对服务': 'Unable to connect to the pairing service',
  '重复或无效的配对消息': 'Duplicate or invalid pairing message', '配对服务已断开；已建立的文件直连可以继续': 'Pairing service disconnected. An established direct transfer can continue.', '配对服务已断开': 'Pairing service disconnected'
};
let language: Language = 'zh';
try { if (localStorage.getItem('pizza-send-language') === 'en') language = 'en'; } catch {}
const fill = (value: string, params: Params) => value.replace(/\{(\w+)\}/g, (match, key) => String(key === 'path' && typeof params[key] === 'string' ? t(params[key]) : params[key] ?? match));
const patterns = Object.entries(messages).filter(([key]) => key.includes('{')).map(([key, value]) => {
  const names: string[] = [];
  const pattern = key.split(/(\{\w+\})/g).map(part => {
    if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '(.+?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { expression: new RegExp('^' + pattern + '$'), names, value };
});
export function t(key: string, params: Params = {}): string {
  if (language === 'zh') return fill(key, params);
  if (messages[key]) return fill(params.count === 1 ? messages[key].replace('{count} files', '{count} file') : messages[key], params);
  for (const pattern of patterns) {
    const match = key.match(pattern.expression);
    if (match) return fill(pattern.value, Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 1]])));
  }
  return key;
}
export function setText(element: HTMLElement, key: string, params: Params = {}) {
  element.dataset.i18nText = key;
  element.dataset.i18nParams = JSON.stringify(params);
  element.textContent = t(key, params);
}
const staticText: { node: Text; key: string; prefix: string; suffix: string }[] = [];
const staticAttributes: { element: Element; name: string; key: string }[] = [];
export function registerStatic(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.data, key = text.trim();
    if (messages[key]) staticText.push({ node, key, prefix: text.slice(0, text.indexOf(key)), suffix: text.slice(text.indexOf(key) + key.length) });
  }
  for (const element of root.querySelectorAll('*')) for (const name of ['aria-label', 'placeholder', 'title']) {
    const key = element.getAttribute(name);
    if (key && messages[key]) staticAttributes.push({ element, name, key });
  }
  refreshLanguage();
}
function refreshLanguage() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.documentElement.classList.toggle('lang-en', language === 'en');
  document.title = language === 'zh' ? 'PizzaSend · 文件快传' : 'PizzaSend · File transfer';
  document.querySelector('meta[name="description"]')?.setAttribute('content', language === 'zh' ? 'PizzaSend 文件快传：免安装、免注册，浏览器之间加密直传文件。' : 'PizzaSend: encrypted file transfers between browsers. No installs. No sign-ups.');
  for (const { node, key, prefix, suffix } of staticText) if (node.isConnected) node.data = prefix + t(key) + suffix;
  for (const { element, name, key } of staticAttributes) if (element.isConnected) element.setAttribute(name, t(key));
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-text]')) element.textContent = t(element.dataset.i18nText!, JSON.parse(element.dataset.i18nParams || '{}'));
  const button = document.getElementById('language-toggle');
  button?.setAttribute('aria-label', language === 'zh' ? '切换为 English' : 'Switch to Chinese');
  button?.setAttribute('title', language === 'zh' ? '切换为 English' : 'Switch to Chinese');
  button?.querySelector('[data-language="zh"]')?.classList.toggle('selected', language === 'zh');
  button?.querySelector('[data-language="en"]')?.classList.toggle('selected', language === 'en');
}
export function toggleLanguage() {
  language = language === 'zh' ? 'en' : 'zh';
  try { localStorage.setItem('pizza-send-language', language); } catch {}
  refreshLanguage();
}

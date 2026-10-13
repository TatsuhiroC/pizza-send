import QRCode from 'qrcode';
import { shareFragment } from './share';

// Development-only entry: exercise the actual app handlers using public fixtures.
// Neither this page nor its simulated camera/network is included in dist.
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname.startsWith('/rooms')) {
    await new Promise(resolve => setTimeout(resolve, 30000));
    return new Response(JSON.stringify({ error: '本地演示已结束，没有连接真实发送方。' }), { status: 503 });
  }
  return originalFetch(input, init);
};
navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Preview uses a QR image', 'NotAllowedError'); };
await import('./main');
const toolbar = document.createElement('aside');
toolbar.className = 'interface-preview-tools';
toolbar.innerHTML = '<span>本地交互演示 · 不会实际传输</span><div><button id="preview-name" type="button">长文件名浮层</button><button id="preview-scan" type="button">扫码成功过渡</button><button id="preview-reset" type="button">重置演示</button></div>';
document.body.append(toolbar);
const style = document.createElement('style');
style.textContent = '.interface-preview-tools{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:80;max-width:calc(100vw - 24px);width:max-content;padding:10px 12px;border:1px solid #dfd3c0;border-radius:14px;background:#fffcf1ed;box-shadow:0 8px 30px #342c241f;font-size:11px;text-align:center;color:#8e7d68}.interface-preview-tools div{display:flex;gap:8px;margin-top:8px}.interface-preview-tools button{padding:9px 12px;border-radius:9px;background:#f3e5d1;color:#5c4b37;font-size:11px}.interface-preview-tools button:disabled{opacity:.5}';
document.head.append(style);
function fixture(input: HTMLInputElement, file: File) {
  const data = new DataTransfer(); data.items.add(file); input.files = data.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
document.getElementById('preview-name')!.onclick = () => {
  document.getElementById('send-tab')!.click();
  fixture(document.getElementById('file-input') as HTMLInputElement, new File(['Public interface fixture'], '假日照片_和朋友一起去海边看日落_完整文件名称展示测试_2026年夏天的旅行记录.jpg', { type: 'image/jpeg' }));
  document.querySelector<HTMLButtonElement>('#files .filename-button')!.click();
};
document.getElementById('preview-scan')!.onclick = async () => {
  const button = document.getElementById('preview-scan') as HTMLButtonElement; button.disabled = true;
  try {
    const url = new URL(location.href); url.hash = shareFragment('11'.repeat(32));
    const blob = await (await originalFetch(await QRCode.toDataURL(url.href, { width: 480, margin: 4 }))).blob();
    document.getElementById('receive-tab')!.click(); document.getElementById('open-scanner')!.click();
    fixture(document.getElementById('qr-image-input') as HTMLInputElement, new File([blob], 'share.png', { type: 'image/png' }));
  } finally { button.disabled = false; }
};
document.getElementById('preview-reset')!.onclick = () => location.reload();

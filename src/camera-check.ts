import { CameraScanner } from './scanner';
import { cameraProbe } from './camera-probe';
import './camera-check.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = element<HTMLVideoElement>('scan-video'), report = element<HTMLPreElement>('camera-report');
const start = element<HTMLButtonElement>('open-scanner'), stop = element<HTMLButtonElement>('close-scanner');
const copy = element<HTMLButtonElement>('copy-report'), status = element<HTMLParagraphElement>('camera-status');
const update = cameraProbe(video, report);
const scanner = new CameraScanner(video, async () => false, message => {
  status.textContent = message; start.disabled = false; stop.disabled = true;
}, info => { update(info); copy.disabled = false; });
let revision = 0;
start.disabled = false;
start.onclick = async () => {
  const current = ++revision;
  start.disabled = true; stop.disabled = false;
  status.textContent = '正在打开相机，请允许访问。';
  await scanner.start();
  if (current !== revision) return;
  start.disabled = !!video.srcObject; stop.disabled = !video.srcObject;
};
video.addEventListener('playing', () => {
  if (video.srcObject) status.textContent = '请保持手机不动，观察两幅画面是否一起突然放大；然后点“复制诊断文字”。';
});
function stopCamera(message: string) {
  revision++; scanner.stop(); start.disabled = false; stop.disabled = true; status.textContent = message;
}
stop.onclick = () => stopCamera('相机已停止，可以重新打开对照。');
copy.onclick = async () => {
  try { await navigator.clipboard.writeText(report.textContent || ''); copy.textContent = '诊断文字已复制'; }
  catch { status.textContent = '无法自动复制，请长按下方诊断文字进行复制。'; }
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera('页面已切到后台，相机已停止。返回后请重新打开对照。');
});
window.addEventListener('pagehide', () => stopCamera('相机已停止。'));

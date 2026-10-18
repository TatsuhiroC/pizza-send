import type { CameraInfo } from './scanner';
import { setText, t } from './i18n';

// Imported only by the opt-in camera comparison. No image buffers are logged,
// persisted or uploaded. Both views use the same video stream, at the same time.
export function cameraProbe(video: HTMLVideoElement, report: HTMLPreElement) {
  const frame = video.closest<HTMLElement>('.scan-frame')!;
  frame.classList.add('camera-comparison');
  const reference = document.createElement('canvas'); reference.id = 'camera-reference'; reference.setAttribute('aria-label', t('原始帧对照'));
  for (const [text, side] of [['浏览器画面', 'native'], ['原始帧对照', 'reference']]) {
    const label = document.createElement('span'); label.className = 'camera-view-label ' + side; setText(label, text); frame.append(label);
  }
  frame.append(reference);
  const explanation = document.createElement('p'); explanation.className = 'subtle';
  setText(explanation, '两边来自同一个镜头。请观察：两边都放大，还是只有左边放大？画面仅在本机处理。');
  frame.after(explanation);
  let info: CameraInfo | undefined, tick = 0, started = 0, lastSample = -Infinity, lastDraw = -Infinity;
  let samples: Record<string, unknown>[] = [], available: string[] = [], capabilities: Record<string, unknown> = {}, last = '';
  const keys = ['width', 'height', 'aspectRatio', 'frameRate', 'resizeMode', 'facingMode', 'zoom', 'focusMode', 'focusDistance'] as const;
  const selected = (value: object) => Object.fromEntries(keys.flatMap(key => {
    const item = (value as Record<string, unknown>)[key];
    return item === undefined ? [] : [[key, item]];
  }));
  const render = () => {
    report.textContent = JSON.stringify({ ...info, comparison: { available, capabilities, samples } }, null, 2);
  };
  const reset = () => {
    cancelAnimationFrame(tick); tick = 0;
    reference.width = reference.height = 0;
  };
  const sample = (now: number) => {
    const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (!track) return;
    // Keep only explicitly allow-listed settings. Never expose device/group IDs.
    const settings = selected(track.getSettings());
    const rect = video.getBoundingClientRect(), style = getComputedStyle(video);
    const values = { settings, video: { width: video.videoWidth, height: video.videoHeight },
      layout: { width: Math.round(rect.width), height: Math.round(rect.height), objectFit: style.objectFit, transform: style.transform },
      muted: track.muted, state: track.readyState };
    const serialized = JSON.stringify(values);
    if (serialized !== last && samples.length < 40) {
      samples.push({ milliseconds: Math.round(now - started), ...values }); last = serialized; render();
    }
  };
  const draw = (now: number) => {
    if (video.paused || !video.srcObject || !video.closest('dialog')?.open) { reset(); return; }
    if (now - lastSample >= 250) { sample(now); lastSample = now; }
    if (now - lastDraw >= 66 && video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
      if (reference.width !== width || reference.height !== height) { reference.width = width; reference.height = height; }
      try { reference.getContext('2d')?.drawImage(video, 0, 0, width, height); }
      catch { /* A frame can become unavailable during a track transition. */ }
      lastDraw = now;
    }
    tick = requestAnimationFrame(draw);
  };
  video.addEventListener('playing', () => {
    if (tick) return;
    started = performance.now(); lastSample = lastDraw = -Infinity; samples = []; available = []; capabilities = {}; last = '';
    const stream = video.srcObject as MediaStream | null, track = stream?.getVideoTracks()[0];
    try { capabilities = selected(track?.getCapabilities?.() || {}); } catch { /* Optional API. */ }
    void navigator.mediaDevices.enumerateDevices?.().then(devices => {
      if (video.srcObject !== stream) return;
      available = devices.filter(device => device.kind === 'videoinput').map(device => device.label); render();
    }).catch(() => {});
    sample(started); tick = requestAnimationFrame(draw);
  });
  video.addEventListener('pause', reset); video.addEventListener('emptied', reset);
  return (value: CameraInfo) => { info = value; render(); };
}

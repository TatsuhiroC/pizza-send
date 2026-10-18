import type { CameraPreview } from './camera-preview';
import { cameraConstraints, fixedRearCamera, rearConstraints } from './camera-choice';

type Decoder = typeof import('jsqr').default;
let decoder: Promise<Decoder> | undefined;
const loadDecoder = () => decoder ||= import('jsqr').then(module => module.default);

export function cameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '未获得相机权限，请在浏览器设置中允许相机，或从图片识别。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用相机，可以从图片识别二维码。';
  if (name === 'NotReadableError') return '相机可能被其他应用占用，请关闭后重试，或从图片识别。';
  return '无法打开相机，请重试或从图片识别。';
}

export class CameraScanner {
  private generation = 0;
  private active = false;
  private playback?: AbortController;
  private stream?: MediaStream;
  private rearCamera?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private canvas = document.createElement('canvas');
  constructor(private video: HTMLVideoElement, private found: (text: string) => Promise<boolean>, private error: (text: string) => void, private livePreview?: CameraPreview) {}
  stop() {
    this.active = false; this.generation++; clearTimeout(this.timer);
    this.playback?.abort(); this.playback = undefined;
    this.livePreview?.stop();
    delete this.video.dataset.ready;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    this.video.pause(); this.video.srcObject = null;
  }
  async start() {
    // A second click while permission/playback is pending must not reopen the camera.
    if (this.active) return;
    this.stop(); this.active = true;
    const generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia) { this.stop(); this.error('这个浏览器无法使用相机，请从图片识别或粘贴链接。'); return; }
    try {
      const devices = navigator.mediaDevices;
      const video = await cameraConstraints(devices, this.rearCamera);
      if (generation !== this.generation) return;
      let stream = await devices.getUserMedia({ audio: false, video });
      // Permission may finish after the user has closed the dialog.
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const pinned = typeof video.deviceId === 'object' && !Array.isArray(video.deviceId) ? video.deviceId.exact : undefined;
      if (typeof pinned === 'string') this.rearCamera = pinned;
      else if (devices.enumerateDevices) {
        // Safari may expose no labels until capture is authorized. The old
        // pre-permission-only lookup left its virtual/macro camera in use.
        // Resolve a named ordinary rear camera BEFORE attaching any preview.
        let rear: string | undefined;
        try { rear = fixedRearCamera(await devices.enumerateDevices()); } catch { /* Keep the only available camera. */ }
        if (generation !== this.generation) return;
        if (rear) {
          const current = stream.getVideoTracks?.()[0]?.getSettings?.().deviceId;
          if (current !== rear) {
            stream.getTracks().forEach(track => track.stop()); this.stream = undefined;
            stream = await devices.getUserMedia({ audio: false, video: rearConstraints(devices, rear) });
            if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
            this.stream = stream;
          }
          this.rearCamera = rear;
        }
      }
      if (generation !== this.generation) return;
      this.video.muted = true; this.video.playsInline = true;
      const playback = this.playback = new AbortController();
      const ready = () => {
        if (generation === this.generation && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) this.video.dataset.ready = 'true';
      };
      // Both display paths start before downloading/initializing jsQR.
      // Frame rendering reads this same stream, without a settling delay.
      this.video.addEventListener('loadeddata', ready, { signal: playback.signal });
      this.video.addEventListener('playing', ready, { signal: playback.signal });
      this.video.srcObject = stream; this.livePreview?.start();
      await this.video.play(); ready();
      if (generation !== this.generation) return;
      const decode = await loadDecoder();
      const frame = async () => {
        if (generation !== this.generation) return;
        try {
          if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.videoWidth) {
            this.video.dataset.ready = 'true';
            const scale = Math.min(1, 640 / Math.max(this.video.videoWidth, this.video.videoHeight));
            const width = Math.round(this.video.videoWidth * scale), height = Math.round(this.video.videoHeight * scale);
            if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
            const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
            const image = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            const result = decode(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
            if (result && await this.found(result.data)) {
              // Recognition may finish after cancellation and a new camera start.
              if (generation === this.generation) this.stop();
              return;
            }
          }
          if (generation === this.generation) this.timer = setTimeout(frame, 200);
        } catch {
          if (generation === this.generation) { this.stop(); this.error('二维码识别暂不可用，请重试或粘贴链接。'); }
        }
      };
      await frame();
    } catch (error) {
      if (generation === this.generation) { this.stop(); this.error(cameraError(error)); }
    }
  }
  async readImage(file: File): Promise<string> {
    if (file.size > 20 * 1048576) throw Error('图片过大，请选择 20 MB 以内的二维码图片。');
    const url = URL.createObjectURL(file), image = new Image();
    try {
      image.src = url; await image.decode();
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = (await loadDecoder())(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
      if (!result) throw Error('图片中没有识别到二维码，请使用清晰的二维码图片。');
      return result.data;
    } catch (error) {
      if (error instanceof Error && !(error instanceof DOMException)) throw error;
      throw Error('无法读取这张图片，请选择其他二维码图片。');
    } finally { URL.revokeObjectURL(url); }
  }
}

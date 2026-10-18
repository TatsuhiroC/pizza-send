// iOS/iPadOS WebKit can mis-size the native video layer at camera startup.
// Keep capture and decoding on the same video; display its complete frames.
export function needsFramePreview(agent = navigator.userAgent, platform = navigator.platform, touches = navigator.maxTouchPoints): boolean {
  return /AppleWebKit/i.test(agent) && (/iPhone|iPad|iPod/i.test(agent) || platform === 'MacIntel' && touches > 1);
}

export class CameraPreview {
  private generation = 0;
  private tick?: number;
  private events?: AbortController;
  constructor(private video: HTMLVideoElement, private canvas: HTMLCanvasElement) {}
  stop() {
    this.generation++;
    if (this.tick !== undefined) cancelAnimationFrame(this.tick);
    this.tick = undefined; this.events?.abort(); this.events = undefined;
    this.canvas.hidden = true; this.canvas.width = this.canvas.height = 0;
    delete this.canvas.dataset.ready;
    this.video.removeAttribute('aria-hidden');
  }
  start() {
    this.stop();
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw Error('Camera frame rendering unavailable');
    const generation = this.generation, stream = this.video.srcObject;
    const events = this.events = new AbortController();
    let last = -Infinity;
    this.canvas.hidden = false; this.video.setAttribute('aria-hidden', 'true');
    const paint = (now: number, force = false) => {
      if (generation !== this.generation || this.video.srcObject !== stream || this.video.paused) return;
      if (!force && now - last < 1000 / 30 - 1) return;
      if (this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight) return;
      const scale = Math.min(1, 960 / Math.max(this.video.videoWidth, this.video.videoHeight));
      const width = Math.round(this.video.videoWidth * scale), height = Math.round(this.video.videoHeight * scale);
      if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
      try {
        context.drawImage(this.video, 0, 0, width, height);
        this.canvas.dataset.ready = 'true'; last = now;
      } catch { /* A frame can become unavailable during an orientation change. */ }
    };
    const frame = (now: number) => {
      if (generation !== this.generation || this.video.srcObject !== stream) return;
      paint(now); this.tick = requestAnimationFrame(frame);
    };
    const available = () => paint(performance.now(), true);
    this.video.addEventListener('loadeddata', available, { signal: events.signal });
    this.video.addEventListener('playing', available, { signal: events.signal });
    this.video.addEventListener('resize', available, { signal: events.signal });
    // No settling timer or opacity transition: paint the first available frame.
    available(); this.tick = requestAnimationFrame(frame);
  }
}

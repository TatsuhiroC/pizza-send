import { test, expect } from '@playwright/test';
import QRCode from 'qrcode';
import { CameraScanner } from '../src/scanner';

test('a late accepted QR result cannot stop a newer camera session', async () => {
  // Exercise the real decoder and scanner lifecycle with synthetic QR pixels.
  // No camera permission, real media device or browser UI is used here.
  const qr = QRCode.create('public-scanner-lifecycle-fixture'), scale = 6, margin = 4;
  const width = (qr.modules.size + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / scale) - margin, column = Math.floor(x / scale) - margin;
    if (row >= 0 && column >= 0 && row < qr.modules.size && column < qr.modules.size && qr.modules.get(row, column)) {
      const at = (y * width + x) * 4; pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
    }
  }
  const descriptors = new Map(['document', 'navigator', 'HTMLMediaElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const tracks: { stopped: number; stop(): void }[] = [];
  const errors: string[] = [];
  let accepted!: (value: boolean) => void, detected!: () => void, calls = 0;
  const pending = new Promise<boolean>(resolve => { accepted = resolve; });
  const firstDetected = new Promise<void>(resolve => { detected = resolve; });
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels, width, height: width }) }) };
  const video = { readyState: 2, videoWidth: width, videoHeight: width, muted: false, playsInline: false, srcObject: null,
    play: async () => {}, pause() {} } as unknown as HTMLVideoElement;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  Object.defineProperty(globalThis, 'HTMLMediaElement', { configurable: true, value: { HAVE_CURRENT_DATA: 2 } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
    const track = { stopped: 0, stop() { this.stopped++; } }; tracks.push(track);
    return { getTracks: () => [track] };
  } } } });
  const scanner = new CameraScanner(video, async value => {
    expect(value).toBe('public-scanner-lifecycle-fixture');
    if (++calls === 1) { detected(); return pending; }
    return false;
  }, message => errors.push(message));
  try {
    const oldScan = scanner.start();
    await firstDetected;
    // The app stops the old camera after recognizing the QR, then the user
    // cancels its pending connection and opens the scanner again.
    scanner.stop();
    await scanner.start();
    expect(tracks).toHaveLength(2); expect(tracks[0].stopped).toBe(1);
    accepted(true); await oldScan;
    expect(tracks[1].stopped).toBe(0);
    expect(video.srcObject).not.toBeNull(); expect(errors).toEqual([]);
    scanner.stop(); expect(tracks[1].stopped).toBe(1);
  } finally {
    accepted(false); scanner.stop();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

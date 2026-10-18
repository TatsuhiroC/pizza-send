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
  const video = { dataset: {}, readyState: 2, videoWidth: width, videoHeight: width, muted: false, playsInline: false, srcObject: null,
    play: async () => {}, pause() {}, addEventListener() {} } as unknown as HTMLVideoElement;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const lens = (label: string, deviceId: string) => ({ kind: 'videoinput', label, deviceId }) as MediaDeviceInfo;
const hiddenLenses = [lens('', 'virtual'), lens('', 'wide')];
const visibleLenses = [lens('Back Triple Camera', 'virtual'), lens('Front Camera', 'front'), lens('Back Camera', 'wide')];
function capture(id: string, label = id) {
  const track = { label, stopped: 0, stop() { this.stopped++; }, getSettings: () => ({ deviceId: id }) };
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}
function scannerHarness(devices: Partial<MediaDevices>) {
  const descriptors = new Map(['document', 'navigator', 'HTMLMediaElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({}) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: devices } });
  Object.defineProperty(globalThis, 'HTMLMediaElement', { configurable: true, value: { HAVE_CURRENT_DATA: 2 } });
  const attached: MediaStream[] = [], errors: string[] = [];
  let source: MediaStream | null = null;
  const video = { dataset: {}, readyState: 0, videoWidth: 0, videoHeight: 0,
    get srcObject() { return source; }, set srcObject(value: MediaStream | null) { source = value; if (value) attached.push(value); },
    play: async () => {}, pause() {}, addEventListener() {} } as unknown as HTMLVideoElement;
  const scanner = new CameraScanner(video, async () => false, text => errors.push(text));
  return { scanner, video, attached, errors, restore() {
    scanner.stop();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

test('first permission resolves the physical rear lens before attaching one preview and remembers it only in the scanner', async () => {
  let enumerations = 0;
  const initial = capture('virtual', 'Back Triple Camera'), physical = capture('wide', 'Back Camera'), reopened = capture('wide', 'Back Camera');
  const requests: MediaStreamConstraints[] = [], order: string[] = [];
  const originalStop = initial.track.stop.bind(initial.track);
  initial.track.stop = () => { order.push('stop provisional'); originalStop(); };
  const h = scannerHarness({
    enumerateDevices: async () => ++enumerations === 2 ? visibleLenses : hiddenLenses,
    getUserMedia: async options => {
      requests.push(options!); order.push('capture ' + requests.length);
      return [initial.stream, physical.stream, reopened.stream][requests.length - 1];
    }
  });
  try {
    await h.scanner.start();
    expect(order).toEqual(['capture 1', 'stop provisional', 'capture 2']);
    expect(requests).toEqual([{ audio: false, video: { facingMode: { ideal: 'environment' } } }, { audio: false, video: { deviceId: { exact: 'wide' } } }]);
    expect(h.attached).toEqual([physical.stream]); expect(initial.track.stopped).toBe(1); expect(physical.track.stopped).toBe(0);
    await h.scanner.start(); expect(requests).toHaveLength(2); // Duplicate click cannot re-open.
    h.scanner.stop(); await h.scanner.start();
    expect(requests[2]).toEqual({ audio: false, video: { deviceId: { exact: 'wide' } } });
    expect(enumerations).toBe(3); expect(h.attached).toEqual([physical.stream, reopened.stream]); expect(h.errors).toEqual([]);
    h.scanner.stop(); expect(reopened.track.stopped).toBe(1);
  } finally { h.restore(); }
});

for (const kind of ['already physical', 'enumeration unavailable'] as const) test(`post-permission lookup keeps the original stream when ${kind}`, async () => {
  const original = capture('wide', 'Back Camera'); let enumerations = 0, calls = 0;
  const h = scannerHarness({
    enumerateDevices: async () => {
      if (++enumerations === 1) return hiddenLenses;
      if (kind === 'enumeration unavailable') throw Error('Unavailable');
      return visibleLenses;
    },
    getUserMedia: async () => { calls++; return original.stream; }
  });
  try {
    await h.scanner.start(); expect(calls).toBe(1); expect(h.attached).toEqual([original.stream]);
    expect(h.errors).toEqual([]);
  } finally { h.restore(); }
});

test('cancel during post-permission enumeration stops provisional capture immediately and cannot reopen it', async () => {
  const lookup = deferred<MediaDeviceInfo[]>(), entered = deferred<void>(), original = capture('virtual'); let enumerations = 0, calls = 0;
  const h = scannerHarness({
    enumerateDevices: async () => { if (++enumerations === 1) return hiddenLenses; entered.resolve(); return lookup.promise; },
    getUserMedia: async () => { calls++; return original.stream; }
  });
  try {
    const opening = h.scanner.start(); await entered.promise; h.scanner.stop();
    expect(original.track.stopped).toBe(1); expect(h.video.srcObject).toBeNull();
    lookup.resolve(visibleLenses); await opening;
    expect(calls).toBe(1); expect(h.attached).toEqual([]); expect(h.errors).toEqual([]);
  } finally { lookup.resolve([]); h.restore(); }
});

test('late physical capture after cancellation is stopped without detaching the new scanner session', async () => {
  const pending = deferred<MediaStream>(), entered = deferred<void>();
  const original = capture('virtual'), late = capture('wide'), current = capture('wide'); let enumerations = 0, calls = 0;
  const h = scannerHarness({
    enumerateDevices: async () => ++enumerations === 1 ? hiddenLenses : visibleLenses,
    getUserMedia: async () => {
      calls++; if (calls === 1) return original.stream;
      if (calls === 2) { entered.resolve(); return pending.promise; }
      return current.stream;
    }
  });
  try {
    const old = h.scanner.start(); await entered.promise; h.scanner.stop(); await h.scanner.start();
    pending.resolve(late.stream); await old;
    expect(original.track.stopped).toBe(1); expect(late.track.stopped).toBe(1); expect(current.track.stopped).toBe(0);
    expect(h.attached).toEqual([current.stream]); expect(h.video.srcObject).toBe(current.stream); expect(h.errors).toEqual([]);
  } finally { pending.resolve(late.stream); h.restore(); }
});

test('denied permission never triggers discovery or another capture request', async () => {
  let enumerations = 0, calls = 0;
  const h = scannerHarness({
    enumerateDevices: async () => { enumerations++; return hiddenLenses; },
    getUserMedia: async () => { calls++; throw new DOMException('Denied', 'NotAllowedError'); }
  });
  try {
    await h.scanner.start(); expect(enumerations).toBe(1); expect(calls).toBe(1); expect(h.attached).toEqual([]);
    expect(h.errors).toHaveLength(1); expect(h.errors[0]).toContain('未获得相机权限');
  } finally { h.restore(); }
});

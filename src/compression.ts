import { readSource } from './source-files';

export const COMPRESSION = 'gzip-block-v1';
export const BLOCK_BYTES = 256 * 1024;
export const SAMPLE_BYTES = 32 * 1024;
export const SLOW_BYTES_PER_SECOND = 1024 * 1024;
export type CompressionOffer = { file: number; savedSeconds: number; percent: number };
export type CompressionStatus = { active: boolean; offer?: CompressionOffer };
export type CompressionSample = { ratio: number; compressBps: number; encoded: ArrayBuffer };
export function supportsCompression() {
  try { new CompressionStream('gzip'); new DecompressionStream('gzip'); return true; } catch { return false; }
}

// Never collect an unbounded decompressed body, even from an authenticated peer.
export async function gunzip(data: ArrayBuffer, expected: number): Promise<ArrayBuffer> {
  if (!Number.isInteger(expected) || expected < 1 || expected > BLOCK_BYTES || data.byteLength > BLOCK_BYTES) throw Error('压缩数据无效');
  // Small input pulls also limit the native decoder's per-input expansion burst.
  // A forged gzip trailer must not make us hand a large body to the decoder at once.
  const input = new Uint8Array(data); let position = 0;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
    if (position === input.length) controller.close();
    else { const end = Math.min(position + 1024, input.length); controller.enqueue(input.subarray(position, end)); position = end; }
  } });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const output = new Uint8Array(expected); let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expected) throw Error('压缩数据超出安全限制');
      output.set(value, offset); offset += value.byteLength;
    }
    if (offset !== expected) throw Error('压缩数据长度不一致');
    return output.buffer;
  } finally { await reader.cancel().catch(() => {}); }
}
export async function gzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  if (!data.byteLength || data.byteLength > BLOCK_BYTES) throw Error('压缩数据无效');
  return new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

// Three separate samples avoid recommending compression based only on an easy
// header or a zero-filled prefix. Keep the least favorable measured result.
export async function sampleCompression(file: File, offset: number, signal?: AbortSignal): Promise<CompressionSample | undefined> {
  if (file.size - offset < 8 * 1048576) return;
  const starts = [offset, Math.floor((offset + file.size - SAMPLE_BYTES) / 2), file.size - SAMPLE_BYTES];
  let ratio = 0, compressBps = Infinity, encoded = new ArrayBuffer(0);
  for (const start of starts) {
    const raw = await readSource(file, start, start + SAMPLE_BYTES, undefined, { signal });
    const at = performance.now(), compressed = await gzip(raw);
    compressBps = Math.min(compressBps, SAMPLE_BYTES * 1000 / Math.max(1, performance.now() - at));
    const fraction = compressed.byteLength / SAMPLE_BYTES;
    if (fraction >= .85) return;
    if (fraction >= ratio) { ratio = fraction; encoded = compressed; }
  }
  return { ratio, compressBps, encoded };
}

export function compressionEstimate(remaining: number, speed: number, ratio: number, compressBps: number, decompressBps: number, basePerByte = 0) {
  if (![remaining, speed, ratio, compressBps, decompressBps].every(n => Number.isFinite(n) && n > 0) || ratio >= .85 || !Number.isFinite(basePerByte) || basePerByte < 0 || basePerByte >= 1 / speed) return;
  // Add five percentage points to the worst sample's ratio, 25% CPU headroom
  // and one second of switching overhead. Assume no overlap to stay conservative.
  const fraction = ratio + .05;
  const cpuPerByte = 1.25 * (1 / compressBps + 1 / decompressBps);
  const plainSeconds = remaining / speed;
  // Source reads/hashing and restored-byte hashing/writes do not shrink with
  // gzip. Subtract that observed work from the effective link's savings budget.
  const extraPerByte = cpuPerByte + (1 - fraction) * basePerByte;
  const compressedSeconds = fraction * remaining / speed + remaining * extraPerByte + 1;
  const savedSeconds = plainSeconds - compressedSeconds;
  const threshold = Math.min(SLOW_BYTES_PER_SECOND, (1 - fraction) / (extraPerByte + 6 / remaining), (.8 - fraction) / (extraPerByte + 1 / remaining));
  if (speed > SLOW_BYTES_PER_SECOND || remaining < 8 * 1048576 || savedSeconds < 5 || savedSeconds < plainSeconds * .2) return;
  return { savedSeconds, percent: Math.floor(savedSeconds / plainSeconds * 100), threshold };
}

// A recent confirmed-byte window, not the lifetime average shown in the UI.
// Reset around recovery/background changes; a stall alone cannot trigger a hint.
export class SlowLink {
  private points: { at: number; bytes: number }[] = [];
  private latest?: { at: number; bytes: number };
  private bucketAt = 0;
  reset(bytes: number, now = performance.now()) { this.latest = { at: now, bytes }; this.points = [this.latest]; this.bucketAt = now; }
  observe(bytes: number, now = performance.now()) {
    const last = this.latest;
    if (!last || bytes < last.bytes || now - last.at > 120000) { this.reset(bytes, now); return; }
    if (bytes <= last.bytes) return;
    this.latest = { at: now, bytes };
    if (now - this.bucketAt >= 250) { this.points.push(this.latest); this.bucketAt = now; }
    else if (this.points.length > 1) this.points[this.points.length - 1] = this.latest;
    // Retain three real receipts on very slow links even if they span >12 sec.
    while (this.points.length > 4 && this.points[1].at < now - 12000) this.points.shift();
  }
  speed(now = performance.now()) {
    const first = this.points[0], last = this.latest;
    if (!first || !last || this.points.length < 4 || last.at - first.at < 8000 || now - last.at > 120000) return;
    // Smooth batched receipts over >=2 sec, rather than mistaking a millisecond
    // burst for a fast link. Also reject an average hiding a recent recovery.
    let recent = first;
    for (const point of this.points) { if (point.at <= last.at - 2000) recent = point; else break; }
    if ((last.bytes - recent.bytes) * 1000 / Math.max(1, last.at - recent.at) > SLOW_BYTES_PER_SECOND) return;
    const speed = (last.bytes - first.bytes) * 1000 / (last.at - first.at);
    return speed > 0 && speed <= SLOW_BYTES_PER_SECOND ? speed : undefined;
  }
}

// This envelope is inside the authenticated ciphertext. Exact record lengths
// preserve compressed tails, empty records and the original file protocol.
export const STREAM_BATCH_BYTES = 128 * 1024;
export const STREAM_BATCH_RECORDS = 8;
export const STREAM_RECORD_BYTES = 65536;
export const STREAM_BATCH_DELAY_MS = 4;
const MAGIC = 0x50534231; // PSB1
const PREFIX_BYTES = 8;

export function encodeStreamBatch(parts: ArrayBuffer[]): ArrayBuffer {
  if (!parts.length || parts.length > STREAM_BATCH_RECORDS ||
      parts.some(part => !(part instanceof ArrayBuffer) || part.byteLength > STREAM_RECORD_BYTES)) throw Error('Invalid stream batch');
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (size > STREAM_BATCH_BYTES) throw Error('Invalid stream batch');
  const bytes = new Uint8Array(PREFIX_BYTES + parts.length * 4 + size), view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC); view.setUint16(4, parts.length);
  let at = PREFIX_BYTES + parts.length * 4;
  parts.forEach((part, index) => {
    view.setUint32(PREFIX_BYTES + index * 4, part.byteLength);
    bytes.set(new Uint8Array(part), at); at += part.byteLength;
  });
  return bytes.buffer;
}

export function decodeStreamBatch(frame: ArrayBuffer): ArrayBuffer[] {
  if (frame.byteLength < PREFIX_BYTES + 4 || frame.byteLength > STREAM_BATCH_BYTES + PREFIX_BYTES + STREAM_BATCH_RECORDS * 4) throw Error('Invalid stream batch');
  const view = new DataView(frame), count = view.getUint16(4);
  if (view.getUint32(0) !== MAGIC || view.getUint16(6) !== 0 || !count || count > STREAM_BATCH_RECORDS || frame.byteLength < PREFIX_BYTES + count * 4) throw Error('Invalid stream batch');
  let at = PREFIX_BYTES + count * 4, total = 0;
  const spans: [number, number][] = [];
  for (let index = 0; index < count; index++) {
    const size = view.getUint32(PREFIX_BYTES + index * 4);
    total += size;
    if (size > STREAM_RECORD_BYTES || total > STREAM_BATCH_BYTES || at + size > frame.byteLength) throw Error('Invalid stream batch');
    spans.push([at, at + size]); at += size;
  }
  if (at !== frame.byteLength) throw Error('Invalid stream batch');
  // Validate the entire envelope before exposing any record to the caller.
  return spans.map(([start, end]) => frame.slice(start, end));
}

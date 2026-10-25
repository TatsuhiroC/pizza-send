// A slow link is worth replacing only when it will also keep the user waiting.
// Sample committed progress, never bytes merely queued in the browser.
export const TURN_POLICY = { windowMs: 10000, sustainedMs: 8000, slowBps: 256 * 1024, longEtaSeconds: 90 };
export class TurnFallbackPolicy {
  private samples: { at: number; bytes: number }[] = [];
  private slowSince?: number;
  reset() { this.samples = []; this.slowSince = undefined; }
  update(now: number, bytes: number, total: number, active: boolean) {
    if (!active || total <= bytes || !Number.isFinite(bytes) || !Number.isFinite(total)) { this.reset(); return false; }
    const previous = this.samples.at(-1);
    // Tab suspension and checkpoint rollback require a fresh window.
    if (previous && (now <= previous.at || now - previous.at > 4000 || bytes < previous.bytes)) this.reset();
    this.samples.push({ at: now, bytes });
    while (this.samples.length > 1 && this.samples[1].at <= now - TURN_POLICY.windowMs) this.samples.shift();
    const first = this.samples[0], elapsed = now - first.at;
    if (elapsed < TURN_POLICY.windowMs) return false;
    const speed = (bytes - first.bytes) * 1000 / elapsed;
    // Sustained zero progress has an unbounded ETA, even if heartbeats arrive.
    const eligible = speed < TURN_POLICY.slowBps && (speed === 0 || (total - bytes) / speed > TURN_POLICY.longEtaSeconds);
    if (!eligible) { this.slowSince = undefined; return false; }
    this.slowSince ??= now;
    return now - this.slowSince >= TURN_POLICY.sustainedMs;
  }
}

export type TurnCredentials = { iceServers: RTCIceServer[]; expiresAt: number };
export async function readTurnCredentials(response: Response): Promise<TurnCredentials> {
  if (!response.body) throw Error('中继暂时不可用');
  const reader = response.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) throw Error('中继暂时不可用');
      parts.push(new Uint8Array(value));
    }
  } finally { await reader.cancel(); }
  return turnCredentials(JSON.parse(await new Blob(parts).text()));
}
export function turnCredentials(value: any): TurnCredentials {
  if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now() + 60000 || value.expiresAt > Date.now() + 3900000 ||
      !Array.isArray(value.iceServers) || !value.iceServers.length || value.iceServers.length > 4) throw Error('中继暂时不可用');
  const iceServers = value.iceServers.map((server: any) => {
    const urls = typeof server?.urls === 'string' ? [server.urls] : server?.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 || !urls.every((url: any) => typeof url === 'string' &&
      /^turns?:turn\.cloudflare\.com:(3478|443|5349|80)\?transport=(udp|tcp)$/.test(url)) ||
      typeof server.username !== 'string' || !server.username.length || server.username.length > 1024 ||
      typeof server.credential !== 'string' || !server.credential.length || server.credential.length > 1024) throw Error('中继暂时不可用');
    return { urls, username: server.username, credential: server.credential };
  });
  return { iceServers, expiresAt: value.expiresAt };
}

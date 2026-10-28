// A slow link is worth replacing only when it will also keep the user waiting.
// Sample committed progress, never bytes merely queued in the browser.
export const ROUTE_POLICY = { windowMs: 10000, sustainedMs: 8000, slowBps: 256 * 1024, longEtaSeconds: 90 };
export class RouteFallbackPolicy {
  private samples: { at: number; bytes: number }[] = [];
  private slowSince?: number;
  reset() { this.samples = []; this.slowSince = undefined; }
  update(now: number, bytes: number, total: number, active: boolean) {
    if (!active || total <= bytes || !Number.isFinite(bytes) || !Number.isFinite(total)) { this.reset(); return false; }
    const previous = this.samples[this.samples.length - 1];
    // Tab suspension and checkpoint rollback require a fresh window.
    if (previous && (now <= previous.at || now - previous.at > 4000 || bytes < previous.bytes)) this.reset();
    this.samples.push({ at: now, bytes });
    while (this.samples.length > 1 && this.samples[1].at <= now - ROUTE_POLICY.windowMs) this.samples.shift();
    const first = this.samples[0], elapsed = now - first.at;
    if (elapsed < ROUTE_POLICY.windowMs) return false;
    const speed = (bytes - first.bytes) * 1000 / elapsed;
    // Sustained zero progress has an unbounded ETA, even if heartbeats arrive.
    const eligible = speed < ROUTE_POLICY.slowBps && (speed === 0 || (total - bytes) / speed > ROUTE_POLICY.longEtaSeconds);
    if (!eligible) { this.slowSince = undefined; return false; }
    this.slowSince ??= now;
    return now - this.slowSince >= ROUTE_POLICY.sustainedMs;
  }
}

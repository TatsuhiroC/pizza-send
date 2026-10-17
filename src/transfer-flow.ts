const KiB = 1024, MiB = 1048576;
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

// Application-level backpressure; SCTP retains its own congestion control.
// ACK latency includes network, browser buffering and confirmed receiver writes.
export class TransferFlow {
  windowBytes = 4 * MiB;
  private probes: { end: number; at: number }[] = [];
  private confirmed = 0;
  private lastAck = 0;
  private rateStart = 0;
  private rateBytes = 0;
  private rate = 0;
  private minimumLatency = Infinity;
  private limitedAt = -Infinity;
  private lastTune = -Infinity;
  private hasAck = false;
  reset(confirmed: number, now = performance.now()) {
    this.windowBytes = 4 * MiB;
    this.probes = []; this.confirmed = confirmed; this.lastAck = this.rateStart = now;
    this.rateBytes = this.rate = 0; this.minimumLatency = Infinity;
    this.limitedAt = this.lastTune = -Infinity;
    this.hasAck = false;
  }
  allows(inFlight: number, next: number, now = performance.now()) {
    const allowed = inFlight + next <= this.windowBytes;
    if (!allowed) this.limitedAt = now;
    return allowed;
  }
  sent(end: number, now = performance.now()) {
    this.probes.push({ end, at: now });
  }
  confirm(bytes: number, now = performance.now()) {
    if (bytes <= this.confirmed) return;
    const delta = bytes - this.confirmed, gap = now - this.lastAck;
    this.confirmed = bytes; this.lastAck = now;
    let count = 0, sentAt: number | undefined;
    while (count < this.probes.length && this.probes[count].end <= bytes) sentAt = this.probes[count++].at;
    if (count) this.probes.splice(0, count);
    const latency = sentAt === undefined ? undefined : Math.max(1, now - sentAt);
    if (latency !== undefined) this.minimumLatency = Math.min(this.minimumLatency, latency);
    const previousRate = this.rate;
    if (!this.hasAck) { this.hasAck = true; this.rateStart = now; }
    else this.rateBytes += delta;
    if (now - this.rateStart >= 100) {
      const rate = this.rateBytes * 1000 / (now - this.rateStart);
      this.rate = this.rate ? this.rate * .75 + rate * .25 : rate;
      this.rateStart = now; this.rateBytes = 0;
    }
    const baseline = this.minimumLatency;
    const stalled = latency !== undefined && latency > Math.max(baseline * 2.5, baseline + 100) &&
      (gap > Math.max(150, baseline * 2) || (previousRate > 0 && this.rate < previousRate * .85));
    if (stalled && now - this.lastTune >= Math.max(200, baseline)) {
      this.windowBytes = Math.max(512 * KiB, Math.floor(this.windowBytes * .75)); this.lastTune = now;
    } else if (!stalled) {
      // Stable slow feedback needs headroom; fast feedback permits a smaller
      // flight. 32 MiB/s is only the initial estimate, not a transfer speed cap.
      const target = Number.isFinite(baseline) ? clamp((this.rate || 32 * MiB) * baseline / 1000 * 2 + 512 * KiB, 512 * KiB, 4 * MiB) : this.windowBytes;
      const probe = now - this.limitedAt < Math.max(250, baseline * 2) ? Math.min(delta, 256 * KiB) : 0;
      this.windowBytes = Math.floor(target < this.windowBytes ? target : Math.min(target, this.windowBytes + probe));
    }
  }
}

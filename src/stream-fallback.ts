import { RouteFallbackPolicy } from './route-policy';
import type { StreamChannel } from './stream-channel';

type Progress = { bytes: number; total: number; active: boolean; hidden: boolean; connected: boolean };
export type TransferRoute = 'direct' | 'stream';
export type RouteState = { available: boolean; current: TransferRoute; target: TransferRoute; busy: boolean; manual: boolean; failed: boolean; recovering?: boolean };
type Hooks = {
  epoch(): number; progress(): Progress; stopped(): boolean;
  open(session: string, current: () => boolean): Promise<StreamChannel>;
  send(message: unknown): Promise<void>;
  activate(channel: StreamChannel, epoch: number): Promise<void>;
  restore(): void;
  changed?(): void;
};
type Candidate = { session: string; epoch: number; channel?: StreamChannel; bytes: number;
  timer: ReturnType<typeof setTimeout>; acknowledged?: () => void; activated?: () => void; committing?: boolean; cancelled?: boolean; early: string[]; earlyBytes: number };
const PROBE_BYTES = 256 * 1024;
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function streamWorthTrying(oldBps: number, probeMs: number, remaining: number) {
  if (!Number.isFinite(probeMs) || probeMs <= 0 || remaining < 0) return false;
  const rate = PROBE_BYTES * 1000 / probeMs;
  // Include setup margin and require a useful absolute rate, not just a tiny
  // relative gain over a nearly stalled connection.
  return rate >= Math.max(32768, oldBps * 1.5) && (!oldBps || remaining / rate + 5 < remaining / oldBps - 10);
}

// Probe authenticated ciphertext on a separate TCP path
// while the old route continues; switch only after a measured benefit.
export class StreamFallback {
  supported = false;
  active = false;
  busy = false;
  private closed = false;
  private tried = false;
  private candidate?: Candidate;
  private policy = new RouteFallbackPolicy();
  private samples: { at: number; bytes: number }[] = [];
  private disconnectedAt = 0;
  private trial?: { at: number; bytes: number; oldBps: number };
  private used = new Set<string>();
  private preference?: TransferRoute;
  private manualAttempted = false;
  private target: TransferRoute = 'stream';
  private failed = false;
  constructor(private role: 'sender' | 'receiver', private hooks: Hooks) {}
  get state(): RouteState { return { available: this.supported && this.used.size > 0, current: this.active ? 'stream' : 'direct', target: this.target,
    busy: this.busy, manual: !!this.preference, failed: this.failed }; }
  choose(route: TransferRoute) {
    this.preference = route; this.manualAttempted = false; this.trial = undefined; this.failed = false; this.target = route;
    if (this.role === 'sender' && route === 'direct' && this.candidate && !this.candidate.committing) this.abort(this.candidate, false);
    this.hooks.changed?.();
  }
  monitor(allowed: boolean, now = Date.now()) {
    const state = this.hooks.progress();
    if (this.closed || this.hooks.stopped()) { this.close(); return; }
    if (!this.supported || state.hidden) { this.policy.reset(); this.samples = []; this.trial = undefined; return; }
    if (this.role !== 'sender' || this.busy) return;
    if (this.preference) {
      if (this.preference === 'direct' && this.active) this.restore();
      else if (this.preference === 'stream' && !this.active && !this.manualAttempted && allowed) {
        this.manualAttempted = true; void this.prepare(0, false, true);
      }
      return;
    }
    if (this.active) {
      const trial = this.trial;
      if (trial && now - trial.at >= 20000) {
        this.trial = undefined;
        const rate = Math.max(0, state.bytes - trial.bytes) * 1000 / (now - trial.at);
        if (trial.oldBps > 0 && rate < trial.oldBps * 1.2 && rate < 256 * 1024 && (rate === 0 || (state.total - state.bytes) / rate > 90)) this.restore();
      }
      return;
    }
    if (this.tried) { this.policy.reset(); this.samples = []; this.disconnectedAt = 0; return; }
    if (state.connected) this.disconnectedAt = 0; else this.disconnectedAt ||= now;
    this.samples.push({ at: now, bytes: state.bytes });
    while (this.samples.length > 1 && this.samples[1].at <= now - 10000) this.samples.shift();
    const slow = this.policy.update(now, state.bytes, state.total, state.active);
    if (!allowed) return; // Observe recovery pauses, but do not race native negotiation.
    if (!slow && (!this.disconnectedAt || now - this.disconnectedAt < 15000)) return;
    const first = this.samples[0], oldBps = state.connected && now > first.at ? Math.max(0, state.bytes - first.bytes) * 1000 / (now - first.at) : 0;
    void this.prepare(oldBps, false);
  }
  reconnect() {
    if (!this.active || this.closed) return false;
    if (!this.busy && this.role === 'sender') void this.prepare(0, true);
    return true;
  }
  private begin(session: string, epoch: number) {
    if (this.used.has(session) || this.used.size >= 128) throw Error('Stream session reused');
    this.used.add(session);
    const candidate: Candidate = { session, epoch, bytes: 0, early: [], earlyBytes: 0, timer: setTimeout(() => this.abort(candidate), 30000) };
    this.busy = true; this.failed = false; this.target = 'stream'; this.candidate = candidate; this.hooks.changed?.(); return candidate;
  }
  private current(candidate: Candidate) {
    return !this.closed && !this.hooks.stopped() && this.candidate === candidate && this.hooks.epoch() === candidate.epoch;
  }
  private async open(candidate: Candidate) {
    // A canceled signaling wait may finish after a newer attempt has started.
    // Do not obtain a socket for it: the server replaces same-role sockets.
    if (!this.current(candidate)) throw Error('Stale stream candidate');
    const channel = await this.hooks.open(candidate.session, () => this.current(candidate));
    if (!this.current(candidate)) { channel.close(); throw Error('Stale stream candidate'); }
    candidate.channel = channel;
    channel.onmessage = event => {
      try {
        if (!this.current(candidate)) return;
        if (event.data instanceof ArrayBuffer) {
          if (this.role !== 'receiver' || event.data.byteLength !== 32768 || candidate.bytes + event.data.byteLength > PROBE_BYTES) throw Error();
          candidate.bytes += event.data.byteLength; return;
        }
        const message = JSON.parse(event.data);
        if (message.type === 'stream-probe-end' && this.role === 'receiver' && candidate.bytes === PROBE_BYTES) channel.send(JSON.stringify({ type: 'stream-probe-ok' }));
        else if (message.type === 'stream-probe-ok' && this.role === 'sender') candidate.acknowledged?.();
        else if (this.role === 'sender' && candidate.committing && message.type === 'visibility') {
          // The receiver installs the file protocol one signaling RTT earlier.
          // Preserve its initial visibility update until the sender commits.
          if (candidate.earlyBytes + event.data.length > 65536 || candidate.early.length >= 32) throw Error();
          candidate.early.push(event.data); candidate.earlyBytes += event.data.length;
        }
        // Receiver activation can precede the sender by one signaling RTT.
        else if (message.type === 'ping') channel.send(JSON.stringify({ type: 'pong' }));
        else if (message.type !== 'pong') throw Error();
      } catch { this.abort(candidate); }
    };
    channel.onerror = channel.onclose = () => this.abort(candidate);
    await channel.ready;
    if (!this.current(candidate)) throw Error('Stale stream candidate');
    return channel;
  }
  private async prepare(oldBps: number, reconnect: boolean, manual = false) {
    if (this.closed || this.busy || this.hooks.stopped() || this.tried && !reconnect && !manual) return;
    if (this.used.size >= 128) { if (reconnect) this.restore(); return; }
    this.tried = true;
    const session = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
    const candidate = this.begin(session, this.hooks.epoch());
    try {
      await this.hooks.send({ type: 'stream-prepare', session, epoch: candidate.epoch });
      const channel = await this.open(candidate), start = performance.now();
      const probed = new Promise<void>(resolve => { candidate.acknowledged = resolve; });
      for (let i = 0; i < PROBE_BYTES / 32768; i++) channel.send(new ArrayBuffer(32768));
      channel.send(JSON.stringify({ type: 'stream-probe-end' }));
      await probed;
      if (!this.current(candidate)) return;
      const state = this.hooks.progress();
      if (state.hidden || this.preference === 'direct' || !reconnect && !manual && !streamWorthTrying(oldBps, performance.now() - start, state.total - state.bytes)) { this.abort(candidate, false); return; }
      const activated = new Promise<void>(resolve => { candidate.activated = resolve; });
      candidate.committing = true;
      await this.hooks.send({ type: 'stream-activate', session, epoch: candidate.epoch }); await activated;
      if (!this.current(candidate)) return;
      this.finish(candidate, true);
      await this.hooks.activate(channel, candidate.epoch + 1);
      if (this.closed || this.hooks.stopped()) { channel.close(); return; }
      for (const data of candidate.early) channel.onmessage?.(new MessageEvent('message', { data }));
      this.active = true; this.busy = false; this.trial = this.preference ? undefined : { at: Date.now(), bytes: this.hooks.progress().bytes, oldBps };
      this.hooks.changed?.(); this.monitor(true);
    } catch {
      if (candidate.cancelled) return;
      this.abort(candidate); this.busy = false;
      if (!this.active) candidate.channel?.close();
      if (reconnect && this.active) this.restore();
      this.hooks.changed?.();
    }
  }
  async handle(message: any) {
    if (this.closed || this.hooks.stopped() || !this.supported || !valid(message.session) || message.epoch !== this.hooks.epoch()) return;
    if (message.type === 'stream-prepare' && this.role === 'receiver') {
      if (this.busy || this.used.has(message.session) || this.used.size >= 128) return;
      const candidate = this.begin(message.session, message.epoch);
      try { await this.open(candidate); } catch { this.abort(candidate); }
      return;
    }
    const candidate = this.candidate;
    if (!candidate || candidate.session !== message.session || candidate.epoch !== message.epoch) return;
    if (message.type === 'stream-unavailable') { this.abort(candidate); return; }
    if (message.type === 'stream-activated' && this.role === 'sender') { candidate.activated?.(); return; }
    if (message.type === 'stream-activate' && this.role === 'receiver' && candidate.bytes === PROBE_BYTES && candidate.channel?.readyState === 'open') {
      const channel = candidate.channel; this.finish(candidate, true);
      try {
        await this.hooks.activate(channel, candidate.epoch + 1);
        if (this.closed || this.hooks.stopped()) { channel.close(); return; }
        this.active = true; this.busy = false; this.hooks.changed?.();
        await this.hooks.send({ type: 'stream-activated', session: candidate.session, epoch: candidate.epoch });
      } catch { this.busy = false; channel.close(); this.restore(); }
    }
  }
  private finish(candidate: Candidate, committing = false) {
    clearTimeout(candidate.timer); this.candidate = undefined; this.busy = committing;
    if (candidate.channel) candidate.channel.onmessage = candidate.channel.onclose = candidate.channel.onerror = null;
  }
  private abort(candidate: Candidate, failed = true) {
    if (this.candidate !== candidate) return;
    candidate.cancelled = true;
    this.finish(candidate); this.failed = failed; candidate.channel?.close();
    candidate.acknowledged?.(); candidate.activated?.();
    if (!this.closed) void this.hooks.send({ type: 'stream-unavailable', session: candidate.session, epoch: candidate.epoch }).catch(() => {});
    if (this.active && !this.closed) this.restore();
    this.hooks.changed?.();
  }
  private restore() { this.active = false; this.target = 'direct'; this.trial = undefined; this.hooks.restore(); this.hooks.changed?.(); }
  useNative() { this.active = false; this.target = 'direct'; this.trial = undefined; if (this.candidate) this.abort(this.candidate); this.hooks.changed?.(); }
  close() { this.closed = true; if (this.candidate) this.abort(this.candidate); }
}

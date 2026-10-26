import type { DataChannel } from './stream-channel';

export const STANDBY_PROBE_MS = 3000;
export const standbyNonce = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// One spare channel per transfer. Keep the original cipher/counters and drain
// ordered in-flight messages before a fresh ping proves it safe to reuse.
export class StandbyTransport {
  private heartbeat: ReturnType<typeof setInterval>;
  private pending?: { nonce: string; timer: ReturnType<typeof setTimeout>; promise: Promise<boolean>; resolve(value: boolean): void };
  private missed = 0;
  private detached = false;
  constructor(readonly channel: DataChannel, readonly pc?: RTCPeerConnection) {
    channel.onopen = channel.onbufferedamountlow = null;
    if (pc) pc.onconnectionstatechange = pc.onicecandidate = pc.ondatachannel = null;
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 65536) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ping') this.send({ type: 'pong' });
        else if (message.type === 'standby-ping' && standbyNonce(message.nonce)) this.send({ type: 'standby-pong', nonce: message.nonce });
        else if (message.type === 'standby-pong' && message.nonce === this.pending?.nonce) this.finish(true);
      } catch { this.close(); }
    };
    channel.onclose = channel.onerror = () => this.close();
    this.heartbeat = setInterval(() => { void this.probe().then(ok => { if (!this.detached && !ok && ++this.missed >= 2) this.close(); }); }, 10000);
  }
  get open() { return !this.detached && this.channel.readyState === 'open' && (!this.pc || this.pc.connectionState === 'connected'); }
  private send(message: unknown) { this.channel.send(JSON.stringify(message)); }
  probe(): Promise<boolean> {
    if (!this.open) return Promise.resolve(false);
    if (this.pending) return this.pending.promise;
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
    this.pending = { nonce, resolve, promise, timer: setTimeout(() => this.finish(false), STANDBY_PROBE_MS) };
    try { this.send({ type: 'standby-ping', nonce }); } catch { this.finish(false); }
    return promise;
  }
  private finish(ok: boolean) {
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); if (ok) this.missed = 0; pending.resolve(ok); }
  }
  take() {
    this.detached = true;
    clearInterval(this.heartbeat); this.finish(false);
    this.channel.onmessage = this.channel.onclose = this.channel.onerror = null;
    return this.channel;
  }
  close() { this.take().close(); this.pc?.close(); }
}

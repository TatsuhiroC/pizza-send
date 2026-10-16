type Lock = EventTarget & { released: boolean; release(): Promise<void> };
type WakeAPI = { request(type: 'screen'): Promise<Lock> };
export type AwakeState = 'idle' | 'off' | 'unsupported' | 'requesting' | 'held' | 'released';

// One lock for the whole page, including a share with multiple recipients.
export class ScreenAwake {
  private active = false;
  private enabled = true;
  private lock?: Lock;
  private pending?: Promise<void>;
  private revision = 0;
  state: AwakeState = 'idle';
  private api = (navigator as Navigator & { wakeLock?: WakeAPI }).wakeLock;
  get supported() { return !!this.api; }
  get isEnabled() { return this.enabled; }
  private visible = () => { this.sync(); };
  constructor(private changed: () => void) {
    try { this.enabled = localStorage.getItem('pizza-send-keep-awake') !== 'off'; } catch {}
    document.addEventListener('visibilitychange', this.visible);
  }
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active; this.sync();
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    try { localStorage.setItem('pizza-send-keep-awake', enabled ? 'on' : 'off'); } catch {}
    this.sync();
  }
  retry() { this.sync(); }
  private report(state: AwakeState) { this.state = state; this.changed(); }
  private sync() {
    if (!this.active || !this.enabled || document.hidden || !this.api) {
      this.revision++;
      const lock = this.lock; this.lock = undefined;
      if (lock && !lock.released) void lock.release().catch(() => {});
      this.report(!this.active ? 'idle' : !this.api ? 'unsupported' : !this.enabled ? 'off' : 'released');
      return;
    }
    if (this.lock && !this.lock.released) { this.report('held'); return; }
    if (this.pending) return;
    const revision = this.revision;
    this.report('requesting');
    const request = (async () => {
      try {
        const lock = await this.api!.request('screen');
        if (revision !== this.revision || !this.active || !this.enabled || document.hidden) {
          await lock.release().catch(() => {}); return;
        }
        this.lock = lock;
        lock.addEventListener('release', () => {
          if (this.lock !== lock) return;
          this.lock = undefined; this.report('released');
        }, { once: true });
        this.report(lock.released ? 'released' : 'held');
      } catch { if (revision === this.revision) this.report('released'); }
    })();
    this.pending = request;
    void request.finally(() => {
      if (this.pending !== request) return;
      this.pending = undefined;
      // A new session/visibility can overtake a pending OS permission request.
      if (revision !== this.revision && this.active && this.enabled && !document.hidden) this.sync();
    });
  }
}

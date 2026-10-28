export type DeliveryState = 'idle' | 'selected' | 'transferring' | 'recovering' | 'done';
export const completionSymbol = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 10 3.2 3.2L15 6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class DeliveryMotion {
  private state?: DeliveryState;
  private lidOpening?: Animation;
  private readonly onIntroEnd = (event: AnimationEvent) => {
    if (event.animationName === 'pizza-float') this.finishIntro();
  };
  constructor(private hero: HTMLElement, private completion: HTMLElement) {
    this.hero.addEventListener('animationend', this.onIntroEnd);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) this.finishIntro();
    this.setState('idle');
  }
  private finishIntro() {
    this.hero.dataset.intro = 'finished';
    this.hero.removeEventListener('animationend', this.onIntroEnd);
  }
  setState(state: DeliveryState) {
    if (this.state === state) return;
    // Selecting a file can interrupt the entrance, without replaying it on reset.
    if (state !== 'idle') this.finishIntro();
    const opens = (state === 'selected' || state === 'done') && this.state !== 'selected' && this.state !== 'done';
    this.lidOpening?.cancel();
    this.hero.dataset.state = state;
    this.completion.hidden = state !== 'done';
    this.completion.classList.toggle('is-complete', state === 'done');
    this.state = state;
    if (opens && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const lid = this.hero.querySelector<SVGElement>('.parcel-lid-face');
      if (lid && typeof lid.animate === 'function') {
        // Project a rigid lid around the rear hinge, instead of morphing two
        // matrices. Both hinge endpoints remain attached at every angle.
        const frames = Array.from({ length: 136 }, (_, degree) => {
          const angle = degree * Math.PI / 180;
          const c = -.36 * Math.cos(angle);
          const d = .25456 * (Math.cos(angle) - Math.sin(angle));
          return { transform: `matrix(.36,.25456,${c},${d},${42 + 5 * (-.36 - c)},${39 + 5 * (.25456 - d)})` };
        });
        try { this.lidOpening = lid.animate(frames, { duration: 700, easing: 'cubic-bezier(.3,.65,.3,1)' }); }
        catch { /* Optional SVG animation must not interrupt file selection. */ }
      }
    }
  }
  get currentState() { return this.state || 'idle'; }
}

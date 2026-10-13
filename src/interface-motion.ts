export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// A dismissed scanner must never connect after its success animation finishes.
export function motionPause(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = (completed: boolean) => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(completed);
    };
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function filenameOverlay(dialog: HTMLDialogElement, close: HTMLElement) {
  const surface = dialog.querySelector<HTMLElement>('.filename-surface')!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pressedOutside = false;
  const outside = (event: MouseEvent) => {
    const rect = surface.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  const dismiss = () => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    if (reducedMotion()) { dialog.close(); return; }
    dialog.classList.add('is-closing');
    timer = setTimeout(() => dialog.close(), 160);
  };
  close.onclick = dismiss;
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('pointerdown', event => { pressedOutside = outside(event); });
  dialog.addEventListener('click', event => { if (pressedOutside && outside(event)) dismiss(); pressedOutside = false; });
  dialog.addEventListener('close', () => { clearTimeout(timer); dialog.classList.remove('is-closing'); pressedOutside = false; });
}

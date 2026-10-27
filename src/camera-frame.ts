// Match the whole source frame without cropping or changing the camera stream.
export function fitCameraFrame(video: HTMLVideoElement) {
  const frame = video.closest<HTMLElement>('.scan-frame');
  const dialog = frame?.closest<HTMLDialogElement>('dialog');
  if (!frame || !dialog) return;
  let ratio = 4 / 3, pending = 0;
  const fit = () => {
    pending = 0;
    if (!dialog.open) return;
    const style = getComputedStyle(dialog);
    const contentWidth = dialog.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    // Measure the actual heading, instructions and buttons, including wrapping
    // in either language. Reserve their space before sizing the preview.
    const children = [...dialog.children].filter(child => child.getBoundingClientRect().height > 0);
    const last = children[children.length - 1]!;
    // Use subpixel bounds rather than rounded scrollHeight, so resizing cannot
    // create a one-pixel feedback loop in the observer.
    const otherHeight = last.getBoundingClientRect().bottom - dialog.getBoundingClientRect().top
      + dialog.scrollTop + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth)
      + parseFloat(getComputedStyle(last).marginBottom) - frame.getBoundingClientRect().height;
    const viewport = Math.min(innerHeight, visualViewport?.height ?? innerHeight);
    const availableHeight = Math.max(64, viewport - 32 - otherHeight);
    const width = Math.min(contentWidth, availableHeight * ratio);
    if (width <= 0) return;
    const value = `${width.toFixed(3)}px`;
    if (frame.style.width !== value) frame.style.width = value;
    frame.style.aspectRatio = String(ratio);
  };
  const schedule = () => { if (!pending) pending = requestAnimationFrame(fit); };
  const dimensions = () => {
    if (video.videoWidth && video.videoHeight) ratio = video.videoWidth / video.videoHeight;
    // Keep the last ratio when capture stops: the success still must not jump.
    schedule();
  };
  video.addEventListener('loadedmetadata', dimensions);
  video.addEventListener('resize', dimensions);
  window.addEventListener('resize', schedule);
  visualViewport?.addEventListener('resize', schedule);
  const observer = new ResizeObserver(schedule);
  observer.observe(dialog);
  for (const child of dialog.children) observer.observe(child);
}

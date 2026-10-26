// A connection hint only: no room, credential or health request is created.
export function setSignalPreconnect(value: string) {
  const existing = document.getElementById('signal-preconnect');
  let origin = '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.origin !== location.origin) origin = url.origin;
  } catch { /* Manual pairing or an invalid saved endpoint needs no hint. */ }
  if (!origin) { existing?.remove(); return; }
  if (existing?.getAttribute('href') === origin) return;
  existing?.remove();
  const link = document.createElement('link');
  link.id = 'signal-preconnect'; link.rel = 'preconnect'; link.crossOrigin = 'anonymous'; link.href = origin;
  document.head.append(link);
}

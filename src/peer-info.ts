export type PeerInfo = {
  device: 'phone' | 'tablet' | 'computer' | 'unknown';
  browser: 'safari' | 'chrome' | 'edge' | 'firefox' | 'opera' | 'samsung' | 'unknown';
};

const devices = ['phone', 'tablet', 'computer', 'unknown'];
const browsers = ['safari', 'chrome', 'edge', 'firefox', 'opera', 'samsung', 'unknown'];

// Send only coarse labels, never the raw user agent or device identifiers.
export function localPeerInfo(source: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): PeerInfo {
  const ua = source.userAgent;
  const tablet = /iPad/i.test(ua) || /Macintosh/i.test(ua) && source.maxTouchPoints > 1 || /Android/i.test(ua) && !/Mobile/i.test(ua);
  const device = tablet ? 'tablet' : /iPhone|iPod|Android|Mobile/i.test(ua) ? 'phone' : /Windows|Macintosh|X11|CrOS|Linux/i.test(ua) ? 'computer' : 'unknown';
  const browser = /Edg(?:e|A|iOS)?\//i.test(ua) ? 'edge' : /OPR\/|OPiOS\/|Opera/i.test(ua) ? 'opera' : /SamsungBrowser\//i.test(ua) ? 'samsung' : /Firefox\/|FxiOS\//i.test(ua) ? 'firefox' : /Chrome\/|Chromium\/|CriOS\//i.test(ua) ? 'chrome' : /Version\/.*Safari\//i.test(ua) ? 'safari' : 'unknown';
  return { device, browser };
}

export function readPeerInfo(value: unknown): PeerInfo | undefined {
  if (!value || typeof value !== 'object') return;
  const { device, browser } = value as Record<string, unknown>;
  if (typeof device !== 'string' || !devices.includes(device) || typeof browser !== 'string' || !browsers.includes(browser)) return;
  return { device, browser } as PeerInfo;
}

export const deviceLabel: Record<PeerInfo['device'], string> = { phone: '手机', tablet: '平板', computer: '电脑', unknown: '设备未知' };
export const browserLabel: Record<PeerInfo['browser'], string> = { safari: 'Safari', chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', opera: 'Opera', samsung: 'Samsung Internet', unknown: '浏览器未知' };

import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Preview the same global response policy as Pages. Host-specific rules (such
// as production HSTS) must not affect local HTTP development or preview hosts.
const headers: Record<string, string> = {};
let global = false;
for (const line of readFileSync(new URL('./public/_headers', import.meta.url), 'utf8').split('\n')) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  if (!/^\s/.test(line)) { global = line.trim() === '/*'; continue; }
  const colon = line.indexOf(':');
  if (global && colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
}
export default defineConfig({
  base: './', build: { target: 'es2020' }, preview: { headers },
  // Discover the lazy archive worker's dependency at startup, so its first use
  // in development cannot reload the page and discard the current selection.
  optimizeDeps: { include: ['@zip.js/zip.js/lib/zip-core-custom.js'] }
});

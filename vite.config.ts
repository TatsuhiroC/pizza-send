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
export default defineConfig({ base: './', build: { target: 'es2022' }, preview: { headers } });

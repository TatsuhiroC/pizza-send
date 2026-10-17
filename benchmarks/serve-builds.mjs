// Serve isolated published/candidate builds on the same origin. Never exposes
// source directories; each URL must resolve inside its selected dist folder.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const roots = { published: process.env.BENCH_BASELINE_DIST, candidate: resolve('dist') };
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
createServer(async (req, res) => {
  try {
    const [, variant, ...rest] = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).split('/');
    const root = roots[variant];
    if (!root) { res.writeHead(variant ? 404 : 200); res.end(); return; }
    const path = resolve(root, rest.join('/') || 'index.html');
    if (!path.startsWith(resolve(root) + sep)) throw new Error('Outside build');
    const headers = {};
    let global = false;
    for (const line of (await readFile(resolve(root, '_headers'), 'utf8')).split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (!/^\s/.test(line)) { global = line.trim() === '/*'; continue; }
      const colon = line.indexOf(':');
      if (global && colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    const body = await readFile(path);
    res.writeHead(200, { ...headers, 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
}).listen(5173, '127.0.0.1');

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = new URL('../../signal/wrangler.jsonc', import.meta.url);
const config = JSON.parse(await readFile(source, 'utf8'));
config.main = fileURLToPath(new URL(config.main, source));

// HTTP fixtures already isolate their rate-limit keys. Browser WebSocket
// upgrades share the same loopback address across the entire suite.
const handshake = config.ratelimits.find(binding => binding.name === 'HANDSHAKE_LIMITER');
handshake.simple.limit = 1000;

const directory = await mkdtemp(join(tmpdir(), 'pizzasend-test-signal-'));
try {
  const configPath = join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config));
  const wrangler = fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const worker = spawn(process.execPath, [wrangler, 'dev', '--local', '--port', '8787', '--config', configPath, '--persist-to', directory], { stdio: 'inherit' });
  process.once('SIGTERM', () => worker.kill('SIGTERM'));
  process.once('SIGINT', () => worker.kill('SIGINT'));
  const [code] = await once(worker, 'exit');
  process.exitCode = code ?? 0;
} finally {
  await rm(directory, { recursive: true, force: true });
}

import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stable = JSON.parse(await readFile(join(root, 'deployment/production.json'), 'utf8')).revision;
if (!/^[a-f0-9]{40}$/.test(stable)) throw Error('Production revision must be a full Git commit SHA');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1048576 });
try { git('cat-file', '-e', stable + '^{commit}'); }
catch { git('fetch', '--depth=1', 'origin', stable); }
const candidate = git('rev-parse', 'HEAD').toString().trim();
const workspace = await mkdtemp(join(tmpdir(), 'pizzasend-site-'));
const env = { ...process.env };
delete env.VITE_PIZZASEND_CHANNEL; delete env.VITE_PIZZASEND_REVISION;
const build = (cwd, extra = {}) => execFileSync('npm', ['run', 'build'], { cwd, env: { ...env, ...extra }, stdio: 'inherit' });
try {
  const archive = git('archive', stable);
  execFileSync('tar', ['-xf', '-', '-C', workspace], { input: archive });
  // Reuse exactly matching dependencies. A promoted release with a different
  // lockfile gets its own immutable npm installation instead.
  const lock = await readFile(join(root, 'package-lock.json'));
  if (lock.equals(await readFile(join(workspace, 'package-lock.json')))) await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir');
  else execFileSync('npm', ['ci'], { cwd: workspace, env, stdio: 'inherit' });
  build(workspace);
  build(root, { VITE_PIZZASEND_CHANNEL: 'test', VITE_PIZZASEND_REVISION: candidate });
  const testSite = join(workspace, 'test-site');
  await cp(join(root, 'dist'), testSite, { recursive: true });
  await rm(join(root, 'dist'), { recursive: true });
  await cp(join(workspace, 'dist'), join(root, 'dist'), { recursive: true });
  await cp(testSite, join(root, 'dist/test'), { recursive: true });
  for (const file of ['_headers', '_redirects']) await rm(join(root, 'dist/test', file), { force: true });
  const headerFile = join(root, 'dist/_headers');
  await writeFile(headerFile, await readFile(headerFile, 'utf8') + '\n/test/*\n  Cache-Control: no-store\n  X-Robots-Tag: noindex, nofollow\n');
  const redirects = join(root, 'dist/_redirects');
  const existingRedirects = await readFile(redirects, 'utf8').catch(() => '');
  await writeFile(redirects, existingRedirects + '\n/test /test/ 302\n');
  await writeFile(join(root, 'dist/test/release.json'), JSON.stringify({ channel: 'test', revision: candidate, productionRevision: stable }) + '\n');
  console.log(JSON.stringify({ production: stable, test: candidate, testPath: '/test/' }));
} finally { await rm(workspace, { recursive: true, force: true }); }

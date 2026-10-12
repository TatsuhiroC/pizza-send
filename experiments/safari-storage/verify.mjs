import { webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const sizes = (process.env.PROBE_MIB || '512,2048').split(',').map(Number);
const url = process.env.PROBE_URL || 'http://127.0.0.1:5173/experiments/safari-storage/';
const output = process.env.PROBE_REPORT || '/tmp/pizza-send-safari-storage.json';
const scratch = await mkdtemp(join(tmpdir(), 'pizza-send-webkit-storage-'));
const report = { engine: 'isolated Playwright WebKit, not Safari or iPhone', created: new Date().toISOString(), trials: [], errors: [] };
let context;
let sampling = false, peakRssKiB = 0;
async function sample() {
  if (sampling) return; sampling = true;
  try {
    const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss=,comm=']);
    const rows = stdout.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
    const descendants = new Set([process.pid]);
    for (let i = 0; i < 8; i++) for (const row of rows) if (descendants.has(Number(row[2]))) descendants.add(Number(row[1]));
    const rss = rows.filter(row => descendants.has(Number(row[1])) && Number(row[1]) !== process.pid && !row[4].endsWith('/ps')).reduce((sum, row) => sum + Number(row[3]), 0);
    peakRssKiB = Math.max(peakRssKiB, rss);
  } catch {} finally { sampling = false; }
}
const timer = setInterval(() => { void sample(); }, 1000);
function expectedHash(mib) {
  const block = Buffer.alloc(1048576); for (let i = 0; i < block.length; i++) block[i] = i % 251;
  const hash = createHash('sha256'); for (let i = 0; i < mib; i++) hash.update(block);
  return hash.digest('hex');
}
async function downloadedHash(path) {
  const hash = createHash('sha256'); for await (const buffer of createReadStream(path)) hash.update(buffer);
  return hash.digest('hex');
}
try {
  context = await webkit.launchPersistentContext(join(scratch, 'profile'), { headless: true, acceptDownloads: true });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => ['idle', 'error'].includes(window.probe?.state.phase));
  report.capabilities = await page.evaluate(() => window.probe.state.capabilities);
  if (await page.evaluate(() => window.probe.state.phase === 'error')) throw Error(JSON.stringify(await page.evaluate(() => window.probe.state.error)));
  for (const mib of sizes) {
    peakRssKiB = 0;
    const expected = expectedHash(mib);
    console.log(JSON.stringify({ stage: 'start', mib, expectedHash: expected }));
    await page.evaluate(size => { void window.probe.run(size).catch(() => {}); }, mib * 1048576);
    let lastStage;
    while (true) {
      const state = await page.evaluate(() => window.probe.state);
      if (state.phase === 'ready') break;
      if (state.phase === 'error') throw Error(JSON.stringify(state.error));
      const stage = state.phase + ':' + Math.floor(state.completed / state.total * 10);
      if (stage !== lastStage) { console.log(JSON.stringify({ stage: state.phase, mib, completedMiB: Math.round(state.completed / 1048576), peakDescendantRssMiB: Math.round(peakRssKiB / 1024) })); lastStage = stage; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const result = await page.evaluate(() => window.probe.state.result);
    if (result.readHash !== expected || result.writeHash !== expected) throw Error('Independent expected hash mismatch');
    console.log(JSON.stringify({ stage: 'download', mib, peakDescendantRssMiB: Math.round(peakRssKiB / 1024) }));
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.locator('#save').click(); const download = await downloadPromise;
    const path = join(scratch, 'export-' + mib + '.bin');
    await download.saveAs(path);
    if (await download.failure()) throw Error(await download.failure());
    const digest = await downloadedHash(path), size = (await stat(path)).size;
    if (size !== mib * 1048576 || digest !== expected) throw Error('Export checksum or size mismatch');
    await sample();
    const trial = { mib, ...result, exportHash: digest, exportSize: size, exportPassed: true, peakDescendantRssMiB: Math.round(peakRssKiB / 1024), memoryMetric: '1-second samples of summed descendant-process RSS; not JS heap or system-wide peak' };
    report.trials.push(trial); console.log(JSON.stringify({ stage: 'passed', mib, writeSeconds: result.writeSeconds, peakDescendantRssMiB: trial.peakDescendantRssMiB }));
    await page.evaluate(() => window.probe.cleanup()); await download.delete(); await rm(path, { force: true });
    await writeFile(output, JSON.stringify(report, null, 2));
  }
} catch (error) { report.failure = error.message; process.exitCode = 1; console.log(JSON.stringify({ stage: 'failed', error: error.message })); }
finally {
  clearInterval(timer); await context?.close(); await rm(scratch, { recursive: true, force: true });
  await mkdir(join(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
}

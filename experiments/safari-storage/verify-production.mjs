import { webkit } from 'playwright';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = await mkdtemp(join(tmpdir(), 'pizza-send-production-storage-'));
const report = { engine: 'isolated Playwright WebKit, production storage module; no WebRTC in this capacity test', created: new Date().toISOString(), trials: [] };
let context;
function expectedHash(mib) {
  const block = Buffer.alloc(1048576); for (let i = 0; i < block.length; i++) block[i] = i % 251;
  const hash = createHash('sha256'); for (let i = 0; i < mib; i++) hash.update(block); return hash.digest('hex');
}
try {
  context = await webkit.launchPersistentContext(join(scratch, 'profile'), { headless: true, acceptDownloads: true });
  const page = await context.newPage(); await page.goto(process.env.PROBE_URL || 'http://127.0.0.1:5173/');
  page.on('console', message => { if (message.text().startsWith('STORAGE_PROGRESS ')) console.log(message.text()); });
  for (const mib of (process.env.PROBE_MIB || '10240,20480').split(',').map(Number)) {
    const expected = expectedHash(mib); console.log(JSON.stringify({ stage: 'start', mib }));
    const result = await page.evaluate(async mib => {
      const storage = await import('/src/received-storage.ts');
      const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
      const size = mib * 1048576, started = performance.now(), estimate = await navigator.storage.estimate();
      const session = await storage.createTemporarySession(size); if (!session) throw Error('Disk storage unavailable');
      const info = { id: 0, name: 'production-' + mib + 'MiB.bin', size, type: 'application/octet-stream' };
      await storage.beginTemporaryFile(session, info);
      const block = new Uint8Array(1048576); for (let i = 0; i < block.length; i++) block[i] = i % 251;
      const hash = sha256.create(); let last = -1;
      for (let offset = 0; offset < size; offset += 32768) {
        const bytes = block.slice(offset % block.length, offset % block.length + 32768); hash.update(bytes);
        await storage.writeTemporaryFile(session, offset, bytes.buffer);
        const phase = Math.floor((offset + 32768) / size * 10);
        if (phase !== last) { last = phase; console.log('STORAGE_PROGRESS ' + JSON.stringify({ mib, completedMiB: Math.round((offset + 32768) / 1048576) })); }
      }
      const writeHash = Array.from(hash.digest(), b => b.toString(16).padStart(2, '0')).join('');
      await storage.finishTemporaryFile(session, writeHash);
      const files = await storage.listTemporaryFiles(), record = files.find(f => f.session === session);
      if (!record) throw Error('Completed file record missing');
      const url = await storage.temporaryURL(record);
      const a = document.createElement('a'); a.id = 'production-storage-download'; a.href = url; a.download = info.name; a.textContent = 'Save production test fixture'; document.body.append(a);
      return { session, mib, size, writeHash, estimate, writeSeconds: (performance.now() - started) / 1000, userAgent: navigator.userAgent };
    }, mib);
    if (result.writeHash !== expected) throw Error('Write hash mismatch');
    const pending = page.waitForEvent('download', { timeout: 120000 }); await page.locator('#production-storage-download').click(); const download = await pending;
    const path = join(scratch, mib + '.bin'); await download.saveAs(path);
    if (await download.failure()) throw Error(await download.failure());
    const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
    const digest = hash.digest('hex'), bytes = (await stat(path)).size;
    if (digest !== expected || bytes !== result.size) throw Error('Actual export checksum/size mismatch');
    report.trials.push({ ...result, exportHash: digest, exportSize: bytes, exportPassed: true });
    console.log(JSON.stringify({ stage: 'passed', mib, writeSeconds: result.writeSeconds }));
    await page.evaluate(async session => {
      const s = await import('/src/received-storage.ts'); const record = (await s.listTemporaryFiles()).find(f => f.session === session);
      await s.deleteTemporaryFile(record); await s.discardTemporaryPartial(session); document.getElementById('production-storage-download').remove();
    }, result.session);
    await download.delete(); await rm(path, { force: true });
    await writeFile((process.env.PROBE_REPORT || '/tmp/pizza-send-production-storage-webkit.json'), JSON.stringify(report, null, 2));
  }
} catch (error) { report.failure = error.message; process.exitCode = 1; console.log(JSON.stringify({ stage: 'failed', error: error.message })); }
finally { await context?.close(); await rm(scratch, { recursive: true, force: true }); await writeFile((process.env.PROBE_REPORT || '/tmp/pizza-send-production-storage-webkit.json'), JSON.stringify(report, null, 2)); }

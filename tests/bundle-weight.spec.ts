import { test, expect } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

test('production assets stay within the lightweight budget without shipping development entries', async () => {
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(join('dist', directory), { withFileTypes: true })) {
      const name = join(directory, entry.name);
      if (entry.isDirectory()) await walk(name); else files.push(name);
    }
  };
  await walk('');
  const html = await readFile('dist/index.html', 'utf8');
  const entry = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
  expect(entry).not.toBeNull();
  const script = await readFile(join('dist', entry![1].replace(/^\.\//, '')));
  // Leave headroom for useful changes; review an increase rather than silently
  // moving optional decoders/archives into the startup bundle.
  expect(gzipSync(script).length).toBeLessThanOrEqual(96 * 1024);
  let compressed = 0, styles = 0;
  for (const file of files) {
    expect(file).not.toMatch(/(?:^|\/)(?:src|tests|experiments|docs)\/|(?:animation|interface)-preview\.html$|\.(?:ts|map)$/);
    const size = gzipSync(await readFile(join('dist', file))).length;
    compressed += size; if (file.endsWith('.css')) styles += size;
  }
  expect(styles).toBeLessThanOrEqual(12 * 1024);
  expect(compressed).toBeLessThanOrEqual(224 * 1024);
});

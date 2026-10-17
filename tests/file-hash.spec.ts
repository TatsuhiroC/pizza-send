import { test, expect } from './fixtures';
import { createHash } from 'node:crypto';

for (const fallback of [false, true]) test(`streaming SHA-256 and independent concurrent instances (${fallback ? 'JS fallback' : 'WASM'})`, async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async fallback => {
    const compile = WebAssembly.compile;
    const instantiate = WebAssembly.instantiate; let instances = 0;
    WebAssembly.instantiate = (async (...args: any[]) => {
      const result = await (instantiate as any)(...args); instances++; return result;
    }) as typeof WebAssembly.instantiate;
    if (fallback) WebAssembly.compile = async () => { throw new Error('Fixture WASM disabled'); };
    try {
      const { createFileHash } = await import('/src/file-hash.ts');
      const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
      const outputs: { size: number; digest: string }[] = [];
      for (const size of [0, 1, 55, 56, 63, 64, 65, 32768, 1048593]) {
        const data = Uint8Array.from({ length: size }, (_, i) => i % 251);
        const original = await createFileHash(), other = await createFileHash();
        for (let offset = 0; offset < size; offset += 32768) {
          original.update(data.subarray(offset, offset + 32768));
          other.update(data.subarray(offset, offset + 32768));
        }
        const digest = hex(original.digest());
        if (hex(other.digest()) !== digest) throw new Error('Concurrent hash state differs');
        outputs.push({ size, digest });
      }
      return { outputs, instances };
    } finally { WebAssembly.compile = compile; WebAssembly.instantiate = instantiate; }
  }, fallback);
  expect(result.instances > 0).toBe(!fallback);
  for (const { size, digest } of result.outputs) {
    const data = Buffer.alloc(size); for (let i = 0; i < size; i++) data[i] = i % 251;
    expect(digest).toBe(createHash('sha256').update(data).digest('hex'));
  }
});

test('cancellation during hash initialization aborts the newly opened file', async ({ page }) => {
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { Transfer } = await import('/src/protocol.ts');
    const instantiate = WebAssembly.instantiate;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    WebAssembly.instantiate = (async (...args: any[]) => {
      entered(); await gate; return (instantiate as any)(...args);
    }) as typeof WebAssembly.instantiate;
    let aborted = 0;
    const t = new Transfer({ signalUrl: '', iceServers: [], memoryLimitBytes: 1048576 }, 'receiver', () => {}), state = t as any;
    t.manifest = [{ id: 0, name: 'cancel.bin', type: '', size: 1 }]; state.accepted = true;
    state.handles = [{ createWritable: async () => ({ abort: async () => { aborted++; } }) }];
    try {
      const pending = state.handle(JSON.stringify({ type: 'file-start', id: 0 }), 0);
      await started; t.close(false); release(); await pending;
      return { aborted, incoming: !!state.incoming };
    } finally { release(); WebAssembly.instantiate = instantiate; t.close(false); }
  });
  expect(result).toEqual({ aborted: 1, incoming: false });
});

test('accelerated SHA-256 crosses the 4 GiB byte counter boundary with bounded input memory', async ({ page }) => {
  const block = Buffer.alloc(1048576, 73), tail = Buffer.alloc(17, 91);
  const expected = createHash('sha256');
  for (let i = 0; i < 4096; i++) expected.update(block);
  expected.update(tail);
  await page.goto('./');
  const actual = await page.evaluate(async () => {
    const { createFileHash } = await import('/src/file-hash.ts');
    const hash = await createFileHash(), block = new Uint8Array(1048576).fill(73);
    for (let i = 0; i < 4096; i++) hash.update(block);
    hash.update(new Uint8Array(17).fill(91));
    return Array.from(hash.digest(), n => n.toString(16).padStart(2, '0')).join('');
  });
  expect(actual).toBe(expected.digest('hex'));
});

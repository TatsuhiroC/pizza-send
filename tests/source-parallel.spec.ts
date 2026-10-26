import { test, expect } from '@playwright/test';
import { checkSources, SourceReadError } from '../src/source-files';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const reads: { file: string; start: number; end: number; resolve: () => void; reject: () => void }[] = [];
  let inFlight = 0, peak = 0;
  const files = Array.from({ length: 9 }, (_, index) => ({ name: `file-${index}`, size: 100000, slice(start: number, end: number) {
    return { arrayBuffer: () => new Promise<ArrayBuffer>((resolve, reject) => {
      peak = Math.max(peak, ++inFlight);
      reads.push({ file: `file-${index}`, start, end,
        resolve: () => { inFlight--; resolve(new ArrayBuffer(end - start)); },
        reject: () => { inFlight--; reject(Error('Native read failed')); } });
    }) };
  } } as unknown as File));
  return { files, reads, peak: () => peak };
}

test('parallel checks bound native reads to four and preserve every file head and tail', async () => {
  const f = fixture(), names = f.files.map(file => file.name);
  const checking = checkSources(f.files, () => true);
  await tick();
  expect(f.reads.map(read => read.file)).toEqual(names.slice(0, 4));
  for (let index = 0; index < 18; index++) {
    expect(f.reads[index]).toBeDefined();
    f.reads[index].resolve(); await tick();
  }
  await checking;
  expect(f.peak()).toBe(4);
  expect(f.files.map(file => file.name)).toEqual(names);
  for (const name of names) expect(f.reads.filter(read => read.file === name).map(({ start, end }) => [start, end])).toEqual([[0, 32768], [67232, 100000]]);
});

test('the first bad source cancels sibling waits and late reads cannot start more files', async () => {
  const f = fixture();
  const checking = checkSources(f.files, () => true);
  const result = expect(checking).rejects.toThrow('file-1');
  await tick(); f.reads[1].reject(); await result;
  expect(f.reads).toHaveLength(4);
  f.reads.filter((_, index) => index !== 1).forEach(read => read.resolve());
  await tick(); expect(f.reads).toHaveLength(4);
});

test('cancellation stops pending checks without waiting for native reads', async () => {
  const f = fixture(), controller = new AbortController();
  const checking = checkSources(f.files, () => true, controller.signal);
  const result = expect(checking).rejects.toMatchObject({ name: 'AbortError' });
  await tick(); controller.abort(); await result;
  f.reads.forEach(read => read.reject());
  await tick(); expect(f.reads).toHaveLength(4);
});

test('an inactive selection stops all siblings and invalid sizes remain actionable', async () => {
  const f = fixture(); let active = true;
  const checking = checkSources(f.files, () => active);
  await tick(); active = false; f.reads[0].resolve(); await checking;
  f.reads.slice(1).forEach(read => read.resolve());
  await tick(); expect(f.reads).toHaveLength(4);
  await expect(checkSources([{ name: 'invalid', size: Number.NaN } as File], () => true)).rejects.toBeInstanceOf(SourceReadError);
  await checkSources([new File([], 'empty')], () => true);
});

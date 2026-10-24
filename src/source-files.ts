export class SourceReadError extends Error {}
type ReadOptions = { signal?: AbortSignal; deferTimeout?: () => number };

// Always read bounded ranges, including files beyond the 2/4 GiB boundaries.
export async function readSource(file: File, start: number, end: number, timeout = 15000, options: ReadOptions = {}): Promise<ArrayBuffer> {
  const { signal, deferTimeout } = options;
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > file.size || end - start > 1048576) throw Error('Invalid source range');
    const reading = file.slice(start, end).arrayBuffer();
    // One guarded wait per chunk; native arrayBuffer() itself cannot be aborted.
    // Its late resolution/rejection stays handled after timeout or cancellation.
    const data = await new Promise<ArrayBuffer>((resolve, reject) => {
      void reading.then(resolve, reject);
      if (timeout) {
        const expire = () => {
          const delay = deferTimeout?.() ?? 0;
          if (Number.isFinite(delay) && delay > 0) timer = setTimeout(expire, delay);
          else reject(Error('Source read timed out'));
        };
        timer = setTimeout(expire, timeout);
      }
      if (signal) {
        abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      }
    });
    if (data.byteLength !== end - start) throw new Error('Short source read');
    return data;
  } catch {
    signal?.throwIfAborted();
    throw new SourceReadError('无法读取原文件“' + file.name + '”。请确认文件仍在本机、未被移动或修改，再重新选择。');
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

export async function checkSources(files: File[], active: () => boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let next = 0, stopped = false, failed = false, failure: unknown;
  const stop = () => { stopped = true; controller.abort(); };
  signal?.addEventListener('abort', stop, { once: true });
  const worker = async () => {
    try {
      while (!stopped) {
        if (!active()) { stop(); return; }
        const file = files[next++];
        if (!file) return;
        if (!Number.isSafeInteger(file.size) || file.size < 0) throw new SourceReadError('文件大小无效，请重新选择原文件。');
        // At most four small reads in flight; a file's head precedes its tail.
        await readSource(file, 0, Math.min(32768, file.size), undefined, { signal: controller.signal });
        if (!active()) { stop(); return; }
        if (file.size > 32768) await readSource(file, Math.max(32768, file.size - 32768), file.size, undefined, { signal: controller.signal });
      }
    } catch (error) {
      // Preserve the first actionable error, rather than a sibling's abort.
      if (!stopped) { failed = true; failure = error; stop(); }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    if (failed) throw failure;
    signal?.throwIfAborted();
  } finally { signal?.removeEventListener('abort', stop); }
}

export type FolderEntry = { path: string; file?: File };
export type DroppedSource = { kind: 'file'; file: File } | { kind: 'folder'; name: string; entries: FolderEntry[] };
export function validSourceSegment(name: string) {
  return typeof name === 'string' && !!name && name !== '.' && name !== '..' && name.length <= 255 && !/[\\/:\u0000-\u001f\u007f]/.test(name);
}

// Capture native entries while the drop event is still readable. Keep explicit
// directory entries (including empty directories) and the selected root name.
export async function droppedSources(data: DataTransfer, signal?: AbortSignal): Promise<DroppedSource[]> {
  signal?.throwIfAborted();
  const items = Array.from(data.items || []).filter(item => item.kind === 'file');
  const entries = items.map(item => item.webkitGetAsEntry?.());
  const fallbacks = items.map(item => item.getAsFile?.());
  const plain = Array.from(data.files);
  if (!entries.some(Boolean)) return plain.map(file => ({ kind: 'file', file }));
  const sources: DroppedSource[] = [];
  let visited = 0, files = 0;
  const read = <T>(operation: (resolve: (value: T) => void, reject: (error: unknown) => void) => void) => new Promise<T>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const done = (value: T) => { signal?.removeEventListener('abort', abort); resolve(value); };
    const fail = (error: unknown) => { signal?.removeEventListener('abort', abort); reject(error); };
    try { operation(done, fail); } catch (error) { fail(error); }
  });
  const visit = async (entry: FileSystemEntry, output: FolderEntry[], parent = '', depth = 0): Promise<void> => {
    signal?.throwIfAborted();
    if (++visited > 1000 || depth > 32) throw Error('文件夹层级或项目过多，请分批分享。');
    if (!validSourceSegment(entry.name)) throw Error('文件夹中有不支持的名称，请重命名后重试。');
    const path = parent + entry.name;
    if (new TextEncoder().encode(path).length > 4096) throw Error('文件夹路径过长，请缩短后重试。');
    if (entry.isFile) {
      if (++files > 100) throw Error('一次最多选择 100 个文件');
      output.push({ path, file: await read<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)) });
    } else if (entry.isDirectory) {
      output.push({ path: path + '/' });
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const batch = await read<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, output, path + '/', depth + 1);
      }
    } else throw Error('无法读取所选内容，请重新选择。');
  };
  for (let i = 0; i < entries.length; i++) {
    signal?.throwIfAborted();
    const entry = entries[i];
    if (entry?.isDirectory) {
      const output: FolderEntry[] = [];
      await visit(entry, output);
      sources.push({ kind: 'folder', name: entry.name, entries: output });
    }
    else if (entry) {
      const output: FolderEntry[] = [];
      await visit(entry, output);
      sources.push({ kind: 'file', file: output[0].file! });
    }
    else {
      const file = fallbacks[i];
      if (file) {
        if (++files > 100) throw Error('一次最多选择 100 个文件');
        sources.push({ kind: 'file', file });
      }
    }
  }
  return sources;
}

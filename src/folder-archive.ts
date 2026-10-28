import { throwIfAborted } from './cancellation';
import { storageDirectory } from './app-environment';
import type { DroppedSource } from './source-files';

export const ARCHIVE_ROOT = storageDirectory('pizzasend-source-archives-v1');
export const archiveLock = (id: string) => ARCHIVE_ROOT + ':' + id;
const validID = (id: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
const releases = new Map<File, () => void>();
const workers = new Set<Worker>();
let cleanup: Promise<void> | undefined;
const unavailable = '此浏览器不支持文件夹打包暂存，请先在系统中压缩文件夹，再选择生成的 ZIP 文件。';

// Abandoned sender archives have no recovery UI. Delete them on the next visit,
// but never touch archives still owned by another tab's worker lock.
export function cleanupSourceArchives() {
  return cleanup ??= (async () => {
    if (typeof navigator.storage?.getDirectory !== 'function' || typeof navigator.locks?.request !== 'function') return;
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ARCHIVE_ROOT);
      for await (const [id] of root.entries()) if (validID(id)) {
        await navigator.locks.request(archiveLock(id), { ifAvailable: true }, async lock => {
          if (lock) await root.removeEntry(id, { recursive: true });
        });
      }
    } catch { /* The directory may not exist, or website storage may be disabled. */ }
  })();
}

export function releaseSourceArchive(file: File) { releases.get(file)?.(); releases.delete(file); }
export function stopSourceArchives() { for (const worker of workers) worker.terminate(); workers.clear(); releases.clear(); }

export async function packageSources(sources: DroppedSource[], progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<File[]> {
  throwIfAborted(signal);
  const folders = sources.filter(source => source.kind === 'folder');
  if (!folders.length) return sources.map(source => (source as Extract<DroppedSource, { kind: 'file' }>).file);
  if (typeof navigator.storage?.getDirectory !== 'function' || typeof navigator.locks?.request !== 'function') throw Error(unavailable);
  await cleanupSourceArchives();
  throwIfAborted(signal);
  const id = crypto.randomUUID();
  const worker = new Worker(new URL('./folder-archive-worker.ts', import.meta.url), { type: 'module' });
  workers.add(worker);
  try {
    const archives = await new Promise<File[]>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')); };
      const fail = (error: Error) => { signal?.removeEventListener('abort', abort); reject(error); };
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = worker.onmessageerror = () => fail(Error('文件夹打包失败，请重试。'));
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') progress(data.done, data.total);
        else if (data.type === 'done') { signal?.removeEventListener('abort', abort); resolve(data.files); }
        else if (data.type === 'error') fail(Error(data.storageUnavailable ? unavailable : data.quota ? '打包所需的本机空间不足，请释放空间后重试。' : '文件夹打包失败，请确认原文件可读取、名称有效且本机空间充足。'));
      };
      worker.postMessage({ type: 'pack', id, folders });
    });
    let remaining = archives.length;
    for (const [index, file] of archives.entries()) releases.set(file, () => {
      worker.postMessage({ type: 'release', index });
      if (!--remaining) { worker.onmessage = ({ data }) => { if (data.type === 'released') { workers.delete(worker); worker.terminate(); } }; }
    });
    let index = 0;
    return sources.map(source => source.kind === 'file' ? source.file : archives[index++]);
  } catch (error) {
    worker.terminate(); workers.delete(worker);
    // Terminating the worker releases sync handles and the ownership lock.
    try {
      await navigator.locks.request(archiveLock(id), async () => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ARCHIVE_ROOT);
        await root.removeEntry(id, { recursive: true });
      });
    } catch { /* A later visit retries cleanup. */ }
    throw error;
  }
}

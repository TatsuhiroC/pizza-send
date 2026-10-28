import { storageDirectory } from './app-environment';
import { safeName } from './file-name';
import { configure, ZipWriter } from '@zip.js/zip.js/lib/zip-core-custom.js';
import { readSource, validSourceSegment, type DroppedSource } from './source-files';

// Only the writer and STORE method are used. No compression engine, external
// worker, WASM, network request or whole-file buffering is needed.
configure({ useWebWorkers: false, chunkSize: 262144 });
const ROOT = storageDirectory('pizzasend-source-archives-v1');
type Folder = Extract<DroppedSource, { kind: 'folder' }>;
type Access = { write(data: Uint8Array, options: { at: number }): number; flush(): void | Promise<void>; close(): void | Promise<void> };
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<Access> };
const scope = globalThis as unknown as { navigator: Navigator; postMessage(value: unknown): void; onmessage(event: MessageEvent): void };
let dir: FileSystemDirectoryHandle, root: FileSystemDirectoryHandle, batchID: string;
let releaseLock: (() => void) | undefined;
const live = new Set<number>();
let queue = Promise.resolve();

function validate(folders: Folder[]) {
  let total = 0, count = 0, fileCount = 0;
  if (!Array.isArray(folders) || !folders.length || folders.length > 100) throw Error('Invalid folders');
  for (const folder of folders) {
    if (!validSourceSegment(folder.name) || !Array.isArray(folder.entries)) throw Error('Invalid folder');
    const paths = new Map<string, boolean>();
    for (const entry of folder.entries) {
      if (++count > 1000 || typeof entry.path !== 'string') throw Error('Too many entries');
      const path = entry.file ? entry.path : entry.path.slice(0, -1), parts = path.split('/');
      if ((!entry.file && !entry.path.endsWith('/')) || parts[0] !== folder.name || parts.length > 33 ||
          !parts.every(validSourceSegment) || new TextEncoder().encode(path).length > 4096 || paths.has(path) ||
          (parts.length > 1 && paths.get(parts.slice(0, -1).join('/')) !== true)) throw Error('Invalid archive path');
      paths.set(path, !entry.file);
      if (entry.file) {
        if (++fileCount > 100 || !(entry.file instanceof File) || !Number.isSafeInteger(entry.file.size)) throw Error('Invalid file');
        total += entry.file.size;
      }
    }
    if (paths.get(folder.name) !== true) throw Error('Missing root');
  }
  if (!Number.isSafeInteger(total)) throw Error('Invalid total');
  return total;
}
async function pack(id: string, folders: Folder[]) {
  let access: Access | undefined;
  let stage = 'validate';
  try {
    const total = validate(folders);
    if (batchID || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw Error('Invalid batch');
    batchID = id;
    stage = 'lock';
    await new Promise<void>((resolve, reject) => {
      void scope.navigator.locks.request(ROOT + ':' + id, async () => {
        await new Promise<void>(release => { releaseLock = release; resolve(); });
      }).catch(reject);
    });
    stage = 'storage-root';
    const originRoot = await scope.navigator.storage.getDirectory();
    stage = 'archive-root'; root = await originRoot.getDirectoryHandle(ROOT, { create: true });
    stage = 'batch-root';
    dir = await root.getDirectoryHandle(id, { create: true });
    stage = 'quota';
    const estimate = await scope.navigator.storage.estimate?.().catch(() => ({} as StorageEstimate));
    // STORE needs source size plus modest headers. This is advisory; writes can
    // still fail when another tab or app consumes the remaining quota.
    if (estimate?.quota !== undefined && total + 1048576 > estimate.quota - (estimate.usage || 0)) throw new DOMException('Quota', 'QuotaExceededError');
    const files: File[] = [];
    let done = 0, lastReport = 0;
    for (const [index, folder] of folders.entries()) {
      stage = 'open';
      const handle = await dir.getFileHandle(index + '.zip', { create: true }) as SyncFile;
      access = await handle.createSyncAccessHandle();
      let offset = 0;
      const writer = new ZipWriter(new WritableStream<Uint8Array>({
        write(bytes) {
          let at = 0;
          while (at < bytes.length) {
            const written = access!.write(bytes.subarray(at), { at: offset + at });
            if (!Number.isInteger(written) || written <= 0 || written > bytes.length - at) throw Error('Short archive write');
            at += written;
          }
          offset += bytes.length;
          if (!Number.isSafeInteger(offset)) throw Error('Invalid archive size');
        }
      }), { level: 0, useWebWorkers: false, bufferedWrite: false });
      for (const entry of folder.entries) {
        stage = 'entry';
        const start = done;
        const file = entry.file;
        let at = 0;
        const readable = file ? new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (at === file.size) { controller.close(); return; }
            const end = Math.min(at + 262144, file.size);
            const bytes = await readSource(file, at, end, 15000);
            at = end; controller.enqueue(new Uint8Array(bytes));
          }
        }) : undefined;
        await writer.add(entry.path, readable, {
          directory: !entry.file,
          uncompressedSize: file?.size,
          lastModDate: entry.file ? new Date(entry.file.lastModified) : undefined,
          onprogress(loaded) {
            const now = performance.now();
            if (now - lastReport > 120) { lastReport = now; scope.postMessage({ type: 'progress', done: start + loaded, total }); }
          }
        });
        done += entry.file?.size || 0;
      }
      stage = 'close';
      await writer.close(); await access.flush(); await access.close(); access = undefined;
      stage = 'snapshot';
      const snapshot = await handle.getFile();
      files.push(new File([snapshot], safeName(folder.name + '.zip'), { type: 'application/zip' })); live.add(index);
    }
    scope.postMessage({ type: 'progress', done: total, total });
    stage = 'deliver'; scope.postMessage({ type: 'done', files });
  } catch (error) {
    try { await access?.close(); } catch { /* Closed or failed device. */ }
    try { if (root && batchID) await root.removeEntry(batchID, { recursive: true }); } catch { /* Retry next visit. */ }
    releaseLock?.();
    scope.postMessage({ type: 'error', storageUnavailable: stage === 'storage-root', quota: error instanceof DOMException && error.name === 'QuotaExceededError', reason: stage + ': ' + (error instanceof Error ? error.name + ': ' + error.message : String(error)) });
  }
}
scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    if (data.type === 'pack') await pack(data.id, data.folders);
    else if (data.type === 'release' && live.delete(data.index)) {
      try { await dir.removeEntry(data.index + '.zip'); } catch { /* Retry next visit. */ }
      if (!live.size) {
        try { await root.removeEntry(batchID, { recursive: true }); } catch { /* Retry next visit. */ }
        releaseLock?.(); scope.postMessage({ type: 'released' });
      }
    }
  }).catch(() => scope.postMessage({ type: 'error' }));
};

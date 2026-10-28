import { STORAGE_ROOT, diskName, validSession, type StoredFile } from './storage-format';
import type { FileInfo } from './protocol';
import { downloadType } from './download';
export type { StoredFile } from './storage-format';

let worker: Worker | undefined, sequence = 0, available: Promise<boolean> | undefined;
const tasks = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const urls = new Map<string, string>();
const openingURLs = new Map<string, Promise<string>>();
let busySessions = 0;
export const temporaryBusyCount = () => busySessions;
export function suspendTemporaryStorage() {
  worker?.terminate(); worker = undefined; available = undefined;
  for (const task of tasks.values()) task.reject(new DOMException('Page closed', 'AbortError'));
  tasks.clear();
}
export const storedKey = (file: StoredFile) => file.session + ':' + file.info.id;
const changed = () => window.dispatchEvent(new Event('pizzasend-storage-change'));
function storageError(error: Error) {
  if (error.name === 'QuotaExceededError') return Error('浏览器暂存空间不足。请清理已保存的暂存文件，或释放设备空间后重试。');
  if (error.message.startsWith('浏览器')) return error;
  return Error('浏览器写盘失败。请检查剩余空间，保持页面打开后重新接收。');
}
function request<T>(type: string, data?: unknown, transfer: Transferable[] = []): Promise<T> {
  if (!worker) return Promise.reject(Error('浏览器暂存不可用，请刷新页面后重试。'));
  return new Promise((resolve, reject) => {
    const id = ++sequence; tasks.set(id, { resolve, reject });
    try { worker!.postMessage({ id, type, data }, transfer); }
    catch (error) { tasks.delete(id); reject(storageError(error as Error)); }
  });
}
export function supportsTemporaryStorage(): Promise<boolean> {
  return available ??= (async () => {
    if (!isSecureContext || typeof navigator.storage?.getDirectory !== 'function' || typeof navigator.locks?.request !== 'function') return false;
    let activeWorker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (!activeWorker || worker !== activeWorker) return;
      activeWorker.terminate(); worker = undefined;
      for (const task of tasks.values()) task.reject(Error('浏览器写盘进程已停止，请刷新页面后重试。'));
      tasks.clear();
    };
    try {
      activeWorker = worker = new Worker(new URL('./storage-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (worker !== activeWorker) return;
        const task = tasks.get(data.id); if (!task) return;
        tasks.delete(data.id);
        if (data.ok) task.resolve(data.data);
        else { const error = Error(data.error.message); error.name = data.error.name; task.reject(storageError(error)); }
      };
      worker.onerror = stop;
      worker.onmessageerror = stop;
      // Bound capability detection only. Real writes retain their existing
      // semantics; a slow disk must not trigger a mid-transfer memory fallback.
      timer = setTimeout(stop, 8000);
      const supported = await request<boolean>('probe');
      return supported && worker === activeWorker;
    } catch { stop(); return false; }
    finally { clearTimeout(timer); }
  })();
}
export async function createTemporarySession(total: number) {
  if (!await supportsTemporaryStorage()) return undefined;
  return request<string>('create', { total });
}
export const beginTemporaryFile = (session: string, info: FileInfo) => request<void>('begin', { session, info });
export function writeTemporaryFile(session: string, offset: number, buffer: ArrayBuffer) {
  return request<number>('write', { session, offset, buffer }, [buffer]);
}
export async function finishTemporaryFile(session: string, hash: string) { await request<void>('finish', { session, hash }); changed(); }
export async function completeTemporarySession(session: string) { await request<void>('complete', { session }); changed(); }
export async function discardTemporaryPartial(session: string) { await request<void>('discard', { session }); changed(); }
export async function listTemporaryFiles() {
  if (!await supportsTemporaryStorage()) return [];
  const result = await request<{ files: StoredFile[]; busy: number }>('list'); busySessions = result.busy;
  const present = new Set(result.files.map(storedKey));
  for (const [key, url] of urls) if (!present.has(key)) { URL.revokeObjectURL(url); urls.delete(key); }
  return result.files;
}
export async function retainTemporaryFile(file: StoredFile) { await request<void>('retain', { session: file.session, id: file.info.id }); changed(); }
export async function temporaryURL(file: StoredFile) {
  const key = storedKey(file), existing = urls.get(key); if (existing) return existing;
  const opening = openingURLs.get(key); if (opening) return opening;
  const task = (async () => {
  if (!validSession(file.session) || !Number.isInteger(file.info.id) || file.info.id < 0 || file.info.id >= 100) throw Error('Invalid stored file');
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle(STORAGE_ROOT)).getDirectoryHandle(file.session);
  const snapshot = await (await dir.getFileHandle(diskName(file.info.id))).getFile();
  if (snapshot.size !== file.info.size) throw Error('浏览器暂存文件大小不一致，请清理后重新接收。');
  // Keep the disk-backed bytes, but export the sender's type instead of the
  // internal .bin file's type. Safari uses this to choose a download extension.
  const url = URL.createObjectURL(snapshot.slice(0, snapshot.size, downloadType(file.info)));
  urls.set(key, url); return url;
  })();
  openingURLs.set(key, task);
  try { return await task; } finally { openingURLs.delete(key); }
}
export async function deleteTemporaryFile(file: StoredFile) {
  const key = storedKey(file);
  await openingURLs.get(key)?.catch(() => {});
  await request<void>('delete', { session: file.session, id: file.info.id });
  const url = urls.get(key); if (url) URL.revokeObjectURL(url); urls.delete(key); changed();
}

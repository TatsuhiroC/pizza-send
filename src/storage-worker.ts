import { STORAGE_ROOT, RETENTION_MS, validSession, storageLock, diskName, validateIndex, type StoredIndex, type StoredFile, type StoredEntry } from './storage-format';
import type { FileInfo } from './protocol';

type Access = { write(data: Uint8Array, options: { at: number }): number; read(data: Uint8Array, options: { at: number }): number; getSize(): number; truncate(size: number): void; flush(): void; close(): void };
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<Access> };
type Session = { dir: FileSystemDirectoryHandle; index: StoredIndex; release: () => void; live: boolean; access?: Access; active?: number; written: number };
const scope = globalThis as unknown as { navigator: Navigator; postMessage(value: unknown): void; onmessage: ((event: MessageEvent) => void) | null };
const sessions = new Map<string, Session>();
let queue = Promise.resolve();
async function root() { return (await scope.navigator.storage.getDirectory()).getDirectoryHandle(STORAGE_ROOT, { create: true }); }
async function syncFile(dir: FileSystemDirectoryHandle, name: string, create = false) { return await dir.getFileHandle(name, { create }) as SyncFile; }
function writeAll(access: Access, bytes: Uint8Array, at = 0) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = access.write(bytes.subarray(offset), { at: at + offset });
    if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) throw Error('No write progress');
    offset += count;
  }
}
async function writeIndex(s: Session) {
  s.index.revision++;
  // Alternate small indexes: an interrupted update leaves the previous valid copy.
  const handle = await syncFile(s.dir, 'index-' + (s.index.revision % 2 ? 'b' : 'a') + '.json', true);
  const access = await handle.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(s.index));
    writeAll(access, bytes); access.truncate(bytes.length); access.flush();
  } finally { access.close(); }
}
async function readIndex(dir: FileSystemDirectoryHandle) {
  const copies: StoredIndex[] = [];
  for (const name of ['index-a.json', 'index-b.json']) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size > 131072) continue;
      copies.push(validateIndex(JSON.parse(await file.text())));
    } catch { /* Another valid copy can survive an interrupted metadata write. */ }
  }
  if (!copies.length) throw Error('浏览器暂存记录无法读取，请在浏览器的网站数据设置中检查。');
  return copies.sort((a, b) => b.revision - a.revision)[0];
}
async function claim(id: string, create = false): Promise<Session | undefined> {
  if (!validSession(id)) throw Error('Invalid session');
  const existing = sessions.get(id); if (existing) return existing;
  let ready!: (s: Session | undefined) => void, reject!: (error: unknown) => void;
  const acquired = new Promise<Session | undefined>((resolve, fail) => { ready = resolve; reject = fail; });
  void scope.navigator.locks.request(storageLock(id), { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { ready(undefined); return; }
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const dir = await (await root()).getDirectoryHandle(id, { create });
      const index: StoredIndex = create ? { version: 1, revision: 0, createdAt: Date.now(), files: [] } : await readIndex(dir);
      const s: Session = { dir, index, release, live: create, written: 0 };
      sessions.set(id, s); ready(s); await held;
    } catch (error) { reject(error); }
  }).catch(reject);
  return acquired;
}
function owned(id: string) { const s = sessions.get(id); if (!s) throw Error('Temporary files are busy'); return s; }
async function removeEntry(dir: FileSystemDirectoryHandle, name: string) {
  try { await dir.removeEntry(name); } catch (error) { if ((error as DOMException).name !== 'NotFoundError') throw error; }
}
async function discardIncomplete(s: Session) {
  s.access?.close(); s.access = undefined; s.active = undefined;
  const pending = s.index.files.filter(f => !f.complete);
  for (const entry of pending) await removeEntry(s.dir, diskName(entry.info.id));
  if (pending.length) { s.index.files = s.index.files.filter(f => f.complete); await writeIndex(s); }
  const keep = new Set(s.index.files.map(f => diskName(f.info.id)));
  for await (const name of s.dir.keys()) {
    if (/^file-(?:[0-9]|[1-9][0-9])\.bin$/.test(name) && !keep.has(name)) await removeEntry(s.dir, name);
  }
}
async function removeEmpty(id: string, s: Session) {
  if (s.index.files.length) return;
  await (await root()).removeEntry(id, { recursive: true }); sessions.delete(id); s.release();
}
async function deleteEntry(id: string, s: Session, entry: StoredEntry) {
  const previous = s.index.files;
  s.index.files = previous.filter(f => f !== entry);
  try {
    // Update both copies before removal so an older index cannot resurrect it.
    await writeIndex(s); await writeIndex(s);
    await removeEntry(s.dir, diskName(entry.info.id));
    if (!s.live) await removeEmpty(id, s);
  } catch (error) {
    s.index.files = previous;
    // Keep the record recoverable across reloads when physical deletion failed.
    await writeIndex(s).then(() => writeIndex(s)).catch(() => {});
    throw error;
  }
}
async function endSession(s: Session) {
  if (!s.live) return;
  const expiresAt = Date.now() + RETENTION_MS;
  for (const entry of s.index.files) if (entry.complete) entry.expiresAt = expiresAt;
  if (s.index.files.length) { await writeIndex(s); await writeIndex(s); }
  s.live = false;
}
async function handle(type: string, data: any): Promise<unknown> {
  if (type === 'probe') {
    if (!scope.navigator.locks) throw Error('Web Locks unavailable');
    const dir = await root(), name = 'probe-' + crypto.randomUUID();
    try {
      const access = await (await syncFile(dir, name, true)).createSyncAccessHandle();
      try { writeAll(access, new Uint8Array([37])); access.flush(); if (access.getSize() !== 1) throw Error('Storage probe failed'); }
      finally { access.close(); }
    } finally { await removeEntry(dir, name); }
    return true;
  }
  if (type === 'create') {
    const estimate = await scope.navigator.storage.estimate();
    if (estimate.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < data.total) throw new DOMException('Insufficient storage quota', 'QuotaExceededError');
    const id = crypto.randomUUID(), s = await claim(id, true);
    if (!s) throw Error('Temporary files are busy');
    try { await writeIndex(s); } catch (error) { await (await root()).removeEntry(id, { recursive: true }).catch(() => {}); sessions.delete(id); s.release(); throw error; }
    return id;
  }
  if (type === 'list') {
    const files: StoredFile[] = [], dir = await root(); let busy = 0;
    for await (const [id, entry] of dir.entries()) {
      if (!validSession(id) || entry.kind !== 'directory') continue;
      const s = await claim(id); if (!s) { busy++; continue; } // Never touch another tab's active files.
      if (!s.live) {
        await discardIncomplete(s);
        // Shorten older deadlines once; listing never extends an existing deadline.
        const latestDeadline = Date.now() + RETENTION_MS;
        let updated = false;
        for (const file of s.index.files) if (file.complete && (file.expiresAt === undefined || file.expiresAt > latestDeadline)) {
          file.expiresAt = latestDeadline; updated = true;
        }
        if (updated) { await writeIndex(s); await writeIndex(s); }
        for (const file of [...s.index.files]) if (file.complete && file.expiresAt! <= Date.now()) await deleteEntry(id, s, file);
        if (sessions.has(id)) await removeEmpty(id, s);
      }
      for (const entry of s.index.files) if (entry.complete) {
        let unavailable = false;
        try { const file = await (await s.dir.getFileHandle(diskName(entry.info.id))).getFile(); unavailable = file.size !== entry.info.size; }
        catch { unavailable = true; }
        files.push({ session: id, info: entry.info, hash: entry.hash!, createdAt: s.index.createdAt, receivedAt: entry.receivedAt, expiresAt: s.live ? undefined : entry.expiresAt, unavailable });
      }
    }
    return { files: files.sort((a, b) => a.createdAt - b.createdAt || a.info.id - b.info.id), busy };
  }
  const s = owned(data.session);
  if (type === 'begin') {
    const info = data.info as FileInfo;
    if (s.access || s.index.files.some(f => f.info.id === info.id)) throw Error('Invalid file order');
    validateIndex({ ...s.index, files: [...s.index.files, { info, complete: false }] });
    s.index.files.push({ info, complete: false }); await writeIndex(s);
    s.access = await (await syncFile(s.dir, diskName(info.id), true)).createSyncAccessHandle();
    s.access.truncate(0); s.active = info.id; s.written = 0;
    return;
  }
  if (type === 'write') {
    const entry = s.index.files.find(f => f.info.id === s.active);
    const bytes = new Uint8Array(data.buffer);
    if (!s.access || !entry || data.offset !== s.written || !bytes.length || bytes.length > 256 * 1024 || s.written + bytes.length > entry.info.size) throw Error('Invalid write offset');
    const previous = s.written;
    writeAll(s.access, bytes, s.written); s.written += bytes.length;
    if (Math.floor(s.written / 1048576) > Math.floor(previous / 1048576) || s.written === entry.info.size) s.access.flush();
    return s.written;
  }
  if (type === 'finish') {
    const entry = s.index.files.find(f => f.info.id === s.active);
    if (!entry || !s.access || s.written !== entry.info.size || !/^[a-f0-9]{64}$/.test(data.hash)) throw Error('Incomplete file');
    s.access.flush(); s.access.close(); s.access = undefined; s.active = undefined;
    entry.complete = true; entry.hash = data.hash; entry.receivedAt = Date.now(); entry.expiresAt = entry.receivedAt + RETENTION_MS;
    try { await writeIndex(s); } catch (error) { entry.complete = false; delete entry.hash; delete entry.receivedAt; delete entry.expiresAt; throw error; }
    return;
  }
  if (type === 'discard') {
    await discardIncomplete(s); await endSession(s); await removeEmpty(data.session, s); return;
  }
  if (type === 'complete') {
    if (s.access || s.index.files.some(f => !f.complete)) throw Error('Incomplete session');
    await endSession(s); await removeEmpty(data.session, s); return;
  }
  if (type === 'delete') {
    const entry = s.index.files.find(f => f.info.id === data.id && f.complete);
    if (!entry) throw Error('Temporary file unavailable');
    await deleteEntry(data.session, s, entry);
    return;
  }
  if (type === 'retain') {
    const entry = s.index.files.find(f => f.info.id === data.id && f.complete);
    if (!entry) throw Error('Temporary file unavailable');
    entry.expiresAt = Date.now() + RETENTION_MS;
    await writeIndex(s); await writeIndex(s);
    return;
  }
  throw Error('Unsupported storage operation');
}
scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try { scope.postMessage({ id: data.id, ok: true, data: await handle(data.type, data.data) }); }
    catch (error) { scope.postMessage({ id: data.id, ok: false, error: { name: (error as Error).name, message: (error as Error).message } }); }
  });
};

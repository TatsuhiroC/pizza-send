import type { FileInfo } from './protocol';

export const STORAGE_ROOT = 'pizzasend-received-v1';
export const RETENTION_MS = 60 * 60 * 1000;
export const validSession = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const storageLock = (id: string) => STORAGE_ROOT + ':' + id;
export const diskName = (id: number) => 'file-' + id + '.bin';
export type StoredEntry = { info: FileInfo; complete: boolean; hash?: string; expiresAt?: number };
export type StoredIndex = { version: 1; revision: number; createdAt: number; files: StoredEntry[] };
export type StoredFile = { session: string; info: FileInfo; hash: string; createdAt: number; expiresAt?: number; unavailable?: boolean };
export function validateIndex(value: unknown): StoredIndex {
  const v = value as StoredIndex;
  if (!v || v.version !== 1 || !Number.isSafeInteger(v.revision) || v.revision < 0 ||
      !Number.isSafeInteger(v.createdAt) || !Array.isArray(v.files) || v.files.length > 100) throw Error('Invalid storage index');
  const ids = new Set<number>();
  let total = 0;
  for (const entry of v.files) {
    const info = entry?.info;
    if (!info || !Number.isInteger(info.id) || info.id < 0 || info.id >= 100 || ids.has(info.id) ||
        typeof info.name !== 'string' || info.name.length > 255 || !info.name || /[\\/\u0000-\u001f]/.test(info.name) ||
        typeof info.type !== 'string' || info.type.length > 200 || !Number.isSafeInteger(info.size) || info.size < 0 ||
        typeof entry.complete !== 'boolean' || (entry.complete && !/^[a-f0-9]{64}$/.test(entry.hash || '')) ||
        (entry.expiresAt !== undefined && (!entry.complete || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= 0))) throw Error('Invalid stored file');
    ids.add(info.id); total += info.size;
  }
  if (!Number.isSafeInteger(total)) throw Error('Invalid stored size');
  return v;
}

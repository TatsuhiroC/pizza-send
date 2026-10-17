export class SourceReadError extends Error {}

// Always read bounded ranges, including files beyond the 2/4 GiB boundaries.
export async function readSource(file: File, start: number, end: number, timeout = 0): Promise<ArrayBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > file.size || end - start > 1048576) throw Error('Invalid source range');
    const reading = file.slice(start, end).arrayBuffer();
    const data = timeout ? await Promise.race([
      reading,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Source read timed out')), timeout); })
    ]) : await reading;
    if (data.byteLength !== end - start) throw new Error('Short source read');
    return data;
  } catch {
    throw new SourceReadError('无法读取原文件“' + file.name + '”。请确认文件仍在本机、未被移动或修改，再重新选择。');
  } finally { clearTimeout(timer); }
}

export async function checkSources(files: File[], active: () => boolean) {
  for (const file of files) {
    if (!active()) return;
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new SourceReadError('文件大小无效，请重新选择原文件。');
    await readSource(file, 0, Math.min(32768, file.size), 15000);
    if (file.size > 32768 && active()) await readSource(file, Math.max(32768, file.size - 32768), file.size, 15000);
  }
}

export type FolderEntry = { path: string; file?: File };
export type DroppedSource = { kind: 'file'; file: File } | { kind: 'folder'; name: string; entries: FolderEntry[] };
export function validSourceSegment(name: string) {
  return typeof name === 'string' && !!name && name !== '.' && name !== '..' && name.length <= 255 && !/[\\/:\u0000-\u001f\u007f]/.test(name);
}

// Capture native entries while the drop event is still readable. Keep explicit
// directory entries (including empty directories) and the selected root name.
export async function droppedSources(data: DataTransfer): Promise<DroppedSource[]> {
  const items = Array.from(data.items || []).filter(item => item.kind === 'file');
  const entries = items.map(item => item.webkitGetAsEntry?.());
  const fallbacks = items.map(item => item.getAsFile?.());
  const plain = Array.from(data.files);
  if (!entries.some(Boolean)) return plain.map(file => ({ kind: 'file', file }));
  const sources: DroppedSource[] = [];
  let visited = 0, files = 0;
  const visit = async (entry: FileSystemEntry, output: FolderEntry[], parent = '', depth = 0): Promise<void> => {
    if (++visited > 1000 || depth > 32) throw Error('文件夹层级或项目过多，请分批分享。');
    if (!validSourceSegment(entry.name)) throw Error('文件夹中有不支持的名称，请重命名后重试。');
    const path = parent + entry.name;
    if (new TextEncoder().encode(path).length > 4096) throw Error('文件夹路径过长，请缩短后重试。');
    if (entry.isFile) {
      if (++files > 100) throw Error('一次最多选择 100 个文件');
      output.push({ path, file: await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)) });
    } else if (entry.isDirectory) {
      output.push({ path: path + '/' });
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, output, path + '/', depth + 1);
      }
    } else throw Error('无法读取所选内容，请重新选择。');
  };
  for (let i = 0; i < entries.length; i++) {
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

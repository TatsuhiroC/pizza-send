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

// A directory entry's own byte size is not the size of its contents. Enumerate
// all readEntries batches; Chromium can return at most 100 entries per batch.
export async function droppedFiles(data: DataTransfer): Promise<File[]> {
  const items = Array.from(data.items || []).filter(item => item.kind === 'file');
  const entries = items.map(item => item.webkitGetAsEntry?.());
  const fallbacks = items.map(item => item.getAsFile?.());
  if (!entries.some(Boolean)) return Array.from(data.files);
  const files: File[] = [];
  let visited = 0;
  const visit = async (entry: FileSystemEntry, depth = 0): Promise<void> => {
    if (++visited > 1000 || depth > 32) throw Error('一次最多选择 100 个文件');
    if (entry.isFile) {
      if (files.length >= 100) throw Error('一次最多选择 100 个文件');
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, depth + 1);
      }
    }
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) await visit(entry);
    else {
      const file = fallbacks[i];
      if (file) {
        if (files.length >= 100) throw Error('一次最多选择 100 个文件');
        files.push(file);
      }
    }
  }
  return files;
}

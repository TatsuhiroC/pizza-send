import { test, expect } from '@playwright/test';
import { checkSources, droppedFiles, readSource, SourceReadError } from '../src/source-files';
import { remainingTime } from '../src/remaining-time';

test('large source validation reads only head and tail without a 32-bit size conversion', async () => {
  const ranges: number[][] = [], size = 10 * 1073741824 + 192;
  const file = { name: 'large.mp4', size, slice(start: number, end: number) {
    ranges.push([start, end]); return { arrayBuffer: async () => new ArrayBuffer(end - start) };
  } } as unknown as File;
  await checkSources([file], () => true);
  expect(ranges).toEqual([[0, 32768], [size - 32768, size]]);
  expect(ranges.reduce((n, [start, end]) => n + end - start, 0)).toBe(65536);
  await readSource(file, 4 * 1073741824 + 17, 4 * 1073741824 + 49);
  expect(ranges.at(-1)).toEqual([4294967313, 4294967345]);
});

test('unreadable and truncated source ranges fail with an actionable source error', async () => {
  for (const failure of ['NotFoundError', 'NotReadableError', 'AbortError', 'short']) {
    const file = { name: '原文件.mp4', size: 192, slice: () => ({ arrayBuffer: async () => {
      if (failure === 'short') return new ArrayBuffer(0);
      throw new DOMException('Native file read failure', failure);
    } }) } as unknown as File;
    await expect(readSource(file, 0, 192)).rejects.toBeInstanceOf(SourceReadError);
    await expect(checkSources([file], () => true)).rejects.toThrow('重新选择');
  }
});

test('folder import drains every directory batch and never counts directory metadata as a file', async () => {
  const a = new File(['first'], 'a.txt'), b = new File(['second'], 'b.txt');
  const entry = (file: File) => ({ isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(file) });
  let batches = 0;
  const directory = { isDirectory: true, isFile: false, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve([ [entry(a)], [entry(b)], [] ][batches++]) }) };
  const data = { items: [{ kind: 'file', webkitGetAsEntry: () => directory }], files: [new File([new Uint8Array(192)], 'folder')] } as unknown as DataTransfer;
  const files = await droppedFiles(data);
  expect(batches).toBe(3); expect(files.map(file => file.name)).toEqual(['a.txt', 'b.txt']);
  expect(files.reduce((sum, file) => sum + file.size, 0)).toBe(11);
});

test('ETA uses remaining confirmed bytes, distinguishes unknown speed and final verification', () => {
  expect(remainingTime(1000, 400, 2)).toBe('5 分钟');
  expect(remainingTime(1000, 998, 2)).toBe('1 秒');
  expect(remainingTime(1000, 0, 0)).toBe('正在估算');
  expect(remainingTime(1000, 1000, 2)).toBe('正在校验');
  expect(remainingTime(1000, 1000, 2, 'done')).toBe('完成');
  expect(remainingTime(1000, 400, 2, 'recovering')).toBe('等待网络恢复');
  expect(remainingTime(1000, 400, 2, 'error')).toBe('已停止');
});


test('mixed directory imports capture fallback files before the drop event becomes protected', async () => {
  const a = new File(['first'], 'a.txt'), b = new File(['second'], 'b.txt');
  let protectedMode = false;
  const directory = { isDirectory: true, isFile: false, createReader: () => {
    let done = false;
    return { readEntries: (resolve: (entries: unknown[]) => void) => {
      protectedMode = true;
      resolve(done ? [] : [{ isFile: true, file: (resolve: (file: File) => void) => resolve(a) }]); done = true;
    } };
  } };
  const data = { items: [
    { kind: 'file', webkitGetAsEntry: () => directory },
    { kind: 'file', getAsFile: () => protectedMode ? null : b }
  ] } as unknown as DataTransfer;
  expect((await droppedFiles(data)).map(file => file.name)).toEqual(['a.txt', 'b.txt']);
});

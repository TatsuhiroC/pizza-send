const $ = id => document.getElementById(id);
const worker = new Worker(new URL('./opfs-worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let sequence = 0, directory, url, cancelled = false, active = false;
const state = { phase: 'capabilities', completed: 0, total: 0, result: null, error: null, capabilities: null };
function progress(phase, completed, total) {
  Object.assign(state, { phase, completed, total });
  $('progress').value = total ? completed / total * 100 : 0;
  $('status').textContent = (phase === 'write' ? '正在分块写入' : '正在读回校验') + '：' + (completed / 1048576).toFixed(0) + ' / ' + (total / 1048576).toFixed(0) + ' MiB';
}
worker.onmessage = ({ data }) => {
  if (data.progress) { progress(data.progress.phase, data.progress.completed, data.progress.total); return; }
  const task = pending.get(data.id); if (!task) return;
  pending.delete(data.id);
  if (data.ok) task.resolve(data.data);
  else { const error = Error(data.error.message); error.name = data.error.name; task.reject(error); }
};
worker.onerror = event => {
  for (const task of pending.values()) task.reject(Error(event.message || 'Worker failed'));
  pending.clear();
};
function request(type, data, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, data }, transfer);
  });
}
async function cleanup() {
  if (active) throw Error('Wait for the active test to stop');
  if (url) URL.revokeObjectURL(url); url = undefined; $('save').hidden = true;
  $('save').removeAttribute('href');
  if (directory) { await (await navigator.storage.getDirectory()).removeEntry(directory, { recursive: true }); directory = undefined; }
  $('cleanup').disabled = true;
}
async function run(size, chunkBytes = 32768) {
  if (active) throw Error('A test is already running');
  if (!Number.isSafeInteger(size) || size < 1 || size % 1048576 || ![32768, 1048576].includes(chunkBytes)) throw Error('Invalid fixture size');
  await cleanup(); active = true; cancelled = false;
  Object.assign(state, { phase: 'write', result: null, error: null, completed: 0, total: size });
  $('result').textContent = '';
  $('start').disabled = true; $('cancel').disabled = false;
  const started = performance.now();
  directory = 'pizzasend-storage-probe-' + crypto.randomUUID();
  const name = 'pizzasend-probe-' + size / 1048576 + 'MiB.bin';
  try {
    const estimate = await navigator.storage.estimate();
    if (estimate.quota && estimate.usage !== undefined && estimate.quota - estimate.usage < size * 1.1) throw Error('Browser storage quota is too small for this test');
    await request('begin', { directory, name, size });
    const block = new Uint8Array(1048576);
    for (let i = 0; i < block.length; i++) block[i] = i % 251;
    let last = performance.now();
    for (let offset = 0; offset < size; offset += chunkBytes) {
      if (cancelled) throw new DOMException('Test cancelled', 'AbortError');
      const within = offset % block.length, buffer = block.slice(within, within + chunkBytes).buffer;
      await request('write', buffer, [buffer]);
      if (performance.now() - last > 150) { progress('write', offset + chunkBytes, size); last = performance.now(); }
    }
    const write = await request('finish'), writeSeconds = (performance.now() - started) / 1000;
    if (cancelled) throw new DOMException('Test cancelled', 'AbortError');
    // Readback is a synchronous worker loop; cancellation applies to writing.
    $('cancel').disabled = true;
    progress('verify', 0, size);
    const read = await request('verify');
    if (read.size !== size || write.writeHash !== read.readHash) throw Error('Disk readback checksum mismatch');
    const root = await navigator.storage.getDirectory(), dir = await root.getDirectoryHandle(directory);
    const file = await (await dir.getFileHandle(name)).getFile();
    if (file.size !== size) throw Error('Export File has the wrong size');
    url = URL.createObjectURL(file);
    $('save').href = url; $('save').download = name; $('save').hidden = false;
    state.result = { size, chunkBytes, writeSeconds, totalSeconds: (performance.now() - started) / 1000,
      writeHash: write.writeHash, readHash: read.readHash, exportFileSize: file.size, canShare: !!navigator.canShare?.({ files: [file] }),
      estimate, userAgent: navigator.userAgent };
    state.phase = 'ready'; $('progress').value = 100;
    $('status').textContent = '本地写入和读回校验完成；请保存测试文件，再校验导出的文件。';
    $('result').textContent = JSON.stringify(state.result, null, 2);
    return state.result;
  } catch (error) {
    await request('cancel').catch(() => {});
    state.phase = 'error'; state.error = { name: error.name, message: error.message };
    $('status').textContent = error.name + ': ' + error.message; throw error;
  } finally { active = false; $('start').disabled = false; $('cancel').disabled = true; $('cleanup').disabled = false; }
}
$('start').onclick = () => { void run(Number($('size').value) * 1048576).catch(() => {}); };
$('cancel').onclick = () => { cancelled = true; };
$('cleanup').onclick = () => { void cleanup().then(() => $('status').textContent = '浏览器测试文件已清理。').catch(error => $('status').textContent = error.message); };
window.probe = { state, run, cleanup };
try {
  state.capabilities = await request('capabilities');
  state.phase = 'idle'; $('start').disabled = false;
  $('status').textContent = '本地写盘接口可用。可以开始验证。';
  $('result').textContent = JSON.stringify(state.capabilities, null, 2);
} catch (error) { state.phase = 'error'; state.error = { name: error.name, message: error.message }; $('status').textContent = error.name + ': ' + error.message; }

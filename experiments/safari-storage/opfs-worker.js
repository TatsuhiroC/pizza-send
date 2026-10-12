import { sha256 } from '@noble/hashes/sha2.js';

let directory, handle, access, hash, written = 0, expectedSize = 0;
const hex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
const post = (id, data) => self.postMessage({ id, ok: true, data });
let queue = Promise.resolve();
self.onmessage = event => {
  const { id, type, data } = event.data;
  queue = queue.then(async () => {
    if (type === 'capabilities') {
      const root = await navigator.storage.getDirectory();
      const trial = await root.getFileHandle('pizzasend-capability-' + crypto.randomUUID(), { create: true });
      let sync = false;
      try {
        const probe = await trial.createSyncAccessHandle();
        try { probe.write(new Uint8Array([37]), { at: 0 }); probe.flush(); sync = probe.getSize() === 1; }
        finally { probe.close(); }
      } finally { await root.removeEntry(trial.name); }
      return post(id, { sync, estimate: await navigator.storage.estimate() });
    }
    if (type === 'begin') {
      const root = await navigator.storage.getDirectory();
      directory = await root.getDirectoryHandle(data.directory, { create: true });
      handle = await directory.getFileHandle(data.name, { create: true });
      access = await handle.createSyncAccessHandle(); access.truncate(0);
      written = 0; expectedSize = data.size; hash = sha256.create();
      return post(id, { size: expectedSize });
    }
    if (type === 'write') {
      const buffer = new Uint8Array(data);
      if (!access || !buffer.length || written + buffer.length > expectedSize) throw Error('Invalid write offset');
      // A filesystem write may return fewer bytes than requested.
      let offset = 0;
      while (offset < buffer.length) {
        const count = access.write(buffer.subarray(offset), { at: written + offset });
        if (!count) throw Error('Filesystem made no write progress');
        offset += count;
      }
      hash.update(buffer); written += buffer.length;
      if (written % 1048576 === 0 || written === expectedSize) access.flush();
      return post(id, { written });
    }
    if (type === 'finish') {
      if (written !== expectedSize) throw Error('Incomplete test file');
      access.flush(); access.close(); access = undefined;
      return post(id, { written, writeHash: hex(hash.digest()) });
    }
    if (type === 'verify') {
      const reader = await handle.createSyncAccessHandle();
      try {
        const size = reader.getSize(), digest = sha256.create(), block = new Uint8Array(1048576);
        let offset = 0, last = performance.now();
        while (offset < size) {
          const count = reader.read(block.subarray(0, Math.min(block.length, size - offset)), { at: offset });
          if (!count) throw Error('Filesystem made no read progress');
          digest.update(block.subarray(0, count)); offset += count;
          if (performance.now() - last > 250) {
            self.postMessage({ progress: { phase: 'verify', completed: offset, total: size } }); last = performance.now();
          }
        }
        return post(id, { size, readHash: hex(digest.digest()) });
      } finally { reader.close(); }
    }
    if (type === 'cancel') {
      access?.close(); access = undefined;
      return post(id, {});
    }
    throw Error('Unknown operation');
  }).catch(error => {
    try { access?.close(); } catch {} access = undefined;
    self.postMessage({ id, ok: false, error: { name: error.name, message: error.message } });
  });
};

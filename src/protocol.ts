import { sha256 } from '@noble/hashes/sha2.js';
import { createTemporarySession, beginTemporaryFile, writeTemporaryFile, finishTemporaryFile, completeTemporarySession, discardTemporaryPartial } from './received-storage';

export type FileInfo = { id: number; name: string; size: number; type: string };
export type Config = { signalUrl: string; iceServers: RTCIceServer[]; memoryLimitBytes: number };
export type TransferEvent = { type: string; data?: any };
type PickerWindow = Window & {
  showSaveFilePicker?: (options: any) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (options: any) => Promise<FileSystemDirectoryHandle>;
};
const hex = (b: Uint8Array) => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const bytes = (n: number) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
export function safeName(name: string): string {
  let clean = name.replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = '_' + clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 && clean.length - dot <= 20 ? clean.slice(dot) : '';
  const stem = extension ? clean.slice(0, dot) : clean;
  const encoder = new TextEncoder();
  let length = encoder.encode(extension).length, result = '';
  // Bound both UTF-16 and UTF-8 lengths, reserving space for collision prefixes.
  // Iterate code points so shortening cannot split an emoji surrogate pair.
  for (const character of stem) {
    const size = encoder.encode(character).length;
    if (result.length + character.length + extension.length > 180 || length + size > 240) break;
    result += character; length += size;
  }
  return result + extension || 'received-file';
}
export function validateManifest(value: unknown): FileInfo[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw Error('文件列表无效（最多 100 个文件）');
  let total = 0;
  const files = value.map((f, i) => {
    if (!f || f.id !== i || typeof f.name !== 'string' || f.name.length > 255 ||
        typeof f.type !== 'string' || f.type.length > 200 || !Number.isSafeInteger(f.size) || f.size < 0) throw Error('文件信息无效');
    total += f.size;
    return { id: i, name: safeName(f.name), type: f.type, size: f.size };
  });
  if (!Number.isSafeInteger(total)) throw Error('文件总大小超出支持范围');
  return files;
}
function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
export async function packDescription(d: RTCSessionDescriptionInit): Promise<string> {
  const input = new Blob([JSON.stringify({ v: 1, type: d.type, sdp: d.sdp })]);
  const compressed = await new Response(input.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return 'PS1.' + toBase64(new Uint8Array(compressed));
}
export async function unpackDescription(code: string, expected: 'offer' | 'answer'): Promise<RTCSessionDescriptionInit> {
  if (!code.startsWith('PS1.') || code.length > 120000) throw Error('这不是有效的 PizzaSend 配对码');
  const reader = new Blob([fromBase64(code.slice(4))]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 200000) throw Error('配对信息过大');
      parts.push(new Uint8Array(value));
    }
  } finally { await reader.cancel(); }
  const d = JSON.parse(await new Blob(parts).text());
  if (d.v !== 1 || d.type !== expected || typeof d.sdp !== 'string' || !d.sdp.startsWith('v=0')) throw Error('配对码类型不正确');
  return { type: d.type, sdp: d.sdp };
}
export async function signalKey(secret: string): Promise<CryptoKey> {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error('分享链接不完整');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g)!, n => parseInt(n, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(key: CryptoKey, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const packed = new Uint8Array(12 + encrypted.byteLength);
  packed.set(iv); packed.set(new Uint8Array(encrypted), 12);
  return toBase64(packed);
}
export async function unseal(key: CryptoKey, payload: string): Promise<any> {
  const packed = fromBase64(payload);
  const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
  return JSON.parse(new TextDecoder().decode(decoded));
}

class TransportInterrupted extends Error {}

export class Transfer {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  files: File[] = [];
  manifest: FileInfo[] = [];
  stopped = false;
  completed = false;
  recovering = false;
  private recovery?: () => void;
  private candidate?: (candidate: RTCIceCandidateInit | null) => void;
  get hasAccepted() { return this.accepted; }
  pairingStage(data: string) { if (!this.opened && !this.stopped) this.emit({ type: 'pairing', data }); }
  waitForReceiver() {
    this.opened = false; this.recovering = false;
    clearTimeout(this.recoveryTimer);
    this.pairingStage('等待接收方');
  }
  enableCandidates(callback: (candidate: RTCIceCandidateInit | null) => void) { this.candidate = callback; }
  private generation = 0;
  private resumedGeneration = -1;
  private opened = false;
  private lastSeen = Date.now();
  private heartbeat?: ReturnType<typeof setInterval>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private hashes = new Map<string, ReturnType<typeof sha256.create>>();
  private networkChanged = () => { if (this.opened && !this.completed) this.requestRecovery(); };
  private accepted = false;
  private accepting = false;
  private temporary?: string;
  private incoming?: { info: FileInfo; received: number; hash: ReturnType<typeof sha256.create>; parts: Uint8Array<ArrayBuffer>[]; writer?: FileSystemWritableFileStream; ack: number };
  private handles: FileSystemFileHandle[] = [];
  private receivedFiles = 0;
  private sent = 0;
  private acknowledged = 0;
  private received = 0;
  private started = 0;
  private lastProgress = 0;
  private waiters = new Set<() => void>();
  private queue = Promise.resolve();
  private receivingQueuedBytes = 0;
  private receivingQueuedMessages = 0;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private disconnectedTimer?: ReturnType<typeof setTimeout>;
  private fileConfirmed = -1;
  private outputs: { info: FileInfo; url: string }[] = [];
  constructor(public config: Config, public role: 'sender' | 'receiver', private emit: (event: TransferEvent) => void) {
    this.pc = this.createPeer();
  }
  enableRecovery(callback: () => void) {
    this.recovery = callback;
    window.addEventListener('offline', this.networkChanged);
    window.addEventListener('online', this.networkChanged);
  }
  private createPeer() {
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    pc.onicecandidate = event => {
      if (pc === this.pc && !this.stopped) this.candidate?.(event.candidate?.toJSON() ?? null);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc || this.stopped) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        clearTimeout(this.connectTimer); clearTimeout(this.disconnectedTimer);
        void this.describePath().catch(() => {});
      }
      if (state === 'failed') this.requestRecovery();
      if (state === 'disconnected') {
        clearTimeout(this.disconnectedTimer);
        this.disconnectedTimer = setTimeout(() => this.requestRecovery(), this.recovery ? 1500 : 12000);
      }
    };
    pc.ondatachannel = event => { if (pc === this.pc) this.attach(event.channel); };
    return pc;
  }
  requestRecovery() {
    if (this.stopped || this.completed) return;
    if (!this.recovery) { this.fail('连接已中断，请重新创建传输。'); return; }
    this.pauseRecovery();
    this.recovery();
  }
  pauseRecovery() {
    if (this.stopped || this.completed) return;
    if (!this.recovering) {
      this.recovering = true;
      this.emit({ type: 'recovering' });
      this.recoveryTimer = setTimeout(() => this.fail('暂时无法恢复直连，已等待两分钟。请检查双方网络，或重新创建传输。'), 120000);
    }
  }
  private transportQueue = Promise.resolve();
  replaceTransport() {
    const task = this.transportQueue.then(() => this.replaceTransportNow());
    this.transportQueue = task.catch(() => {});
    return task;
  }
  private async replaceTransportNow() {
    this.generation++;
    clearTimeout(this.connectTimer); clearTimeout(this.disconnectedTimer); clearInterval(this.heartbeat);
    const channel = this.channel;
    if (channel) channel.onclose = channel.onerror = channel.onmessage = channel.onopen = channel.onbufferedamountlow = null;
    this.pc.onconnectionstatechange = null; this.pc.ondatachannel = null; this.pc.onicecandidate = null;
    channel?.close(); this.pc.close(); this.channel = undefined; this.wake();
    // Finish writes already received on the old connection before reporting the offset.
    await this.queue;
    if (this.stopped) throw new TransportInterrupted();
    this.pc = this.createPeer();
    if (this.role === 'sender') this.attach(this.pc.createDataChannel('pizza-send-v2', { ordered: true }));
  }
  private restored() {
    const wasRecovering = this.recovering;
    this.recovering = false; this.lastSeen = Date.now(); clearTimeout(this.recoveryTimer);
    if (wasRecovering && this.accepted && !this.completed) this.emit({ type: 'resumed' });
    else if (wasRecovering && !this.completed) this.emit({ type: 'connected' });
    this.wake();
  }
  private async describePath() {
    const stats = await this.pc.getStats();
    stats.forEach(s => {
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = stats.get(s.selectedCandidatePairId);
        const local = pair && stats.get(pair.localCandidateId);
        const remote = pair && stats.get(pair.remoteCandidateId);
        if (local && remote) this.emit({ type: 'path', data: local.candidateType === 'host' && remote.candidateType === 'host' ? '设备直连' : '网络直连' });
      }
    });
  }
  private attach(channel: RTCDataChannel) {
    const generation = this.generation;
    this.channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onbufferedamountlow = () => this.wake();
    channel.onopen = () => {
      clearTimeout(this.connectTimer);
      this.lastSeen = Date.now();
      if (!this.opened) this.emit({ type: 'connected' });
      this.opened = true;
      if (this.role === 'sender') this.control({ type: 'manifest', files: this.manifest, version: 2 });
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.stopped || this.completed || this.recovering) return;
        if (Date.now() - this.lastSeen > 8000) { this.requestRecovery(); return; }
        try { this.control({ type: 'ping' }); } catch { this.requestRecovery(); }
      }, 2000);
    };
    channel.onmessage = event => {
      if (this.stopped || generation !== this.generation) return;
      this.lastSeen = Date.now();
      const binary = event.data instanceof ArrayBuffer;
      const size = binary ? event.data.byteLength : event.data.length * 2;
      if ((binary ? size : event.data.length) > 65536 || this.receivingQueuedBytes + size > 8 * 1048576 || this.receivingQueuedMessages >= 4096) { this.fail('接收队列超出安全限制'); return; }
      this.receivingQueuedBytes += size; this.receivingQueuedMessages++;
      this.queue = this.queue.then(() => this.handle(event.data, generation)).catch(e => this.fail(e.message)).finally(() => {
        this.receivingQueuedBytes -= size; this.receivingQueuedMessages--;
      });
    };
    channel.onclose = () => { this.requestRecovery(); this.wake(); };
    channel.onerror = () => this.requestRecovery();
  }
  prepare(files: File[]) {
    this.files = files;
    this.manifest = validateManifest(files.map((f, id) => ({ id, name: f.name, size: f.size, type: f.type })));
    this.attach(this.pc.createDataChannel('pizza-send-v2', { ordered: true }));
  }
  private control(message: unknown) {
    if (this.channel?.readyState !== 'open') throw new TransportInterrupted('连接已关闭');
    try { this.channel.send(JSON.stringify(message)); } catch { throw new TransportInterrupted('连接已关闭'); }
  }
  private reply(message: unknown, generation: number) {
    // A receipt can be lost while switching networks. The next resume handshake replaces it.
    if (!this.stopped && generation === this.generation && this.channel?.readyState === 'open') {
      try { this.control(message); } catch { this.requestRecovery(); }
    }
  }
  private wake() { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  private async waitFor(predicate: () => boolean, generation: number, timeout = 60000) {
    let deadline = Date.now() + timeout;
    while (true) {
      if (this.stopped || generation !== this.generation) throw new TransportInterrupted();
      if (this.channel?.readyState !== 'open') throw new TransportInterrupted('连接已关闭');
      if (!this.recovering && predicate()) return;
      if (this.recovering) deadline = Date.now() + timeout;
      else if (Date.now() > deadline) throw Error('对方长时间没有响应，请重新传输');
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.waiters.delete(done); resolve(); }, 250);
        const done = () => { clearTimeout(timer); resolve(); };
        this.waiters.add(done);
      });
    }
  }
  private progress(force = false) {
    const now = performance.now();
    if (!force && now - this.lastProgress < 180) return;
    this.lastProgress = now;
    const transferred = this.role === 'sender' ? this.acknowledged : this.received;
    const total = this.manifest.reduce((n, f) => n + f.size, 0);
    const elapsed = Math.max((now - this.started) / 1000, .001);
    this.emit({ type: 'progress', data: { transferred, total, seconds: elapsed, speed: transferred / elapsed } });
  }
  private async handle(data: string | ArrayBuffer, generation: number) {
    if (this.stopped) return;
    if (typeof data !== 'string') {
      const incoming = this.incoming;
      if (this.role !== 'receiver' || !this.accepted || !incoming || !data.byteLength || incoming.received + data.byteLength > incoming.info.size) throw Error('接收到不符合文件信息的数据');
      const chunk = new Uint8Array(data);
      const size = data.byteLength; // Worker transfer detaches this buffer after hashing.
      incoming.hash.update(chunk);
      if (incoming.writer) await incoming.writer.write(data);
      else if (this.temporary) await writeTemporaryFile(this.temporary, incoming.received, data);
      else incoming.parts.push(chunk);
      if (this.stopped) return;
      incoming.received += size; this.received += size; incoming.ack += size;
      if (incoming.ack >= 256 * 1024 || incoming.received === incoming.info.size) {
        this.reply({ type: 'ack', bytes: this.received }, generation); incoming.ack = 0;
      }
      this.progress(); return;
    }
    if (data.length > 65536) throw Error('控制信息过大');
    const message = JSON.parse(data);
    if (message.type === 'ping') { this.reply({ type: 'pong' }, generation); return; }
    if (message.type === 'pong') return;
    if (message.type === 'manifest' && this.role === 'receiver') {
      const manifest = validateManifest(message.files);
      if (this.manifest.length) {
        if (JSON.stringify(manifest) !== JSON.stringify(this.manifest)) throw Error('续传文件列表不一致');
        this.reply({ type: 'resume', file: this.receivedFiles, offset: this.incoming?.received || 0, bytes: this.received, accepted: this.accepted, complete: this.completed }, generation);
        this.restored();
      } else { this.manifest = manifest; this.restored(); this.emit({ type: 'manifest', data: this.manifest }); }
    } else if (message.type === 'resume' && this.role === 'sender') {
      if (!generation || this.resumedGeneration === generation) throw Error('重复或无效的续传信息');
      const { file, offset, bytes: received, accepted, complete } = message;
      const expected = this.manifest.slice(0, file).reduce((sum, info) => sum + info.size, 0) + offset;
      if (!Number.isInteger(file) || file < 0 || file > this.files.length || !Number.isSafeInteger(offset) || offset < 0 ||
          offset > (this.files[file]?.size || 0) || received !== expected || received > this.sent || received < this.acknowledged || file <= this.fileConfirmed ||
          typeof accepted !== 'boolean' || typeof complete !== 'boolean' || (this.accepted && !accepted) ||
          (complete && (file !== this.files.length || offset !== 0))) throw Error('续传位置无效');
      this.sent = this.acknowledged = received; this.fileConfirmed = file - 1; this.accepted = accepted;
      this.resumedGeneration = generation;
      this.restored(); this.progress(true);
      if (complete) { this.completed = true; clearInterval(this.heartbeat); this.emit({ type: 'done' }); }
      else if (accepted) this.startSending(file, offset);
    } else if (message.type === 'accept' && this.role === 'sender') {
      if (this.accepted) throw Error('重复的下载请求');
      this.accepted = true;
      this.startSending(0, 0);
    } else if (message.type === 'ack' && this.role === 'sender') {
      if (!Number.isSafeInteger(message.bytes) || message.bytes < this.acknowledged || message.bytes > this.sent) throw Error('接收确认信息无效');
      this.acknowledged = message.bytes; this.wake(); this.progress();
    } else if (message.type === 'file-start' && this.role === 'receiver') {
      const info = this.manifest[this.receivedFiles];
      const offset = message.offset ?? 0;
      if (!this.accepted || !info || message.id !== info.id || offset !== (this.incoming?.received || 0)) throw Error('文件顺序无效');
      if (!this.incoming) {
        const writer = this.handles[info.id] ? await this.handles[info.id].createWritable() : undefined;
        if (this.temporary) await beginTemporaryFile(this.temporary, info);
        if (this.stopped) { await writer?.abort().catch(() => {}); return; }
        this.incoming = { info, writer, received: 0, parts: [], hash: sha256.create(), ack: 0 };
      }
      this.emit({ type: 'file', data: info.name });
    } else if (message.type === 'file-end' && this.role === 'receiver') {
      const current = this.incoming;
      if (!current || message.id !== current.info.id || current.received !== current.info.size || hex(current.hash.digest()) !== message.hash) throw Error('文件完整性校验失败，请重新传输');
      if (current.writer) await current.writer.close();
      else if (this.temporary) await finishTemporaryFile(this.temporary, message.hash);
      else {
        const url = URL.createObjectURL(new Blob(current.parts, { type: 'application/octet-stream' }));
        this.outputs.push({ info: current.info, url });
        this.emit({ type: 'download', data: { info: current.info, url } });
      }
      if (this.stopped) return;
      this.incoming = undefined; this.receivedFiles++;
      this.reply({ type: 'file-saved', id: message.id }, generation);
    } else if (message.type === 'file-saved' && this.role === 'sender') {
      if (!Number.isInteger(message.id) || message.id !== this.fileConfirmed + 1 || message.id >= this.manifest.length) throw Error('文件保存确认无效');
      this.fileConfirmed = message.id; this.wake();
    } else if (message.type === 'done' && this.role === 'receiver') {
      if (this.incoming || this.receivedFiles !== this.manifest.length) throw Error('文件传输未完整结束');
      if (this.temporary) await completeTemporarySession(this.temporary);
      if (this.stopped) return;
      this.completed = true; clearInterval(this.heartbeat); this.progress(true); this.reply({ type: 'complete' }, generation);
      this.emit({ type: 'done' });
    } else if (message.type === 'complete' && this.role === 'sender') {
      if (this.fileConfirmed !== this.manifest.length - 1) throw Error('文件尚未保存完整');
      this.completed = true; clearInterval(this.heartbeat); this.progress(true); this.emit({ type: 'done' });
    } else if (message.type === 'cancel') { this.fail('对方已取消传输。'); }
    else throw Error('收到不支持的传输消息');
  }
  async accept() {
    if (this.accepted || this.accepting || this.stopped || !this.manifest.length) return;
    this.accepting = true;
    try {
      const picker = window as PickerWindow;
      const total = this.manifest.reduce((n, f) => n + f.size, 0);
      const handles: FileSystemFileHandle[] = [];
      if (picker.showSaveFilePicker && this.manifest.length === 1) {
        handles.push(await picker.showSaveFilePicker({ suggestedName: this.manifest[0].name }));
      } else if (picker.showDirectoryPicker && this.manifest.length > 1) {
        const directory = await picker.showDirectoryPicker({ mode: 'readwrite' });
        const used = new Set<string>();
        // Avoid overwriting existing files or colliding with directories, including
        // on case-insensitive filesystems. Commit handles only after a full selection.
        for await (const name of directory.keys()) used.add(name.toLowerCase());
        for (const info of this.manifest) {
          let name = info.name;
          let suffix = 0;
          while (used.has(name.toLowerCase())) name = ++suffix + '-' + info.name;
          used.add(name.toLowerCase()); handles.push(await directory.getFileHandle(name, { create: true }));
        }
      } else {
        const session = await createTemporarySession(total);
        if (this.stopped) { if (session) await discardTemporaryPartial(session); return; }
        this.temporary = session;
        if (!session && total > this.config.memoryLimitBytes) {
          throw Error('这个浏览器暂不支持大文件流式保存。请使用桌面 Chrome 或 Edge；当前接收上限为 ' + bytes(this.config.memoryLimitBytes));
        }
      }
      if (this.stopped) return;
      this.handles = handles;
      this.accepted = true; this.started = performance.now();
      this.emit({ type: 'started' }); this.control({ type: 'accept' });
    } finally { this.accepting = false; }
  }
  private startSending(file: number, offset: number) {
    const generation = this.generation;
    void this.sendFiles(file, offset, generation).catch(e => {
      if (this.stopped || generation !== this.generation) return;
      if (e instanceof TransportInterrupted) this.requestRecovery();
      else this.fail(e.message);
    });
  }
  private async sendFiles(firstFile: number, firstOffset: number, generation: number) {
    if (!this.started) { this.started = performance.now(); this.emit({ type: 'started' }); }
    const maxMessage = this.pc.sctp?.maxMessageSize || 65536;
    const chunkSize = Math.min(32768, maxMessage);
    if (chunkSize < 1024) throw Error('对方浏览器的数据通道限制过小');
    for (let id = firstFile; id < this.files.length; id++) {
      const file = this.files[id], start = id === firstFile ? firstOffset : 0;
      let hash = this.hashes.get(id + ':' + start)?.clone();
      if (!hash) {
        hash = sha256.create();
        for (let offset = 0; offset < start; offset += 1048576) {
          const prefix = await file.slice(offset, Math.min(offset + 1048576, start)).arrayBuffer();
          if (this.stopped || generation !== this.generation) throw new TransportInterrupted();
          hash.update(new Uint8Array(prefix));
        }
      }
      await this.waitFor(() => true, generation);
      this.control({ type: 'file-start', id, offset: start }); this.emit({ type: 'file', data: file.name });
      for (let offset = start; offset < file.size; offset += chunkSize) {
        await this.waitFor(() => this.channel!.bufferedAmount < 1048576 && this.sent - this.acknowledged < 4 * 1048576, generation);
        const buffer = await file.slice(offset, Math.min(offset + chunkSize, file.size)).arrayBuffer();
        if (this.stopped || generation !== this.generation) throw new TransportInterrupted();
        hash.update(new Uint8Array(buffer));
        try { this.channel!.send(buffer); } catch { throw new TransportInterrupted('连接已关闭'); }
        this.sent += buffer.byteLength;
        this.hashes.set(id + ':' + (offset + buffer.byteLength), hash.clone());
        if (this.hashes.size > 160) this.hashes.delete(this.hashes.keys().next().value!);
      }
      this.control({ type: 'file-end', id, hash: hex(hash.digest()) });
      await this.waitFor(() => this.fileConfirmed >= id, generation);
    }
    this.control({ type: 'done' });
  }
  async offer(trickle = false): Promise<RTCSessionDescriptionInit> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (!trickle) await this.gather();
    this.startTimeout();
    return this.pc.localDescription!.toJSON();
  }
  async answer(offer: RTCSessionDescriptionInit, trickle = false): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    if (!trickle) await this.gather();
    this.startTimeout();
    return this.pc.localDescription!.toJSON();
  }
  async finish(answer: RTCSessionDescriptionInit) { await this.pc.setRemoteDescription(answer); }
  private startTimeout() {
    if (this.channel?.readyState === 'open') return;
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => this.fail('未能建立直连。请让手机保持在发送页面，并检查 VPN 是否允许本地网络和 WebRTC；可先关闭双方 VPN 再试。'), 90000);
  }
  private async gather() {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.pc.removeEventListener('icegatheringstatechange', change); resolve(); };
      const change = () => { if (this.pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, 8000);
      this.pc.addEventListener('icegatheringstatechange', change);
    });
  }
  fail(message: string) {
    if (this.stopped || this.completed) return;
    this.emit({ type: 'error', data: message }); this.close(false);
  }
  close(notify = true) {
    if (notify && this.channel?.readyState === 'open' && !this.completed && (this.role === 'sender' || this.accepted)) {
      try { this.control({ type: 'cancel' }); } catch {}
    }
    this.stopped = true; clearTimeout(this.connectTimer); clearTimeout(this.disconnectedTimer); clearTimeout(this.recoveryTimer); clearInterval(this.heartbeat);
    window.removeEventListener('online', this.networkChanged); window.removeEventListener('offline', this.networkChanged);
    this.hashes.clear();
    void this.incoming?.writer?.abort().catch(() => {});
    if (this.temporary) {
      void discardTemporaryPartial(this.temporary).catch(() => {});
      this.temporary = undefined;
    }
    this.incoming = undefined; this.handles = []; this.files = [];
    this.channel?.close(); this.pc.close(); this.wake();
    for (const output of this.outputs) URL.revokeObjectURL(output.url);
  }
}

export class Signaling {
  private socket?: WebSocket;
  private queue = Promise.resolve();
  private sendQueue = Promise.resolve();
  private sequence = 0;
  private lastReceived = 0;
  private peerSession?: string;
  private allowNewPeer = false;
  expectNewPeer() { this.allowNewPeer = true; }
  private endpoint?: string;
  private role = '';
  private closed = false;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private failures = 0;
  private lastSeen = Date.now();
  private client = randomToken();
  constructor(private key: CryptoKey, private onMessage: (message: any) => Promise<void>, private onError: (message: string) => void) {}
  async connect(endpoint: string, room: string, role: string, token: string) {
    const url = new URL(endpoint);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.pathname = '/rooms/' + room;
    url.search = new URLSearchParams({ role, token, client: this.client }).toString();
    this.endpoint = url.toString(); this.role = role;
    await this.open();
  }
  private open(): Promise<void> {
    if (this.closed) return Promise.reject(Error('配对服务已断开'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const attempt = (async () => {
      const url = new URL(this.endpoint!);
      url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        if ([401, 409, 410].includes(response.status)) { this.closed = true; clearTimeout(this.retry); }
        throw Error(response.status === 409 ? '分享链接已被另一接收页面占用，请关闭原页面或创建新链接。' :
          response.status === 410 ? '分享链接已过期或发送方已结束，请创建新链接。' : '无法连接配对服务');
      }
      const state = await response.json();
      if (this.closed) throw Error('配对服务已断开');
      const socket = this.socket = new WebSocket(this.endpoint!);
      this.lastSeen = Date.now();
      // Install handlers before open; peer-ready may arrive immediately.
      socket.onmessage = event => {
        if (socket !== this.socket || this.closed) return;
        this.lastSeen = Date.now();
        this.queue = this.queue.then(async () => {
          const message = JSON.parse(event.data);
          if (message.type === 'keepalive') return;
          if (message.type === 'signal') {
            const decoded = await unseal(this.key, message.payload);
            if (typeof decoded.session !== 'string' || !/^[a-f0-9]{64}$/.test(decoded.session)) throw Error('配对信息无效');
            if (this.peerSession !== decoded.session) {
              if (this.peerSession && !this.allowNewPeer) throw Error('配对信息无效');
              this.peerSession = decoded.session; this.lastReceived = 0; this.allowNewPeer = false;
            }
            if (!Number.isInteger(decoded.sequence) || decoded.sequence <= this.lastReceived) throw Error('重复或无效的配对消息');
            this.lastReceived = decoded.sequence; await this.onMessage(decoded.message);
          } else await this.onMessage(message);
        }).catch(e => this.onError(e.message));
      };
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { socket.close(); reject(Error('配对服务连接超时')); }, 10000);
        socket.onopen = () => {
          clearTimeout(timeout);
          if (this.closed || socket !== this.socket) { socket.close(); reject(Error('配对服务已断开')); return; }
          this.failures = 0;
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastSeen > 30000) { socket.close(); return; }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'keepalive' }));
          }, 10000);
          this.queue = this.queue.then(() => this.onMessage({ type: 'signal-ready', peerPresent: state.peerPresent })).catch(e => this.onError(e.message));
          resolve();
        };
        socket.onerror = () => { clearTimeout(timeout); reject(Error('无法连接配对服务')); };
        socket.onclose = () => {
          clearTimeout(timeout);
          reject(Error('配对服务已断开'));
          if (socket !== this.socket || this.closed) return;
          clearInterval(this.heartbeat);
          this.onError('配对服务已断开；已建立的文件直连可以继续');
          this.scheduleRetry();
        };
      });
    })();
    this.connecting = attempt.finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private scheduleRetry() {
    clearTimeout(this.retry);
    if (this.closed) return;
    this.retry = setTimeout(() => {
      if (!this.closed) void this.open().catch(() => this.scheduleRetry());
    }, Math.min(1000 * 2 ** this.failures++, 8000));
  }
  async ready() {
    const deadline = Date.now() + 60000;
    while (!this.closed && Date.now() < deadline) {
      try { await this.open(); return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw Error('配对服务已断开');
  }
  async send(message: unknown) {
    const task = this.sendQueue.then(async () => {
      await this.ready();
      const payload = await seal(this.key, { session: this.client, sequence: ++this.sequence, message });
      if (this.socket?.readyState !== WebSocket.OPEN) throw Error('配对服务已断开');
      this.socket.send(JSON.stringify({ type: 'signal', payload }));
    });
    this.sendQueue = task.catch(() => {});
    return task;
  }
  close() {
    this.closed = true; clearTimeout(this.retry); clearInterval(this.heartbeat);
    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: this.role === 'sender' ? 'end' : 'leave' }));
      this.socket.onopen = null; this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null; this.socket.close();
    }
  }
}

// The sender is the only offerer, so simultaneous network changes cannot create
// competing offers. Each new connection has a monotonically increasing epoch.
export class AutoPair {
  private signal: Signaling;
  private epoch = 0;
  private revision = 0;
  private offered = false;
  private negotiating = false;
  private closed = false;
  private lastAttempt = 0;
  private finishedAt = 0;
  private lastOffer?: RTCSessionDescriptionInit;
  private lastAnswer?: RTCSessionDescriptionInit;
  private descriptionSent = false;
  private candidateHistory: (RTCIceCandidateInit | null)[] = [];
  private localCandidates: (RTCIceCandidateInit | null)[] = [];
  private remoteCandidates: (RTCIceCandidateInit | null)[] = [];
  private seenCandidates = new Set<string>();
  private candidateTimer?: ReturnType<typeof setTimeout>;
  private waitingTimer?: ReturnType<typeof setTimeout>;
  private retry: ReturnType<typeof setInterval>;
  constructor(private transfer: Transfer, key: CryptoKey, private onError: (message: string) => void) {
    this.signal = new Signaling(key, message => this.handle(message), onError);
    transfer.enableCandidates(candidate => {
      if (this.closed || this.candidateHistory.length >= 128) return;
      this.candidateHistory.push(candidate); this.localCandidates.push(candidate);
      this.scheduleCandidates();
    });
    transfer.enableRecovery(() => { void this.recover(); });
    this.retry = setInterval(() => {
      if (transfer.completed) {
        this.finishedAt ||= Date.now();
        if (Date.now() - this.finishedAt > 180000) this.close();
      } else if (transfer.recovering) void this.recover();
    }, 6000);
  }
  async connect(endpoint: string, room: string, role: string, token: string) {
    if (role === 'receiver') this.waitingTimer = setTimeout(() => {
      if (!this.offered) this.transfer.fail('发送方尚未响应。请让发送方回到网页并保持手机解锁，或创建新链接。');
    }, 90000);
    await this.signal.connect(endpoint, room, role, token);
  }
  private resetCandidates() {
    clearTimeout(this.candidateTimer); this.candidateTimer = undefined;
    this.descriptionSent = false; this.candidateHistory = []; this.localCandidates = []; this.remoteCandidates = []; this.seenCandidates.clear();
  }
  private scheduleCandidates() {
    if (!this.descriptionSent || this.candidateTimer || !this.localCandidates.length || this.closed) return;
    this.candidateTimer = setTimeout(() => {
      this.candidateTimer = undefined;
      const epoch = this.epoch, candidates = this.localCandidates.splice(0, 16);
      void this.signal.send({ type: 'candidates', epoch, candidates }).catch(() => {
        if (!this.closed && epoch === this.epoch) { this.localCandidates.unshift(...candidates); this.onError('配对服务已断开'); }
      }).finally(() => this.scheduleCandidates());
    }, 100);
  }
  private async sendDescription(type: 'offer' | 'answer', description: RTCSessionDescriptionInit) {
    await this.signal.send({ type, epoch: this.epoch, description });
    this.descriptionSent = true; this.scheduleCandidates();
  }
  private async applyCandidates() {
    const t = this.transfer;
    if (!t.pc.remoteDescription) return;
    for (const candidate of this.remoteCandidates.splice(0)) {
      const id = JSON.stringify(candidate);
      if (this.seenCandidates.has(id)) continue;
      await t.pc.addIceCandidate(candidate ?? undefined);
      this.seenCandidates.add(id);
    }
  }
  private async handle(message: any) {
    const t = this.transfer;
    if (this.closed || t.stopped) return;
    if (message.type === 'signal-ready') {
      if (!this.offered && t.role === 'receiver') t.pairingStage(message.peerPresent ? '找到发送方，正在交换连接信息' : '等待发送方回到页面');
    } else if (message.type === 'peer-ready') {
      if (t.role === 'sender' && !this.offered) {
        this.offered = true; this.negotiating = true;
        t.pairingStage('找到接收方，正在交换连接信息');
        try { this.lastOffer = await t.offer(true); await this.sendDescription('offer', this.lastOffer); }
        finally { this.negotiating = false; }
      } else if (t.role === 'sender' && this.lastOffer && !this.negotiating && !t.completed && t.channel?.readyState !== 'open') {
        // A signaling reconnect must resend the existing offer, not replace a
        // healthy connection that is still negotiating. Include late candidates.
        this.localCandidates = [...this.candidateHistory];
        await this.sendDescription('offer', t.pc.localDescription?.toJSON() ?? this.lastOffer);
      } else if (t.role === 'receiver' && this.lastAnswer && t.channel?.readyState !== 'open') {
        this.localCandidates = [...this.candidateHistory];
        await this.sendDescription('answer', t.pc.localDescription?.toJSON() ?? this.lastAnswer);
      } else if (t.recovering) void this.recover();
    } else if (message.type === 'restart-request' && t.role === 'sender') {
      t.requestRecovery();
      if (!this.negotiating && this.lastOffer) await this.sendDescription('offer', t.pc.localDescription?.toJSON() ?? this.lastOffer);
    } else if (message.type === 'offer' && t.role === 'receiver') {
      if (!Number.isInteger(message.epoch) || message.epoch < 0 || message.epoch < this.epoch) return;
      if (this.offered && message.epoch === this.epoch) {
        if (this.lastAnswer) await this.sendDescription('answer', t.pc.localDescription?.toJSON() ?? this.lastAnswer);
        return;
      }
      if (this.offered) { t.pauseRecovery(); this.resetCandidates(); await t.replaceTransport(); }
      clearTimeout(this.waitingTimer);
      this.offered = true; this.epoch = message.epoch;
      t.pairingStage('配对信息已交换，正在寻找直连路径');
      this.lastAnswer = await t.answer(message.description, true);
      await this.applyCandidates();
      await this.sendDescription('answer', this.lastAnswer);
    } else if (message.type === 'answer' && t.role === 'sender') {
      if (message.epoch === this.epoch && t.pc.signalingState === 'have-local-offer') {
        await t.finish(message.description); await this.applyCandidates();
        t.pairingStage('配对信息已交换，正在寻找直连路径');
      }
    } else if (message.type === 'candidates') {
      if (message.epoch !== this.epoch || !Array.isArray(message.candidates) || message.candidates.length > 16) return;
      if (this.seenCandidates.size + this.remoteCandidates.length + message.candidates.length > 128) throw Error('配对信息过大');
      for (const candidate of message.candidates) {
        if (candidate !== null && (typeof candidate !== 'object' || typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096)) throw Error('配对信息无效');
      }
      this.remoteCandidates.push(...message.candidates); await this.applyCandidates();
    } else if (message.type === 'receiver-left' && t.role === 'sender') {
      this.revision++; this.signal.expectNewPeer();
      if (t.hasAccepted) { t.fail('接收方已结束传输，请创建新链接。'); return; }
      this.negotiating = true;
      try {
        this.epoch++; this.offered = false; this.lastOffer = undefined; this.resetCandidates();
        await t.replaceTransport(); t.waitForReceiver();
      } finally { this.negotiating = false; }
    } else if (message.type === 'ended') {
      if (t.completed) this.close();
      else t.fail('对方已结束传输，或页面已关闭。');
    } else if (message.type === 'peer-left' && !t.completed) {
      if (!this.offered) t.pairingStage(t.role === 'receiver' ? '等待发送方回到页面' : '等待接收方');
      else t.requestRecovery();
    }
  }
  private async recover() {
    const t = this.transfer;
    if (this.closed || t.stopped || t.completed || this.negotiating || Date.now() - this.lastAttempt < 10000) return;
    this.negotiating = true;
    const revision = this.revision;
    try {
      await this.signal.ready();
      if (this.closed || t.stopped || revision !== this.revision) return;
      this.lastAttempt = Date.now();
      if (t.role === 'receiver') await this.signal.send({ type: 'restart-request' });
      else {
        this.epoch++; this.offered = true; this.lastOffer = undefined; this.resetCandidates();
        await t.replaceTransport();
        if (revision !== this.revision || this.closed || t.stopped) return;
        this.lastOffer = await t.offer(true);
        if (revision !== this.revision || this.closed || t.stopped) return;
        await this.sendDescription('offer', this.lastOffer);
      }
    } catch { /* Preserve the checkpoint and retry until the recovery deadline. */ }
    finally { this.negotiating = false; }
  }
  close() { this.closed = true; clearInterval(this.retry); clearTimeout(this.candidateTimer); clearTimeout(this.waitingTimer); this.signal.close(); }
}

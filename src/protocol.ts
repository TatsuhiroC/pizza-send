import { sha256 } from '@noble/hashes/sha2.js';

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
  return name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/^\.+$/, '_').slice(0, 180) || 'received-file';
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
  return crypto.subtle.importKey('raw', fromBase64(toBase64(Uint8Array.from(secret.match(/../g)!, n => parseInt(n, 16)))), 'AES-GCM', false, ['encrypt', 'decrypt']);
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

export class Transfer {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  files: File[] = [];
  manifest: FileInfo[] = [];
  stopped = false;
  completed = false;
  private accepted = false;
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
  private connectTimer?: ReturnType<typeof setTimeout>;
  private disconnectedTimer?: ReturnType<typeof setTimeout>;
  private fileConfirmed = -1;
  private outputs: { info: FileInfo; url: string }[] = [];
  constructor(public config: Config, public role: 'sender' | 'receiver', private emit: (event: TransferEvent) => void) {
    this.pc = new RTCPeerConnection({ iceServers: config.iceServers });
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') {
        clearTimeout(this.connectTimer); clearTimeout(this.disconnectedTimer);
        void this.describePath();
      }
      if (state === 'failed') this.fail('无法建立直连。请尝试同一 Wi-Fi 或更换网络；首版没有中继兜底。');
      if (state === 'disconnected') this.disconnectedTimer = setTimeout(() => this.fail('连接已中断，请重新创建传输。'), 12000);
    };
    this.pc.ondatachannel = event => this.attach(event.channel);
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
    this.channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onbufferedamountlow = () => this.wake();
    channel.onopen = () => {
      clearTimeout(this.connectTimer);
      this.emit({ type: 'connected' });
      if (this.role === 'sender') this.control({ type: 'manifest', files: this.manifest });
    };
    channel.onmessage = event => {
      const size = event.data instanceof ArrayBuffer ? event.data.byteLength : 0;
      if (size > 65536 || this.receivingQueuedBytes + size > 8 * 1048576) { this.fail('接收队列超出安全限制'); return; }
      this.receivingQueuedBytes += size;
      this.queue = this.queue.then(() => this.handle(event.data)).catch(e => this.fail(e.message)).finally(() => { this.receivingQueuedBytes -= size; });
    };
    channel.onclose = () => { if (!this.stopped && !this.completed) this.fail('对方已结束传输，或页面已关闭。'); this.wake(); };
    channel.onerror = () => this.fail('传输连接出现错误，请重新配对。');
  }
  prepare(files: File[]) {
    this.files = files;
    this.manifest = validateManifest(files.map((f, id) => ({ id, name: f.name, size: f.size, type: f.type })));
    this.attach(this.pc.createDataChannel('pizza-send-v1', { ordered: true }));
  }
  private control(message: unknown) {
    if (this.channel?.readyState !== 'open') throw Error('连接已关闭');
    this.channel.send(JSON.stringify(message));
  }
  private wake() { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  private async waitFor(predicate: () => boolean, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (this.stopped || this.channel?.readyState !== 'open') throw Error('传输已结束');
      if (Date.now() > deadline) throw Error('对方长时间没有响应，请重新传输');
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
  private async handle(data: string | ArrayBuffer) {
    if (this.stopped) return;
    if (typeof data !== 'string') {
      const incoming = this.incoming;
      if (this.role !== 'receiver' || !this.accepted || !incoming || !data.byteLength || incoming.received + data.byteLength > incoming.info.size) throw Error('接收到不符合文件信息的数据');
      const chunk = new Uint8Array(data);
      incoming.hash.update(chunk);
      if (incoming.writer) await incoming.writer.write(data);
      else incoming.parts.push(chunk);
      incoming.received += data.byteLength; this.received += data.byteLength; incoming.ack += data.byteLength;
      if (incoming.ack >= 256 * 1024 || incoming.received === incoming.info.size) {
        this.control({ type: 'ack', bytes: this.received }); incoming.ack = 0;
      }
      this.progress(); return;
    }
    if (data.length > 65536) throw Error('控制信息过大');
    const message = JSON.parse(data);
    if (message.type === 'manifest' && this.role === 'receiver') {
      if (this.manifest.length) throw Error('重复的文件列表');
      this.manifest = validateManifest(message.files); this.emit({ type: 'manifest', data: this.manifest });
    } else if (message.type === 'accept' && this.role === 'sender') {
      if (this.accepted) throw Error('重复的下载请求');
      this.accepted = true;
      void this.sendFiles().catch(e => this.fail(e.message));
    } else if (message.type === 'ack' && this.role === 'sender') {
      if (!Number.isSafeInteger(message.bytes) || message.bytes < this.acknowledged || message.bytes > this.sent) throw Error('接收确认信息无效');
      this.acknowledged = message.bytes; this.wake(); this.progress();
    } else if (message.type === 'file-start' && this.role === 'receiver') {
      const info = this.manifest[this.receivedFiles];
      if (!this.accepted || this.incoming || !info || message.id !== info.id) throw Error('文件顺序无效');
      const writer = this.handles[info.id] ? await this.handles[info.id].createWritable() : undefined;
      this.incoming = { info, writer, received: 0, parts: [], hash: sha256.create(), ack: 0 };
      this.emit({ type: 'file', data: info.name });
    } else if (message.type === 'file-end' && this.role === 'receiver') {
      const current = this.incoming;
      if (!current || message.id !== current.info.id || current.received !== current.info.size || hex(current.hash.digest()) !== message.hash) throw Error('文件完整性校验失败，请重新传输');
      if (current.writer) await current.writer.close();
      else {
        const url = URL.createObjectURL(new Blob(current.parts, { type: 'application/octet-stream' }));
        this.outputs.push({ info: current.info, url });
        this.emit({ type: 'download', data: { info: current.info, url } });
      }
      this.incoming = undefined; this.receivedFiles++;
      this.control({ type: 'file-saved', id: message.id });
    } else if (message.type === 'file-saved' && this.role === 'sender') {
      if (!Number.isInteger(message.id) || message.id !== this.fileConfirmed + 1 || message.id >= this.manifest.length) throw Error('文件保存确认无效');
      this.fileConfirmed = message.id; this.wake();
    } else if (message.type === 'done' && this.role === 'receiver') {
      if (this.incoming || this.receivedFiles !== this.manifest.length) throw Error('文件传输未完整结束');
      this.completed = true; this.progress(true); this.control({ type: 'complete' });
      this.emit({ type: 'done' });
    } else if (message.type === 'complete' && this.role === 'sender') {
      if (this.fileConfirmed !== this.manifest.length - 1) throw Error('文件尚未保存完整');
      this.completed = true; this.progress(true); this.emit({ type: 'done' });
    } else if (message.type === 'cancel') { this.fail('对方已取消传输。'); }
    else throw Error('收到不支持的传输消息');
  }
  async accept() {
    if (this.accepted || !this.manifest.length) return;
    const picker = window as PickerWindow;
    const total = this.manifest.reduce((n, f) => n + f.size, 0);
    if (picker.showSaveFilePicker && this.manifest.length === 1) {
      this.handles = [await picker.showSaveFilePicker({ suggestedName: this.manifest[0].name })];
    } else if (picker.showDirectoryPicker && this.manifest.length > 1) {
      const directory = await picker.showDirectoryPicker({ mode: 'readwrite' });
      const used = new Set<string>();
      for (const info of this.manifest) {
        let name = info.name;
        while (used.has(name)) name = info.id + '-' + name;
        used.add(name); this.handles.push(await directory.getFileHandle(name, { create: true }));
      }
    } else if (total > this.config.memoryLimitBytes) {
      throw Error('这个浏览器暂不支持大文件流式保存。请使用桌面 Chrome 或 Edge；当前接收上限为 ' + bytes(this.config.memoryLimitBytes));
    }
    if (this.stopped) return;
    this.accepted = true; this.started = performance.now();
    this.emit({ type: 'started' }); this.control({ type: 'accept' });
  }
  private async sendFiles() {
    this.started = performance.now(); this.emit({ type: 'started' });
    const maxMessage = this.pc.sctp?.maxMessageSize || 65536;
    const chunkSize = Math.min(32768, maxMessage);
    if (chunkSize < 1024) throw Error('对方浏览器的数据通道限制过小');
    for (let id = 0; id < this.files.length; id++) {
      const file = this.files[id]; const hash = sha256.create();
      this.control({ type: 'file-start', id }); this.emit({ type: 'file', data: file.name });
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        await this.waitFor(() => this.channel!.bufferedAmount < 1048576 && this.sent - this.acknowledged < 4 * 1048576);
        const buffer = await file.slice(offset, Math.min(offset + chunkSize, file.size)).arrayBuffer();
        if (this.stopped) throw Error('传输已取消');
        hash.update(new Uint8Array(buffer));
        this.channel!.send(buffer); this.sent += buffer.byteLength;
      }
      this.control({ type: 'file-end', id, hash: hex(hash.digest()) });
      await this.waitFor(() => this.fileConfirmed >= id);
    }
    this.control({ type: 'done' });
  }
  async offer(): Promise<RTCSessionDescriptionInit> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gather(); this.startTimeout();
    return this.pc.localDescription!.toJSON();
  }
  async answer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gather(); this.startTimeout();
    return this.pc.localDescription!.toJSON();
  }
  async finish(answer: RTCSessionDescriptionInit) { await this.pc.setRemoteDescription(answer); }
  private startTimeout() {
    if (this.channel?.readyState === 'open') return;
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => this.fail('连接等待超时。请确认对方页面仍然打开，或尝试同一 Wi-Fi。'), 90000);
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
    if (notify && this.channel?.readyState === 'open' && !this.completed) {
      try { this.control({ type: 'cancel' }); } catch {}
    }
    this.stopped = true; clearTimeout(this.connectTimer); clearTimeout(this.disconnectedTimer);
    void this.incoming?.writer?.abort().catch(() => {});
    this.incoming = undefined; this.handles = []; this.files = [];
    this.channel?.close(); this.pc.close(); this.wake();
    for (const output of this.outputs) URL.revokeObjectURL(output.url);
  }
}

export class Signaling {
  private socket?: WebSocket;
  private queue = Promise.resolve();
  private sequence = 0;
  private lastReceived = 0;
  constructor(private key: CryptoKey, private onMessage: (message: any) => Promise<void>, private onError: (message: string) => void) {}
  async connect(endpoint: string, room: string, role: string, token: string) {
    const url = new URL(endpoint);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.pathname = '/rooms/' + room;
    url.search = new URLSearchParams({ role, token }).toString();
    const socket = this.socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(Error('配对服务连接超时')); }, 15000);
      socket.onopen = () => { clearTimeout(timeout); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(Error('无法连接配对服务')); };
      socket.onclose = () => { clearTimeout(timeout); reject(Error('配对服务拒绝连接')); };
    });
    socket.onmessage = event => {
      this.queue = this.queue.then(async () => {
        const message = JSON.parse(event.data);
        if (message.type === 'signal') {
          const decoded = await unseal(this.key, message.payload);
          if (!Number.isInteger(decoded.sequence) || decoded.sequence <= this.lastReceived) throw Error('重复或无效的配对消息');
          this.lastReceived = decoded.sequence; await this.onMessage(decoded.message);
        } else await this.onMessage(message);
      }).catch(e => this.onError(e.message));
    };
    socket.onerror = () => this.onError('配对服务连接异常');
    socket.onclose = () => this.onError('配对服务已断开；已建立的文件直连可以继续');
  }
  async send(message: unknown) {
    const payload = await seal(this.key, { sequence: ++this.sequence, message });
    if (this.socket?.readyState !== WebSocket.OPEN) throw Error('配对服务已断开');
    this.socket.send(JSON.stringify({ type: 'signal', payload }));
  }
  close() {
    if (this.socket) { this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null; this.socket.close(); }
  }
}


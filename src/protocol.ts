import './browser-compat';
import { PairingConnectionError, PairingResponseError, retryInitialPairing, retryPairingRequest, ticketURL } from './security';
import { safeName } from './file-name';
import { localPeerInfo, readPeerInfo, type PeerInfo } from './peer-info';
export { safeName } from './file-name';
import { readSource, SourceReadError } from './source-files';
import { sha256 } from '@noble/hashes/sha2.js';
import { createFileHash, type FileHash } from './file-hash';
import { downloadType } from './download';
import { TransferFlow } from './transfer-flow';
import { StreamChannel, type DataChannel } from './stream-channel';
import { StreamCipher } from './stream-cipher';
import { StandbyTransport, standbyNonce } from './standby-transport';
import { StreamFallback, type RouteState, type TransferRoute } from './stream-fallback';
import { watchConnectionDiagnostics, type DiagnosticHandle } from './connection-diagnostics';
import { COMPRESSION, BLOCK_BYTES, SAMPLE_BYTES, SlowLink, compressionEstimate, sampleCompression, supportsCompression, gzip, gunzip, type CompressionSample, type CompressionStatus } from './compression';
import { createTemporarySession, beginTemporaryFile, writeTemporaryFile, finishTemporaryFile, completeTemporarySession, discardTemporaryPartial } from './received-storage';

export type FileInfo = { id: number; name: string; size: number; type: string };
export type Config = { signalUrl: string; iceServers: RTCIceServer[]; memoryLimitBytes: number };
export type TransferEvent = { type: string; data?: any };
type PickerWindow = Window & {
  showSaveFilePicker?: (options: any) => Promise<FileSystemFileHandle>;
};
const ACK_BYTES = 256 * 1024;
const hex = (b: Uint8Array) => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const bytes = (n: number) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
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
function requireManualCompression() {
  if (!supportsCompression()) throw Error('当前浏览器不支持手动配对码，请使用分享链接或更新浏览器。');
}
export async function packDescription(d: RTCSessionDescriptionInit): Promise<string> {
  requireManualCompression();
  const input = new Blob([JSON.stringify({ v: 1, type: d.type, sdp: d.sdp })]);
  const compressed = await new Response(input.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return 'PS1.' + toBase64(new Uint8Array(compressed));
}
export async function unpackDescription(code: string, expected: 'offer' | 'answer'): Promise<RTCSessionDescriptionInit> {
  if (!code.startsWith('PS1.') || code.length > 120000) throw Error('这不是有效的 PizzaSend 配对码');
  requireManualCompression();
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
  private nativePeer?: RTCPeerConnection;
  get pc(): RTCPeerConnection {
    if (!this.nativePeer) throw Error('当前浏览器不支持直连，请使用加密转发或新版浏览器。');
    return this.nativePeer;
  }
  set pc(value: RTCPeerConnection) { this.nativePeer = value; }
  get directSupported() { return !!this.nativePeer; }
  channel?: DataChannel;
  private streamTransport = false;
  private standby?: { route: TransferRoute; transport: StandbyTransport };
  private standbyEnabled = false;
  enableStandby(enabled: boolean) { this.standbyEnabled = enabled; if (!enabled) { this.standby?.transport.close(); this.standby = undefined; } }
  hasStandby(route: TransferRoute) { return this.standby?.route === route && this.standby.transport.open; }
  probeStandby(route: TransferRoute) { return this.hasStandby(route) ? this.standby!.transport.probe() : Promise.resolve(false); }
  get transportConnected() { return this.channel?.readyState === 'open' && (this.streamTransport || this.nativePeer?.connectionState === 'connected'); }
  files: File[] = [];
  manifest: FileInfo[] = [];
  stopped = false;
  completed = false;
  recovering = false;
  private recovery?: () => void;
  private candidate?: (candidate: RTCIceCandidateInit | null) => void;
  private sourceFailure?: () => Promise<void>;
  private failing = false;
  private failureTimer?: ReturnType<typeof setTimeout>;
  get reportingSourceFailure() { return this.failing; }
  get hasAccepted() { return this.accepted; }
  get saveMode(): 'device' | 'disk' | 'memory' { return this.handles.length ? 'device' : this.temporary ? 'disk' : 'memory'; }
  get temporarySession() { return this.temporary; }
  pairingStage(data: string) { if (!this.opened && !this.stopped) this.emit({ type: 'pairing', data }); }
  waitForReceiver() {
    this.opened = false; this.recovering = false;
    clearTimeout(this.recoveryTimer);
    this.pairingStage('等待接收方');
  }
  enableCandidates(callback: (candidate: RTCIceCandidateInit | null) => void) { this.candidate = callback; }
  enableSourceFailure(callback: () => Promise<void>) { this.sourceFailure = callback; }
  private generation = 0;
  private sourceReads = new AbortController();
  private resumedGeneration = -1;
  private opened = false;
  private lastSeen = Date.now();
  private localHidden = document.hidden;
  private sourceResumedAt = -Infinity;
  private deferSourceTimeout = () => {
    const now = Date.now();
    if (this.localHidden && now < this.localBackgroundUntil) return Math.min(5000, this.localBackgroundUntil - now);
    return Math.max(0, this.sourceResumedAt + 15000 - now);
  };
  private localBackgroundUntil = 0;
  private peerHidden = false;
  private peerBackgroundUntil = 0;
  private backgroundSupport = false;
  private activityRevision = 0;
  private visibilityChanged = () => {
    if (this.stopped || this.completed) return;
    this.localHidden = document.hidden;
    this.localBackgroundUntil = this.localHidden ? Date.now() + 10 * 60 * 1000 : 0;
    this.activityRevision++;
    this.resetCompressionAdvice();
    this.reportVisibility();
    if (!this.localHidden) {
      this.sourceResumedAt = Date.now();
      this.lastSeen = Date.now();
      if (this.role === 'sender') this.flow.reset(this.acknowledged);
      if (this.recovering) this.armRecoveryTimeout();
      if (this.connectTimer && this.channel?.readyState !== 'open') this.startTimeout();
      if (this.opened && (this.channel?.readyState !== 'open' || !this.streamTransport && ['failed', 'disconnected', 'closed'].includes(this.pc.connectionState))) this.requestRecovery();
    }
    this.wake();
  };
  resumePage() { if (!document.hidden) this.visibilityChanged(); }
  private get backgroundDeadline() { return Math.max(this.localBackgroundUntil, this.peerBackgroundUntil); }
  private get waitingInBackground() { return Date.now() < this.backgroundDeadline; }
  private reportVisibility() {
    if (this.backgroundSupport && this.channel?.readyState === 'open') {
      try { this.control({ type: 'visibility', hidden: this.localHidden }); } catch {}
    }
  }
  private scheduleFailure(kind: 'connectTimer' | 'recoveryTimer', delay: number, message: string) {
    clearTimeout(this[kind]);
    this[kind] = setTimeout(() => {
      if (this.stopped || this.completed) return;
      const remaining = this.backgroundDeadline - Date.now();
      if (remaining > 0) { this.scheduleFailure(kind, Math.min(remaining, 5000), message); return; }
      this.fail(this.localHidden || this.peerHidden ? '后台等待已超过 10 分钟，请回到双方页面重新创建传输。' : message);
    }, delay);
  }
  private armRecoveryTimeout() {
    this.scheduleFailure('recoveryTimer', 120000, '暂时无法恢复直连，已等待两分钟。请检查双方网络，或重新创建传输。');
  }
  private heartbeat?: ReturnType<typeof setInterval>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private hashes = new Map<string, ReturnType<typeof sha256.create>>();
  private networkChanged = () => { if (this.opened && !this.completed) this.requestRecovery(); };
  private accepted = false;
  private accepting = false;
  private temporary?: string;
  private incoming?: { info: FileInfo; received: number; hash: FileHash; parts: Uint8Array<ArrayBuffer>[]; writer?: FileSystemWritableFileStream };
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
  private pendingBinary: ArrayBuffer[] = [];
  private pendingBinaryBytes = 0;
  private binaryTimer?: ReturnType<typeof setTimeout>;
  private flow = new TransferFlow();
  private compressionSupport = false;
  private compressionFile = -1;
  private compressionWireSpeed = 0;
  private compressionDecodeBps = 0;
  private sendingFile = -1;
  private sendingOffset = 0;
  private compressionStatus: CompressionStatus = { active: false };
  private slowLink = new SlowLink();
  private sampledFiles = new Set<number>();
  private dismissedCompressionFiles = new Set<number>();
  private probing = false;
  private probeAt = -Infinity;
  private receivedProbeAt = -Infinity;
  private probeSequence = 0;
  private probe?: { id: number; file: number; sample: CompressionSample; decompressBps?: number; basePerByte?: number; generation: number };
  private encodedBlock?: { size: number; raw: number; received: number; chunks: Uint8Array<ArrayBuffer>[] };
  private readBytes = 0;
  private readMilliseconds = 0;
  private writeBytes = 0;
  private writeMilliseconds = 0;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private disconnectedTimer?: ReturnType<typeof setTimeout>;
  private fileConfirmed = -1;
  private outputs: { info: FileInfo; url: string }[] = [];
  private diagnostics?: DiagnosticHandle;
  routeProgress() {
    return { bytes: this.role === 'sender' ? this.acknowledged : this.received,
      total: this.manifest.reduce((n, file) => n + file.size, 0),
      active: this.accepted && !this.localHidden && !this.peerHidden && !this.stopped && !this.completed,
      hidden: this.localHidden || this.peerHidden };
  }
  reportRoute(state: RouteState) { if (!this.stopped && !this.completed) this.emit({ type: 'route', data: state }); }
  reportPeerInfo(data: PeerInfo) { if (!this.stopped && !this.completed) this.emit({ type: 'peer-info', data }); }
  constructor(public config: Config, public role: 'sender' | 'receiver', private emit: (event: TransferEvent) => void) {
    if (typeof RTCPeerConnection === 'function') {
      try { this.pc = this.createPeer(); } catch { /* Restricted browsers can still use authenticated encrypted relay. */ }
    }
    if (this.localHidden) this.localBackgroundUntil = Date.now() + 10 * 60 * 1000;
    document.addEventListener('visibilitychange', this.visibilityChanged);
    this.diagnostics = watchConnectionDiagnostics(() => ({
      pc: this.nativePeer, role: this.role, generation: this.generation, started: this.started, sent: this.sent, acknowledged: this.acknowledged, received: this.received,
      buffered: this.channel?.bufferedAmount || 0, queued: this.receivingQueuedBytes, window: this.flow.windowBytes,
      sourceBytes: this.readBytes, sourceMs: this.readMilliseconds, sinkBytes: this.writeBytes, sinkMs: this.writeMilliseconds,
      completed: this.completed, stopped: this.stopped, recovering: this.recovering, hidden: this.localHidden, peerHidden: this.peerHidden,
      transport: this.streamTransport ? 'websocket' : 'webrtc', connectionOpen: this.transportConnected
    }));
  }
  enableRecovery(callback: () => void) {
    this.recovery = callback;
    window.addEventListener('offline', this.networkChanged);
    window.addEventListener('online', this.networkChanged);
  }
  private createPeer() {
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    if (typeof pc.createDataChannel !== 'function') { pc.close(); throw Error('WebRTC data channels unavailable'); }
    this.bindPeer(pc);
    return pc;
  }
  private bindPeer(pc: RTCPeerConnection) {
    pc.onicecandidate = event => {
      if (pc === this.nativePeer && !this.stopped) this.candidate?.(event.candidate?.toJSON() ?? null);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== this.nativePeer || this.stopped) return;
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
    pc.ondatachannel = event => { if (pc === this.nativePeer) this.attach(event.channel); };
  }
  requestRecovery() {
    if (this.stopped || this.completed || this.failing) return;
    if (!this.recovery) { this.fail('连接已中断，请重新创建传输。'); return; }
    this.pauseRecovery();
    this.recovery();
  }
  pauseRecovery() {
    if (this.stopped || this.completed) return;
    if (!this.recovering) {
      this.recovering = true;
      this.resetCompressionAdvice();
      this.emit({ type: 'recovering' });
      this.armRecoveryTimeout();
    }
  }
  private transportQueue = Promise.resolve();
  replaceTransport(stream?: StreamChannel, reuse?: TransferRoute) {
    const task = this.transportQueue.then(() => this.replaceTransportNow(stream, reuse));
    this.transportQueue = task.catch(() => {});
    return task;
  }
  private async replaceTransportNow(stream?: StreamChannel, reuse?: TransferRoute) {
    const spare = reuse && this.standby?.route === reuse && this.standby.transport.open ? this.standby.transport : undefined;
    if (reuse && !spare) throw Error('备用连接已失效');
    if (spare) { spare.take(); this.standby = undefined; }
    const route = stream || reuse === 'stream' ? 'stream' : 'direct';
    const wasStream = this.streamTransport;
    this.generation++; this.sourceReads.abort(); this.sourceReads = new AbortController();
    clearTimeout(this.connectTimer); clearTimeout(this.disconnectedTimer); clearInterval(this.heartbeat);
    const channel = this.channel;
    if (channel) channel.onclose = channel.onerror = channel.onmessage = channel.onopen = channel.onbufferedamountlow = null;
    const pc = this.nativePeer;
    if (pc) { pc.onconnectionstatechange = null; pc.ondatachannel = null; pc.onicecandidate = null; }
    if (this.standbyEnabled && channel && channel.readyState === 'open' && (wasStream || pc?.connectionState === 'connected') && (wasStream ? 'stream' : 'direct') !== route) {
      this.standby?.transport.close();
      this.standby = { route: wasStream ? 'stream' : 'direct', transport: new StandbyTransport(channel, wasStream ? undefined : pc) };
    } else channel?.close();
    if (pc && pc !== spare?.pc && pc !== this.standby?.transport.pc) pc.close();
    this.channel = undefined; this.wake();
    // Finish writes already received on the old connection before reporting the offset.
    this.flushBinary(this.generation - 1);
    await this.queue;
    this.encodedBlock = undefined;
    this.resetCompressionAdvice();
    if (this.stopped) { spare?.close(); throw new TransportInterrupted(); }
    this.streamTransport = route === 'stream';
    const ready = stream || spare?.channel;
    if (ready) {
      if (spare?.pc) { this.pc = spare.pc; this.bindPeer(this.pc); }
      this.attach(ready);
      // A candidate is opened and tested before replacing the old transport.
      queueMicrotask(() => { if (!this.stopped && this.channel === ready && ready.readyState === 'open') ready.onopen?.(new Event('open')); });
      this.emit({ type: 'path', data: this.streamTransport ? '加密服务器转发' : '网络直连' });
    } else {
      if (!this.directSupported) throw Error('当前浏览器不支持直连，请使用加密转发或新版浏览器。');
      this.pc = this.createPeer();
      if (this.role === 'sender') this.attach(this.pc.createDataChannel('pizza-send-v2', { ordered: true }));
    }
  }
  private restored() {
    const wasRecovering = this.recovering;
    this.recovering = false; this.lastSeen = Date.now(); clearTimeout(this.recoveryTimer);
    if (wasRecovering && this.accepted && !this.completed) this.emit({ type: 'resumed' });
    else if (wasRecovering && !this.completed) this.emit({ type: 'connected' });
    this.wake();
  }
  private async describePath() {
    const pc = this.pc, generation = this.generation;
    const stats = await pc.getStats();
    if (this.stopped || pc !== this.pc || generation !== this.generation || this.streamTransport) return;
    stats.forEach(s => {
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = stats.get(s.selectedCandidatePairId);
        const local = pair && stats.get(pair.localCandidateId);
        const remote = pair && stats.get(pair.remoteCandidateId);
        if (local && remote) this.emit({ type: 'path', data: '网络直连' });
      }
    });
  }
  private attach(channel: DataChannel) {
    const generation = this.generation;
    this.channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onbufferedamountlow = () => this.wake();
    channel.onopen = () => {
      clearTimeout(this.connectTimer);
      this.lastSeen = Date.now();
      if (!this.opened) this.emit({ type: 'connected' });
      this.opened = true;
      if (this.role === 'sender') this.control({ type: 'manifest', files: this.manifest, version: 2, backgroundSupport: true,
        ...(this.generation ? { resumeRequested: true } : {}), compression: supportsCompression() ? COMPRESSION : undefined });
      this.reportVisibility();
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.stopped || this.completed || this.recovering) return;
        if (Date.now() - this.lastSeen > 8000 && !this.waitingInBackground) { this.requestRecovery(); return; }
        try { const metrics = this.diagnostics?.packet(); this.control({ type: 'ping', ...(metrics ? { metrics } : {}) }); } catch { this.requestRecovery(); }
      }, 2000);
    };
    let queuedBinaryBytes = this.received, lastBinaryAt = 0;
    channel.onmessage = event => {
      if (this.stopped || generation !== this.generation) return;
      this.lastSeen = Date.now();
      const binary = event.data instanceof ArrayBuffer;
      const size = binary ? event.data.byteLength : event.data.length * 2;
      if ((binary ? size : event.data.length) > 65536 || this.receivingQueuedBytes + size > 8 * 1048576 || this.receivingQueuedMessages >= 4096) { this.fail('接收队列超出安全限制'); return; }
      this.receivingQueuedBytes += size; this.receivingQueuedMessages++;
      if (binary) {
        const now = performance.now(), sparse = now - lastBinaryAt >= 1;
        lastBinaryAt = now;
        if (this.pendingBinaryBytes + size > 256 * 1024) this.flushBinary(generation);
        // Timed short writes must not push each next receipt farther away.
        // Align batches with cumulative receipt boundaries; handle() still
        // acknowledges only after the actual write succeeds.
        const before = Math.floor(queuedBinaryBytes / ACK_BYTES);
        queuedBinaryBytes += size;
        this.pendingBinary.push(event.data); this.pendingBinaryBytes += size;
        if (sparse || Math.floor(queuedBinaryBytes / ACK_BYTES) > before || this.pendingBinaryBytes >= 256 * 1024) this.flushBinary(generation);
        else if (!this.binaryTimer) this.binaryTimer = setTimeout(() => this.flushBinary(generation), 4);
        return;
      }
      this.flushBinary(generation);
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
    if (this.nativePeer) {
      const pc = this.nativePeer;
      let channel: RTCDataChannel;
      try { channel = pc.createDataChannel('pizza-send-v2', { ordered: true }); }
      catch {
        pc.onicecandidate = pc.onconnectionstatechange = pc.ondatachannel = null;
        pc.close(); this.nativePeer = undefined; return;
      }
      this.attach(channel);
    }
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
  private flushBinary(generation: number) {
    clearTimeout(this.binaryTimer); this.binaryTimer = undefined;
    if (!this.pendingBinary.length) return;
    const chunks = this.pendingBinary, size = this.pendingBinaryBytes;
    this.pendingBinary = []; this.pendingBinaryBytes = 0;
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      // A compressed payload may be followed immediately by plain chunks, with
      // no intervening control message. Preserve the original message bounds
      // while a block is open; merging them would treat the tail as gzip bytes.
      if (this.encodedBlock) {
        for (const chunk of chunks) await this.handle(chunk, generation);
        return;
      }
      const buffer = chunks.length === 1 ? chunks[0] : new ArrayBuffer(size);
      if (chunks.length > 1) {
        const merged = new Uint8Array(buffer); let offset = 0;
        for (const chunk of chunks) { merged.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
      }
      return this.handle(buffer, generation);
    }).catch(e => this.fail(e.message)).finally(() => {
      this.receivingQueuedBytes -= size; this.receivingQueuedMessages -= chunks.length;
    });
  }
  private async waitFor(predicate: () => boolean, generation: number, timeout = 60000, poll = () => 250) {
    let deadline = Date.now() + timeout;
    let activity = this.activityRevision;
    while (true) {
      if (this.stopped || generation !== this.generation) throw new TransportInterrupted();
      if (this.channel?.readyState !== 'open') throw new TransportInterrupted('连接已关闭');
      if (!this.recovering && predicate()) return;
      if (this.recovering || this.waitingInBackground || activity !== this.activityRevision) { deadline = Date.now() + timeout; activity = this.activityRevision; }
      else if (Date.now() > deadline) throw Error('对方长时间没有响应，请重新传输');
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.waiters.delete(done); resolve(); }, this.recovering ? 250 : poll());
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
  private setCompressionStatus(status: CompressionStatus, repeat = false) {
    const changed = JSON.stringify(status) !== JSON.stringify(this.compressionStatus);
    if (!changed && !repeat) return;
    if (changed) { this.compressionStatus = status; this.emit({ type: 'compression', data: status }); }
    if (this.role === 'sender' && this.compressionSupport) this.reply({ type: 'compression-advice', ...status }, this.generation);
  }
  private resetCompressionAdvice() {
    this.slowLink.reset(this.acknowledged);
    // An interrupted assessment must not suppress this file forever. A user's
    // explicit refusal, however, survives recovery and visibility changes.
    if (this.role === 'sender' && this.sendingFile >= 0 && this.compressionFile !== this.sendingFile && !this.dismissedCompressionFiles.has(this.sendingFile)) this.sampledFiles.delete(this.sendingFile);
    this.probe = undefined;
    this.setCompressionStatus({ active: this.role === 'receiver' ? this.compressionStatus.active : this.compressionFile === this.sendingFile && this.compressionFile >= 0 });
  }
  private compressionSpeed() {
    return !this.recovering && !this.localHidden && !this.peerHidden && this.accepted && !this.stopped && !this.completed ? this.slowLink.speed() : undefined;
  }
  private adviseCompression() {
    const speed = this.compressionSpeed(), file = this.files[this.sendingFile];
    if (this.compressionFile === this.sendingFile && this.compressionFile >= 0) return;
    const remaining = file ? file.size - this.sendingOffset : 0;
    if (!this.compressionSupport || this.dismissedCompressionFiles.has(this.sendingFile) || !speed || remaining < 8 * 1048576) { this.setCompressionStatus({ active: false }); return; }
    if (this.probe?.file === this.sendingFile && this.probe.decompressBps) {
      const sample = this.probe.sample, estimate = compressionEstimate(remaining, speed, sample.ratio, sample.compressBps, this.probe.decompressBps, this.probe.basePerByte);
      this.setCompressionStatus(estimate ? { active: false, offer: { file: this.sendingFile, savedSeconds: Math.floor(estimate.savedSeconds), percent: estimate.percent } } : { active: false });
    } else if (!this.probing && !this.sampledFiles.has(this.sendingFile) && performance.now() - this.probeAt >= 15000) {
      this.probing = true; this.probeAt = performance.now();
      const id = this.sendingFile, generation = this.generation;
      this.sampledFiles.add(id);
      void sampleCompression(file, this.sendingOffset, this.sourceReads.signal).then(sample => {
        if (!sample || this.stopped || this.completed || generation !== this.generation || id !== this.sendingFile || !this.compressionSpeed()) return;
        // Source I/O or receiver writes, rather than the wire, can be the bottleneck.
        if (this.readBytes * 1000 / Math.max(1, this.readMilliseconds) < speed * 2) return;
        const probe = this.probe = { id: ++this.probeSequence, file: id, sample, generation };
        this.reply({ type: 'compression-probe', id: probe.id, data: toBase64(new Uint8Array(sample.encoded)) }, generation);
      }).catch(() => { /* Optional sampling must not interrupt the original transfer. */ }).finally(() => { this.probing = false; });
    }
  }
  enableCompression() {
    const offer = this.compressionStatus.offer;
    if (!offer || this.stopped || this.completed || this.recovering || this.localHidden || this.peerHidden) return false;
    if (this.role === 'receiver') { this.reply({ type: 'compression-enable', file: offer.file }, this.generation); return true; }
    this.adviseCompression();
    if (!this.compressionStatus.offer || offer.file !== this.sendingFile) return false;
    this.compressionFile = offer.file;
    this.compressionWireSpeed = 1 / (1 / this.compressionSpeed()! - this.probe!.basePerByte!);
    this.compressionDecodeBps = this.probe!.decompressBps!;
    this.setCompressionStatus({ active: true });
    return true;
  }
  dismissCompression() {
    const offer = this.compressionStatus.offer;
    if (!offer) return;
    this.dismissedCompressionFiles.add(offer.file);
    if (this.role === 'receiver') this.reply({ type: 'compression-dismiss', file: offer.file }, this.generation);
    else this.probe = undefined;
    this.setCompressionStatus({ active: false });
  }
  private async writeIncoming(data: ArrayBuffer, generation: number, block = false) {
    const incoming = this.incoming;
    if (this.role !== 'receiver' || !this.accepted || !incoming || !data.byteLength || incoming.received + data.byteLength > incoming.info.size) throw Error('接收到不符合文件信息的数据');
    const chunk = new Uint8Array(data), size = data.byteLength;
    const at = performance.now();
    incoming.hash.update(chunk);
    if (incoming.writer) await incoming.writer.write(data);
    else if (this.temporary) await writeTemporaryFile(this.temporary, incoming.received, data);
    else incoming.parts.push(chunk);
    this.writeBytes += size; this.writeMilliseconds += performance.now() - at;
    if (this.stopped) return;
    const before = Math.floor(this.received / ACK_BYTES);
    incoming.received += size; this.received += size;
    if (block || Math.floor(this.received / ACK_BYTES) > before || incoming.received === incoming.info.size) this.reply({ type: 'ack', bytes: this.received }, generation);
    this.progress();
  }
  private async handle(data: string | ArrayBuffer, generation: number) {
    if (this.stopped) return;
    if (typeof data !== 'string') {
      if (this.encodedBlock) {
        const block = this.encodedBlock;
        if (!data.byteLength || block.received + data.byteLength > block.size || block.chunks.length >= 512) throw Error('压缩数据长度不一致');
        block.chunks.push(new Uint8Array(data)); block.received += data.byteLength;
        if (block.received === block.size) {
          const encoded = new Uint8Array(block.size); let at = 0;
          for (const part of block.chunks) { encoded.set(part, at); at += part.byteLength; }
          const decoded = await gunzip(encoded.buffer, block.raw);
          if (this.stopped) return;
          await this.writeIncoming(decoded, generation, true);
          this.encodedBlock = undefined;
        }
      } else await this.writeIncoming(data, generation);
      return;
    }
    if (data.length > 65536) throw Error('控制信息过大');
    const message = JSON.parse(data);
    if (message.type === 'standby-ping' && standbyNonce(message.nonce)) { this.reply({ type: 'standby-pong', nonce: message.nonce }, generation); return; }
    if (message.type === 'standby-pong') return;
    if (message.type === 'ping') {
      this.diagnostics?.receive(message.metrics);
      const metrics = this.diagnostics?.packet(); this.reply({ type: 'pong', ...(metrics ? { metrics } : {}) }, generation); return;
    }
    if (message.type === 'pong') { this.diagnostics?.receive(message.metrics); return; }
    if (message.type === 'visibility') {
      if (typeof message.hidden !== 'boolean') throw Error('后台状态信息无效');
      const first = !this.backgroundSupport;
      this.backgroundSupport = true;
      if (message.hidden !== this.peerHidden) {
        this.peerHidden = message.hidden;
        this.peerBackgroundUntil = message.hidden ? Date.now() + 10 * 60 * 1000 : 0;
        this.activityRevision++;
        this.resetCompressionAdvice();
        if (!message.hidden && this.role === 'sender') this.flow.reset(this.acknowledged);
        if (!message.hidden && this.recovering) this.armRecoveryTimeout();
        this.emit({ type: 'background', data: message.hidden }); this.wake();
      }
      if (first) this.reportVisibility();
      return;
    }
    if (message.type === 'compression-probe' && this.role === 'receiver' && this.compressionSupport) {
      if (!this.accepted || this.completed || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.data !== 'string' || message.data.length > 44000 || performance.now() - this.receivedProbeAt < 5000) throw Error('压缩探测信息无效');
      this.receivedProbeAt = performance.now();
      const encoded = fromBase64(message.data);
      if (encoded.byteLength > SAMPLE_BYTES) throw Error('压缩探测信息无效');
      const at = performance.now(); await gunzip(encoded.buffer, SAMPLE_BYTES);
      const decompressBps = SAMPLE_BYTES * 1000 / Math.max(1, performance.now() - at);
      this.reply({ type: 'compression-probed', id: message.id, decompressBps, writeBps: Math.min(1e12, this.writeBytes * 1000 / Math.max(1, this.writeMilliseconds)) }, generation);
      return;
    }
    if (message.type === 'compression-probed' && this.role === 'sender' && this.compressionSupport) {
      const probe = this.probe;
      if (!probe || message.id !== probe.id || generation !== probe.generation || probe.file !== this.sendingFile) return;
      if (![message.decompressBps, message.writeBps].every(n => Number.isFinite(n) && n > 0 && n <= 1e12)) throw Error('压缩探测信息无效');
      const speed = this.compressionSpeed();
      if (!speed || message.writeBps < speed * 2) return;
      probe.decompressBps = message.decompressBps;
      probe.basePerByte = this.readMilliseconds / Math.max(1, this.readBytes) / 1000 + 1 / message.writeBps;
      this.adviseCompression(); return;
    }
    if (message.type === 'compression-advice' && this.role === 'receiver' && this.compressionSupport) {
      const offer = message.offer;
      if (typeof message.active !== 'boolean' || (offer && (message.active || offer.file !== this.receivedFiles || !Number.isFinite(offer.savedSeconds) || offer.savedSeconds < 5 || !Number.isInteger(offer.percent) || offer.percent < 20 || offer.percent > 100))) throw Error('压缩建议无效');
      if (offer && this.dismissedCompressionFiles.has(offer.file)) { this.setCompressionStatus({ active: false }); return; }
      this.setCompressionStatus({ active: message.active, ...(offer ? { offer: { file: offer.file, savedSeconds: offer.savedSeconds, percent: offer.percent } } : {}) }); return;
    }
    if ((message.type === 'compression-enable' || message.type === 'compression-dismiss') && this.role === 'sender' && this.compressionSupport) {
      // A refusal can arrive after a speed change withdrew the visible offer.
      // Keep that choice for the current file, but ignore unrelated/stale files
      // and a refusal overtaken by the other device's activation.
      if (message.type === 'compression-dismiss' && message.file === this.sendingFile && this.compressionFile !== this.sendingFile) {
        this.dismissedCompressionFiles.add(message.file); this.probe = undefined; this.setCompressionStatus({ active: false });
      } else if (message.type === 'compression-enable' && message.file === this.compressionStatus.offer?.file) this.enableCompression();
      return;
    }
    if (message.type === 'compressed-block' && this.role === 'receiver') {
      const incoming = this.incoming;
      if (!this.compressionSupport || !this.compressionStatus.active || !incoming || !this.accepted || this.encodedBlock ||
          message.id !== incoming.info.id || message.offset !== incoming.received || !Number.isInteger(message.raw) || message.raw < 1 || message.raw > BLOCK_BYTES || incoming.received + message.raw > incoming.info.size ||
          !Number.isInteger(message.size) || message.size < 1 || message.size > BLOCK_BYTES) throw Error('压缩数据无效');
      this.encodedBlock = { size: message.size, raw: message.raw, received: 0, chunks: [] }; return;
    }
    if (message.type === 'manifest' && this.role === 'receiver') {
      const manifest = validateManifest(message.files);
      this.compressionSupport = message.compression === COMPRESSION && supportsCompression();
      this.backgroundSupport = message.backgroundSupport === true;
      this.reportVisibility();
      if (this.manifest.length) {
        if (JSON.stringify(manifest) !== JSON.stringify(this.manifest)) throw Error('续传文件列表不一致');
        this.reply({ type: 'resume', file: this.receivedFiles, offset: this.incoming?.received || 0, bytes: this.received, accepted: this.accepted, complete: this.completed, compression: this.compressionSupport ? COMPRESSION : undefined }, generation);
        this.restored();
      } else {
        this.manifest = manifest;
        // Initial ICE can fail before any manifest reaches the receiver. The
        // replacement sender still needs a resume snapshot before it can accept
        // a subsequent download request; do not wait for another recovery cycle.
        if (message.resumeRequested === true) this.reply({ type: 'resume', file: 0, offset: 0, bytes: 0, accepted: false, complete: false,
          compression: this.compressionSupport ? COMPRESSION : undefined }, generation);
        this.restored(); this.emit({ type: 'manifest', data: this.manifest });
      }
    } else if (message.type === 'resume' && this.role === 'sender') {
      if (!generation || this.resumedGeneration === generation) throw Error('重复或无效的续传信息');
      const { file, offset, bytes: received, accepted, complete } = message;
      const expected = this.manifest.slice(0, file).reduce((sum, info) => sum + info.size, 0) + offset;
      if (!Number.isInteger(file) || file < 0 || file > this.files.length || !Number.isSafeInteger(offset) || offset < 0 ||
          offset > (this.files[file]?.size || 0) || received !== expected || received > this.sent || received < this.acknowledged || file <= this.fileConfirmed ||
          typeof accepted !== 'boolean' || typeof complete !== 'boolean' || (this.accepted && !accepted) ||
          (complete && (file !== this.files.length || offset !== 0))) throw Error('续传位置无效');
      this.sent = this.acknowledged = received; this.fileConfirmed = file - 1; this.accepted = accepted;
      this.compressionSupport = message.compression === COMPRESSION && supportsCompression();
      if (!this.compressionSupport) this.compressionFile = -1;
      this.resumedGeneration = generation;
      this.restored(); this.progress(true);
      if (complete) { this.completed = true; this.enableStandby(false); clearInterval(this.heartbeat); this.emit({ type: 'done' }); }
      else if (accepted) this.startSending(file, offset);
    } else if (message.type === 'accept' && this.role === 'sender') {
      // A save picker can return before the replacement channel's manifest.
      // Its resume snapshot is authoritative; starting here as well would run
      // two send loops after recovery. This also covers older receiver pages.
      if (this.recovering) return;
      if (this.accepted) throw Error('重复的下载请求');
      this.accepted = true;
      this.compressionSupport = message.compression === COMPRESSION && supportsCompression();
      this.startSending(0, 0);
    } else if (message.type === 'ack' && this.role === 'sender') {
      if (!Number.isSafeInteger(message.bytes) || message.bytes < this.acknowledged || message.bytes > this.sent) throw Error('接收确认信息无效');
      this.flow.confirm(message.bytes);
      this.acknowledged = message.bytes; this.wake(); this.progress();
      this.slowLink.observe(message.bytes); this.adviseCompression();
    } else if (message.type === 'file-start' && this.role === 'receiver') {
      const info = this.manifest[this.receivedFiles];
      const offset = message.offset ?? 0;
      if (!this.accepted || !info || this.encodedBlock || message.id !== info.id || offset !== (this.incoming?.received || 0)) throw Error('文件顺序无效');
      if (!this.incoming) {
        const writer = this.handles[info.id] ? await this.handles[info.id].createWritable() : undefined;
        if (this.temporary) await beginTemporaryFile(this.temporary, info);
        const hash = await createFileHash();
        if (this.stopped) { await writer?.abort().catch(() => {}); return; }
        this.incoming = { info, writer, received: 0, parts: [], hash };
      }
      this.emit({ type: 'file', data: info.name });
    } else if (message.type === 'file-end' && this.role === 'receiver') {
      const current = this.incoming;
      if (!current || this.encodedBlock || message.id !== current.info.id || current.received !== current.info.size || hex(current.hash.digest()) !== message.hash) throw Error('文件完整性校验失败，请重新传输');
      if (current.writer) await current.writer.close();
      else if (this.temporary) await finishTemporaryFile(this.temporary, message.hash);
      else {
        const url = URL.createObjectURL(new Blob(current.parts, { type: downloadType(current.info) }));
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
      this.completed = true; this.enableStandby(false); clearInterval(this.heartbeat); this.progress(true); this.reply({ type: 'complete' }, generation);
      this.emit({ type: 'done' });
    } else if (message.type === 'complete' && this.role === 'sender') {
      if (this.fileConfirmed !== this.manifest.length - 1) throw Error('文件尚未保存完整');
      this.completed = true; this.enableStandby(false); clearInterval(this.heartbeat); this.progress(true); this.emit({ type: 'done' });
    } else if (message.type === 'cancel') { this.fail(message.reason === 'source-unavailable' ? '发送方无法读取原文件，请让对方重新选择本机原文件后再试。' : '对方已取消传输。'); }
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
      this.emit({ type: 'started' });
      // The channel can still be closed while the OS returns a chosen path.
      // Keep that permission; the next manifest reports accepted in resume.
      if (this.recovering) this.emit({ type: 'recovering' });
      else this.control({ type: 'accept', compression: this.compressionSupport ? COMPRESSION : undefined });
    } finally { this.accepting = false; }
  }
  private startSending(file: number, offset: number) {
    const generation = this.generation;
    this.flow.reset(this.acknowledged);
    this.slowLink.reset(this.acknowledged);
    void this.sendFiles(file, offset, generation).catch(e => {
      if (this.stopped || generation !== this.generation) return;
      if (e instanceof TransportInterrupted) this.requestRecovery();
      else this.fail(e.message, e instanceof SourceReadError);
    });
  }
  private async sendFiles(firstFile: number, firstOffset: number, generation: number) {
    const sourceOptions = { signal: this.sourceReads.signal, deferTimeout: this.deferSourceTimeout };
    if (!this.started) { this.started = performance.now(); this.emit({ type: 'started' }); }
    const maxMessage = this.nativePeer?.sctp?.maxMessageSize || 65536;
    const chunkSize = Math.min(32768, maxMessage);
    if (chunkSize < 1024) throw Error('对方浏览器的数据通道限制过小');
    for (let id = firstFile; id < this.files.length; id++) {
      const file = this.files[id], start = id === firstFile ? firstOffset : 0;
      this.sendingFile = id; this.sendingOffset = start;
      let unhelpfulBlocks = 0;
      // Repeat on every file/resume, even when local state did not change:
      // activation may have been lost on the previous data channel.
      this.setCompressionStatus({ active: this.compressionFile === id }, true);
      let hash = this.hashes.get(id + ':' + start)?.clone();
      if (!hash) {
        hash = sha256.create();
        for (let offset = 0; offset < start; offset += 1048576) {
          const prefix = await readSource(file, offset, Math.min(offset + 1048576, start), undefined, sourceOptions);
          if (this.stopped || generation !== this.generation) throw new TransportInterrupted();
          hash.update(new Uint8Array(prefix));
        }
      }
      await this.waitFor(() => true, generation);
      this.control({ type: 'file-start', id, offset: start }); this.emit({ type: 'file', data: file.name });
      for (let offset = start; offset < file.size;) {
        const compressing = this.compressionFile === id;
        const length = Math.min(compressing ? BLOCK_BYTES : chunkSize, file.size - offset);
        let bufferBlocked = false;
        await this.waitFor(() => {
          bufferBlocked = this.channel!.bufferedAmount + length > 1048576;
          return this.flow.allows(this.sent - this.acknowledged, length) && !bufferBlocked;
        }, generation, 60000, () => bufferBlocked ? 8 : 250);
        const readAt = performance.now();
        const buffer = await readSource(file, offset, offset + length, undefined, sourceOptions);
        if (this.stopped || generation !== this.generation) throw new TransportInterrupted();
        hash.update(new Uint8Array(buffer));
        this.readBytes += length; this.readMilliseconds += performance.now() - readAt;
        let payload = buffer, compressed = false;
        if (compressing) {
          const at = performance.now();
          try {
            const encoded = await gzip(buffer);
            const cost = (performance.now() - at) / 1000 + length / this.compressionDecodeBps;
            if (encoded.byteLength < length * .95 && cost * 1.25 < (length - encoded.byteLength) / this.compressionWireSpeed) {
              payload = encoded; compressed = true; unhelpfulBlocks = 0;
            } else unhelpfulBlocks++;
          } catch { unhelpfulBlocks = 3; }
          if (this.stopped || generation !== this.generation) throw new TransportInterrupted();
          await this.waitFor(() => true, generation);
          if (compressed) this.control({ type: 'compressed-block', id, offset, raw: length, size: payload.byteLength });
        }
        for (let at = 0; at < payload.byteLength; at += chunkSize) {
          const part = payload.byteLength <= chunkSize ? payload : payload.slice(at, at + chunkSize);
          if (compressing) await this.waitFor(() => this.channel!.bufferedAmount + part.byteLength <= 1048576, generation, 60000, () => 8);
          try { this.channel!.send(part); } catch { throw new TransportInterrupted('连接已关闭'); }
          if (!compressed) { this.sent += part.byteLength; this.flow.sent(this.sent); }
        }
        if (compressed) { this.sent += length; this.flow.sent(this.sent); }
        offset += length; this.sendingOffset = offset;
        this.hashes.set(id + ':' + offset, hash.clone());
        if (this.hashes.size > 160) this.hashes.delete(this.hashes.keys().next().value!);
        if (unhelpfulBlocks >= 3) { this.compressionFile = -1; this.probe = undefined; this.setCompressionStatus({ active: false }); }
      }
      if (this.stopped || generation !== this.generation) throw new TransportInterrupted();
      this.control({ type: 'file-end', id, hash: hex(hash.digest()) });
      await this.waitFor(() => this.fileConfirmed >= id, generation);
      this.probe = undefined; this.compressionFile = -1; this.setCompressionStatus({ active: false });
    }
    this.sendingFile = -1;
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
    this.scheduleFailure('connectTimer', 90000, '未能建立直连。请让手机保持在发送页面，并检查 VPN 是否允许本地网络和 WebRTC；可先关闭双方 VPN 再试。');
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
  fail(message: string, sourceUnavailable = false) {
    if (this.stopped || this.completed || this.failing) return;
    const finish = () => {
      clearTimeout(this.failureTimer);
      if (this.stopped || this.completed) return;
      this.emit({ type: 'error', data: message }); this.close(false);
    };
    if (sourceUnavailable) {
      this.failing = true;
      if (this.channel?.readyState === 'open') {
        try { this.control({ type: 'cancel', reason: 'source-unavailable' }); } catch {}
      }
      // Send the reason and wait for the peer's receipt before the group closes
      // its socket. Otherwise "ended" can overtake the data channel's final
      // cancellation. Both automatic and manual pairing have a bounded grace.
      this.failureTimer = setTimeout(finish, 1000);
      if (this.sourceFailure) void this.sourceFailure().then(finish, () => {});
    } else finish();
  }
  close(notify = true) {
    if (notify && this.channel?.readyState === 'open' && !this.completed && (this.role === 'sender' || this.accepted)) {
      try { this.control({ type: 'cancel' }); } catch {}
    }
    this.stopped = true; this.sourceReads.abort(); clearTimeout(this.failureTimer); this.sourceFailure = undefined; clearTimeout(this.connectTimer); clearTimeout(this.disconnectedTimer); clearTimeout(this.recoveryTimer); clearInterval(this.heartbeat);
    this.diagnostics?.close();
    clearTimeout(this.binaryTimer); this.binaryTimer = undefined;
    this.receivingQueuedBytes -= this.pendingBinaryBytes; this.receivingQueuedMessages -= this.pendingBinary.length;
    this.pendingBinary = []; this.pendingBinaryBytes = 0;
    this.encodedBlock = undefined; this.probe = undefined;
    this.setCompressionStatus({ active: false });
    this.flow.reset(this.acknowledged);

    window.removeEventListener('online', this.networkChanged); window.removeEventListener('offline', this.networkChanged);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.hashes.clear();
    void this.incoming?.writer?.abort().catch(() => {});
    if (this.temporary) {
      void discardTemporaryPartial(this.temporary).catch(() => {});
      this.temporary = undefined;
    }
    this.incoming = undefined; this.handles = []; this.files = [];
    this.channel?.close(); this.nativePeer?.close(); this.standby?.transport.close(); this.standby = undefined; this.wake();
    for (const output of this.outputs) URL.revokeObjectURL(output.url);
  }
}

export class Signaling {
  private socket?: WebSocket;
  private queue = Promise.resolve();
  private queuedBytes = 0;
  private queuedMessages = 0;
  private sendQueue = Promise.resolve();
  private sequence = 0;
  private lastReceived = 0;
  private peerSession?: string;
  private allowNewPeer = false;
  expectNewPeer() { this.allowNewPeer = true; }
  private endpoint?: string;
  private role = '';
  private closed = false;
  private lifetime = new AbortController();
  private starting = false;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private failures = 0;
  private lastSeen = Date.now();
  private client = randomToken();
  constructor(private key: CryptoKey, private onMessage: (message: any, authenticated?: boolean) => Promise<void>, private onError: (message: string) => void) {}
  async connect(endpoint: string, room: string, role: string, token: string, onRetry?: () => void) {
    const url = new URL(endpoint);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    url.pathname = '/rooms/' + room;
    url.search = new URLSearchParams({ role, token, client: this.client }).toString();
    this.endpoint = url.toString(); this.role = role;
    this.starting = true; let connected = false;
    try { await retryInitialPairing(signal => this.open(signal), this.lifetime.signal, onRetry); connected = true; }
    finally {
      this.starting = false;
      if (connected && !this.closed && this.socket?.readyState !== WebSocket.OPEN) this.scheduleRetry();
    }
  }
  private open(signal = this.lifetime.signal): Promise<void> {
    if (this.closed) return Promise.reject(Error('配对服务已断开'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const attempt = (async () => {
      const url = new URL(this.endpoint!);
      url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
      const { response, state } = await retryPairingRequest(url, { signal }, async response => ({ response, state: response.ok ? await response.json() : undefined }));
      if (!response.ok) {
        if ([401, 409, 410].includes(response.status)) { this.closed = true; clearTimeout(this.retry); }
        throw new PairingResponseError(response.status === 409 ? '分享链接已被另一接收页面占用，请关闭原页面或创建新链接。' :
          response.status === 410 ? '分享链接已过期或发送方已结束，请创建新链接。' : '无法连接配对服务', response.status);
      }
      if (this.closed) throw Error('配对服务已断开');
      const connectionURL = await ticketURL(this.endpoint!, undefined, signal);
      if (this.closed) throw Error('配对服务已断开');
      const socket = this.socket = new WebSocket(connectionURL);
      this.lastSeen = Date.now();
      // Install handlers before open; peer-ready may arrive immediately.
      socket.onmessage = event => {
        if (socket !== this.socket || this.closed) return;
        // Apply the service's frame limit before parsing/decryption, and bound
        // work waiting behind slow peer negotiation, including across reconnects.
        const data = event.data;
        const size = typeof data === 'string' ? data.length * 2 : 0;
        if (typeof data !== 'string' || data.length > 128000 || this.queuedBytes + size > 1048576 || this.queuedMessages >= 128) {
          this.socket = undefined; clearInterval(this.heartbeat);
          socket.close(4009, 'Signaling safety limit');
          this.onError('配对消息超出安全限制，已断开配对服务。已建立的文件直传可以继续。');
          this.scheduleRetry(); return;
        }
        this.queuedBytes += size; this.queuedMessages++;
        this.lastSeen = Date.now();
        this.queue = this.queue.then(async () => {
          if (socket !== this.socket || this.closed) return;
          const message = JSON.parse(data);
          if (message.type === 'keepalive') return;
          if (message.type === 'signal') {
            const decoded = await unseal(this.key, message.payload);
            if (socket !== this.socket || this.closed) return;
            if (typeof decoded.session !== 'string' || !/^[a-f0-9]{64}$/.test(decoded.session)) throw Error('配对信息无效');
            if (this.peerSession !== decoded.session) {
              if (this.peerSession && !this.allowNewPeer) throw Error('配对信息无效');
              this.peerSession = decoded.session; this.lastReceived = 0; this.allowNewPeer = false;
            }
            if (!Number.isInteger(decoded.sequence) || decoded.sequence <= this.lastReceived) throw Error('重复或无效的配对消息');
            this.lastReceived = decoded.sequence; await this.onMessage(decoded.message, true);
          } else await this.onMessage(message);
        }).catch(e => { if (socket === this.socket && !this.closed) this.onError(e.message); }).finally(() => {
          this.queuedBytes -= size; this.queuedMessages--;
        });
      };
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        const fail = (error: Error) => {
          clearTimeout(timeout); signal.removeEventListener('abort', cancel);
          if (socket === this.socket) this.socket = undefined;
          socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null;
          socket.close(); reject(error);
        };
        const cancel = () => fail(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
        const timeout = setTimeout(() => fail(new PairingConnectionError('配对服务连接超时')), 10000);
        if (signal.aborted) { cancel(); return; }
        signal.addEventListener('abort', cancel, { once: true });
        socket.onopen = () => {
          opened = true; clearTimeout(timeout); signal.removeEventListener('abort', cancel);
          if (this.closed || socket !== this.socket) { socket.close(); reject(Error('配对服务已断开')); return; }
          this.failures = 0;
          clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastSeen > 30000) { socket.close(); return; }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'keepalive' }));
          }, 10000);
          this.queue = this.queue.then(async () => {
            if (socket === this.socket && !this.closed) await this.onMessage({ type: 'signal-ready', peerPresent: state.peerPresent });
          }).catch(e => { if (socket === this.socket && !this.closed) this.onError(e.message); });
          resolve();
        };
        socket.onerror = () => { if (!opened) fail(new PairingConnectionError('无法连接配对服务')); else socket.close(); };
        socket.onclose = () => {
          if (!opened) { fail(new PairingConnectionError('配对服务已断开')); return; }
          clearTimeout(timeout);
          reject(Error('配对服务已断开'));
          if (socket !== this.socket || this.closed) return;
          clearInterval(this.heartbeat);
          if (!this.starting) this.onError('配对服务已断开；已建立的文件直连可以继续');
          this.scheduleRetry();
        };
      });
    })();
    this.connecting = attempt.finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private scheduleRetry() {
    clearTimeout(this.retry);
    if (this.closed || this.starting) return;
    this.retry = setTimeout(() => {
      if (!this.closed) void this.open().catch(() => this.scheduleRetry());
    }, Math.min(1000 * 2 ** this.failures++, 8000));
  }
  resumePage() {
    if (this.closed || this.starting || this.connecting || !this.endpoint) return;
    const socket = this.socket; this.socket = undefined; clearInterval(this.heartbeat);
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
    this.scheduleRetry();
  }
  async ready() {
    const deadline = Date.now() + 60000;
    while (!this.closed && Date.now() < deadline) {
      try { await this.open(); return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw Error('配对服务已断开');
  }
  async stream(secret: string, session: string, current = () => true) {
    if (this.closed || !this.endpoint || !current()) throw Error('加密转发暂时不可用');
    const room = new URL(this.endpoint).pathname.split('/').pop()!;
    const [url, cipher] = await Promise.all([ticketURL(this.endpoint, session), StreamCipher.create(secret, room, session, this.role as 'sender' | 'receiver')]);
    if (this.closed || !current()) throw Error('加密转发暂时不可用');
    return new StreamChannel(url, cipher);
  }
  async send(message: unknown, connectedOnly = false) {
    const task = this.sendQueue.then(async () => {
      if (connectedOnly) {
        if (this.closed || this.socket?.readyState !== WebSocket.OPEN) throw Error('配对服务已断开');
      } else await this.ready();
      const payload = await seal(this.key, { session: this.client, sequence: ++this.sequence, message });
      if (this.closed || this.socket?.readyState !== WebSocket.OPEN) throw Error('配对服务已断开');
      this.socket.send(JSON.stringify({ type: 'signal', payload }));
    });
    this.sendQueue = task.catch(() => {});
    return task;
  }
  close() {
    this.closed = true; this.lifetime.abort(); clearTimeout(this.retry); clearInterval(this.heartbeat);
    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: this.role === 'sender' ? 'end' : 'leave' }));
      this.socket.onopen = null; this.socket.onclose = null; this.socket.onerror = null; this.socket.onmessage = null; this.socket.close();
    }
  }
}

// The sender is the only offerer, so simultaneous network changes cannot create
// competing offers. Each new connection has a monotonically increasing epoch.
export const DIRECT_SWITCH_MS = 8000;
type WarmSwitch = { session: string; route: TransferRoute; epoch: number; timer: ReturnType<typeof setTimeout>;
  ready?: (ok: boolean) => void; activated?: (ok: boolean) => void; prepared?: boolean };
export class AutoPair {
  private signal: Signaling;
  private epoch = 0;
  private revision = 0;
  private offered = false;
  private negotiating = false;
  private closed = false;
  private lastAttempt = 0;
  private finishedAt = 0;
  private sourceFailureAck?: () => void;
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
  private routeMonitor: ReturnType<typeof setInterval>;
  private streamFallback?: StreamFallback;
  private routeSnapshot = '';
  private pendingRoute?: TransferRoute;
  private routeRequestTimer?: ReturnType<typeof setTimeout>;
  private warm?: WarmSwitch;
  private directTrial?: { timer: ReturnType<typeof setTimeout>; attempted: boolean };
  private warmSupported = false;
  private peerDirectSupported = true;
  private capabilitiesSent = false;
  private peerCapabilitiesReceived = false;
  private capabilitiesTimer?: ReturnType<typeof setTimeout>;
  private get directAvailable() { return this.transfer.directSupported && this.peerDirectSupported; }
  private async announceCapabilities(force = false) {
    if (!this.streamFallback || this.capabilitiesSent && !force) return;
    await this.signal.send({ type: 'transport-capabilities', v: 1, direct: this.transfer.directSupported,
      streamSupport: 1, quickRelaySupport: 1, peerInfo: localPeerInfo() }, true);
    this.capabilitiesSent = true;
  }
  private waitForCapabilities() {
    if (this.transfer.directSupported || this.peerCapabilitiesReceived || this.capabilitiesTimer) return;
    this.capabilitiesTimer = setTimeout(() => {
      if (!this.closed && !this.peerCapabilitiesReceived) this.transfer.fail('对方网页尚未支持此浏览器的加密转发，请让双方刷新网页后重试。');
    }, 15000);
  }
  private relayOnly() {
    if (!this.streamFallback?.supported) throw Error('对方浏览器不支持加密转发，请让对方刷新网页或更换新版浏览器。');
    this.offered = true; clearTimeout(this.waitingTimer);
    if (!this.transfer.transportConnected) this.waitingTimer = setTimeout(() => {
      if (!this.closed && !this.transfer.transportConnected) this.transfer.fail('加密转发未能建立，请检查网络后重试，或更换新版浏览器。');
    }, 60000);
    this.streamFallback.requireRelay();
    this.transfer.pairingStage('一端浏览器不支持直连，正在建立加密转发');
    this.monitorRoute();
  }
  constructor(private transfer: Transfer, key: CryptoKey, private onError: (message: string) => void, secret?: string) {
    this.signal = new Signaling(key, (message, authenticated) => this.handle(message, authenticated), onError);
    if (secret) this.streamFallback = new StreamFallback(transfer.role, {
      epoch: () => this.epoch, stopped: () => this.closed || transfer.stopped || transfer.completed,
      progress: () => ({ ...transfer.routeProgress(), connected: transfer.transportConnected && !transfer.recovering }),
      open: (session, current) => this.signal.stream(secret, session, current), send: message => this.signal.send(message),
      activate: async (channel, epoch) => {
        if (this.closed || transfer.stopped || transfer.completed || epoch !== this.epoch + 1) throw Error('Stale stream activation');
        this.negotiating = true;
        try {
          transfer.pauseRecovery(); this.epoch = epoch; this.lastOffer = this.lastAnswer = undefined; this.resetCandidates();
          await transfer.replaceTransport(channel);
        } finally { this.negotiating = false; }
      },
      restore: () => { this.lastAttempt = 0; transfer.requestRecovery(); },
      changed: () => this.reportRoute()
    });
    transfer.enableSourceFailure(async () => {
      const receipt = new Promise<void>(resolve => { this.sourceFailureAck = resolve; });
      try { await this.signal.send({ type: 'source-unavailable' }, true); await receipt; }
      finally { this.sourceFailureAck = undefined; }
    });
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
    this.routeMonitor = setInterval(() => this.monitorRoute(), 2000);
  }
  private monitorRoute() {
    if (this.directTrial && !this.streamFallback?.active && this.transfer.transportConnected && !this.transfer.recovering) this.clearDirectTrial();
    if (this.warm || this.pendingRoute) { this.reportRoute(); return; }
    this.streamFallback?.monitor(this.offered && !this.negotiating && !this.closed);
    this.reportRoute();
  }
  private reportRoute() {
    const fallback = this.streamFallback, t = this.transfer;
    if (!fallback || this.closed || t.stopped || t.completed) return;
    const state = { ...fallback.state };
    state.directUnavailable = !this.directAvailable;
    state.busy ||= !!this.pendingRoute || !!this.warm || this.negotiating && !this.directTrial;
    state.recovering = t.recovering;
    if (this.pendingRoute) state.target = this.pendingRoute;
    const snapshot = JSON.stringify(state);
    if (snapshot !== this.routeSnapshot) {
      this.routeSnapshot = snapshot; t.reportRoute(state);
      if (!state.connected && state.target === 'stream') {
        if (state.busy) t.pairingStage('直连暂未建立，正在连接加密转发');
        else if (state.failed) t.pairingStage('暂未连通，正在继续寻找连接路径');
      }
    }
  }
  async chooseRoute(route: TransferRoute) {
    if (route === 'direct' && !this.directAvailable) throw Error('一端浏览器不支持直连，请继续使用加密转发。');
    const fallback = this.streamFallback;
    if (!fallback?.state.available || this.closed || this.transfer.stopped || this.transfer.completed ||
      fallback.busy || this.pendingRoute || this.warm || this.negotiating && !this.directTrial || !['direct', 'stream'].includes(route)) throw Error('暂时无法切换路线，请稍后重试。');
    this.pendingRoute = route; this.reportRoute();
    try {
      if (this.transfer.role === 'sender') await this.commitRouteChoice(route);
      else {
        await this.signal.send({ type: 'stream-select', route }, true);
        if (this.pendingRoute === route) this.routeRequestTimer = setTimeout(() => {
          this.pendingRoute = undefined; this.reportRoute();
          if (!this.closed && !this.transfer.stopped && !this.transfer.completed) this.onError('暂时无法切换路线，请稍后重试。');
        }, 10000);
      }
    } catch (error) {
      this.pendingRoute = undefined; this.reportRoute();
      if (!this.closed && !this.transfer.stopped && !this.transfer.completed) throw error;
    }
  }
  private clearDirectTrial() {
    clearTimeout(this.directTrial?.timer); this.directTrial = undefined;
  }
  private async commitRouteChoice(route: TransferRoute, directFailed = false) {
    if (this.closed || this.transfer.stopped || this.transfer.completed) return;
    if (route === 'direct' && !this.directAvailable) return;
    if (this.pendingRoute && this.pendingRoute !== route || this.warm) return;
    // Supersede a cold native attempt, including any signaling wait. Its late
    // continuation must not send SDP over a newly restored stream connection.
    if (this.directTrial && route === 'stream') { this.revision++; this.clearDirectTrial(); this.negotiating = false; }
    this.pendingRoute = route; this.reportRoute();
    try {
      await this.signal.send({ type: 'stream-choice', route, epoch: this.epoch, directFailed }, true);
      if (this.closed || this.transfer.stopped || this.transfer.completed) return;
      const reused = await this.tryWarm(route);
      if (this.closed || this.transfer.stopped || this.transfer.completed) return;
      if (!reused) await this.signal.send({ type: 'stream-choice', route, epoch: this.epoch, directFailed }, true);
      if (!reused && route === 'direct' && this.streamFallback?.active) {
        this.clearDirectTrial();
        this.directTrial = { attempted: false, timer: setTimeout(() => {
          if (this.transfer.transportConnected && !this.transfer.recovering) { this.clearDirectTrial(); return; }
          void this.commitRouteChoice('stream', true).catch(() => this.onError('暂时无法切换路线，请稍后重试。'));
        }, DIRECT_SWITCH_MS) };
      }
      this.streamFallback?.choose(route, directFailed);
    } finally { this.pendingRoute = undefined; this.monitorRoute(); }
  }
  private clearWarm(candidate: WarmSwitch) {
    if (this.warm !== candidate) return;
    this.warm = undefined; clearTimeout(candidate.timer); candidate.ready?.(false); candidate.activated?.(false);
  }
  private async tryWarm(route: TransferRoute) {
    const t = this.transfer;
    if (!this.warmSupported || !t.hasStandby(route)) return false;
    const candidate: WarmSwitch = { session: randomToken(), route, epoch: this.epoch, timer: setTimeout(() => this.clearWarm(candidate), DIRECT_SWITCH_MS) };
    this.warm = candidate; this.reportRoute();
    const ready = new Promise<boolean>(resolve => { candidate.ready = resolve; });
    const activated = new Promise<boolean>(resolve => { candidate.activated = resolve; });
    let complete = false;
    try {
      await this.signal.send({ type: 'stream-warm-prepare', session: candidate.session, route, epoch: candidate.epoch }, true);
      const [local, remote] = await Promise.all([t.probeStandby(route), ready]);
      if (!local || !remote || this.warm !== candidate || this.closed || t.stopped || t.completed) return false;
      t.pauseRecovery(); this.epoch++; this.lastOffer = this.lastAnswer = undefined; this.resetCandidates();
      await this.signal.send({ type: 'stream-warm-activate', session: candidate.session, route, epoch: candidate.epoch }, true);
      if (!await activated || this.warm !== candidate || this.closed || t.stopped || t.completed) return false;
      await t.replaceTransport(undefined, route);
      this.streamFallback?.useRoute(route); complete = true; return true;
    } catch { return false; }
    finally {
      this.clearWarm(candidate);
      if (!complete && !this.closed) void this.signal.send({ type: 'stream-warm-cancel', session: candidate.session, route, epoch: candidate.epoch }, true).catch(() => {});
    }
  }
  private async handleWarm(message: any) {
    const t = this.transfer;
    if (!this.warmSupported || !/^[a-f0-9]{64}$/.test(message.session) || !['direct', 'stream'].includes(message.route)) return;
    if (message.type === 'stream-warm-prepare' && t.role === 'receiver') {
      if (this.warm || message.epoch !== this.epoch) return;
      const candidate: WarmSwitch = { session: message.session, route: message.route, epoch: message.epoch,
        timer: setTimeout(() => this.clearWarm(candidate), DIRECT_SWITCH_MS) };
      this.warm = candidate; this.reportRoute();
      const ok = await t.probeStandby(candidate.route);
      if (this.warm !== candidate || this.closed || t.stopped || t.completed) return;
      candidate.prepared = ok;
      await this.signal.send({ type: 'stream-warm-ready', session: candidate.session, route: candidate.route, epoch: candidate.epoch, ready: ok }, true);
      if (!ok) { this.clearWarm(candidate); this.reportRoute(); }
      return;
    }
    const candidate = this.warm;
    if (!candidate || message.session !== candidate.session || message.route !== candidate.route || message.epoch !== candidate.epoch) return;
    if (message.type === 'stream-warm-cancel') { this.clearWarm(candidate); this.reportRoute(); }
    else if (message.type === 'stream-warm-ready' && t.role === 'sender') candidate.ready?.(message.ready === true);
    else if (message.type === 'stream-warm-activated' && t.role === 'sender') candidate.activated?.(true);
    else if (message.type === 'stream-warm-activate' && t.role === 'receiver' && candidate.prepared && this.epoch === candidate.epoch) {
      t.pauseRecovery(); this.epoch++; this.lastOffer = this.lastAnswer = undefined; this.resetCandidates();
      try {
        await t.replaceTransport(undefined, candidate.route);
        this.streamFallback?.useRoute(candidate.route);
        await this.signal.send({ type: 'stream-warm-activated', session: candidate.session, route: candidate.route, epoch: candidate.epoch }, true);
      } finally { this.clearWarm(candidate); this.reportRoute(); }
    }
  }
  async connect(endpoint: string, room: string, role: string, token: string) {
    if (role === 'receiver') this.waitingTimer = setTimeout(() => {
      if (!this.offered) this.transfer.fail('发送方尚未响应。请让发送方回到网页并保持手机解锁，或创建新链接。');
    }, 90000);
    await this.signal.connect(endpoint, room, role, token, () => this.transfer.pairingStage('配对连接暂时中断，正在重试'));
  }
  resumePage() {
    if (this.closed || this.transfer.stopped || this.transfer.completed) return;
    this.signal.resumePage(); this.transfer.resumePage();
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
    await this.signal.send({ type, epoch: this.epoch, description, ...(type === 'answer' ? { peerInfo: localPeerInfo() } : {}), ...(this.streamFallback ? { streamSupport: 1, warmSupport: 1, quickRelaySupport: 1 } : {}) });
    this.descriptionSent = true; this.scheduleCandidates();
  }
  private async applyCandidates() {
    const t = this.transfer, epoch = this.epoch;
    if (!this.directAvailable || this.streamFallback?.active) { this.remoteCandidates = []; return; }
    const pc = t.pc;
    const stale = () => this.closed || t.stopped || epoch !== this.epoch || t.pc !== pc || pc.signalingState === 'closed';
    if (stale()) { this.remoteCandidates = []; return; }
    if (!pc.remoteDescription) return;
    for (const candidate of this.remoteCandidates.splice(0)) {
      if (stale()) return;
      const id = JSON.stringify(candidate);
      if (this.seenCandidates.has(id)) continue;
      try { await pc.addIceCandidate(candidate ?? undefined); }
      catch (error) {
        if (stale()) return;
        throw error;
      }
      this.seenCandidates.add(id);
    }
  }
  private async handle(message: any, authenticated = false) {
    const t = this.transfer;
    if (this.closed || t.stopped) return;
    // Service presence/lifecycle notices are unencrypted. SDP, ICE candidates,
    // restart requests and peer errors must come through authenticated unseal().
    // Otherwise a compromised/custom signaling service could inject its own
    // DTLS fingerprints instead of merely relaying encrypted peer negotiation.
    if (!authenticated && !['signal-ready', 'peer-ready', 'peer-left', 'receiver-left', 'ended'].includes(message?.type)) return;
    if (message.type === 'transport-capabilities') {
      if (message.v !== 1 || typeof message.direct !== 'boolean' || message.streamSupport !== 1 || !this.streamFallback) return;
      this.peerDirectSupported = message.direct;
      this.peerCapabilitiesReceived = true; clearTimeout(this.capabilitiesTimer);
      this.streamFallback.supported = true; this.streamFallback.quickSupported = message.quickRelaySupport === 1;
      const peerInfo = readPeerInfo(message.peerInfo); if (peerInfo) t.reportPeerInfo(peerInfo);
      if (!this.directAvailable) { await this.announceCapabilities(); this.relayOnly(); }
      return;
    }
    if (['stream-select', 'stream-choice'].includes(message?.type)) {
      if (!this.streamFallback?.state.available || !['direct', 'stream'].includes(message.route)) return;
      if (message.route === 'direct' && !this.directAvailable) return;
      if (message.type === 'stream-select' && t.role === 'sender') void this.commitRouteChoice(message.route).catch(() => {
        if (!this.closed && !t.stopped && !t.completed) this.onError('暂时无法切换路线，请稍后重试。');
      });
      else if (message.type === 'stream-choice' && t.role === 'receiver') {
        if (Number.isInteger(message.epoch) && message.epoch > this.epoch) {
          this.epoch = message.epoch; this.lastOffer = this.lastAnswer = undefined; this.resetCandidates();
        }
        clearTimeout(this.routeRequestTimer); this.pendingRoute = undefined; this.streamFallback.choose(message.route, message.directFailed === true); this.reportRoute();
      }
      return;
    }
    if (typeof message?.type === 'string' && message.type.startsWith('stream-warm-')) { await this.handleWarm(message); return; }
    if (typeof message?.type === 'string' && message.type.startsWith('stream-')) { await this.streamFallback?.handle(message); return; }
    if (message.type === 'signal-ready') {
      if (!t.directSupported) await this.announceCapabilities(true);
      if (message.peerPresent) this.waitForCapabilities();
      if (!this.offered && t.role === 'receiver') t.pairingStage(message.peerPresent ? '找到发送方，正在交换连接信息' : '等待发送方回到页面');
    } else if (message.type === 'peer-ready') {
      if (!t.directSupported) { await this.announceCapabilities(true); this.waitForCapabilities(); return; }
      if (!this.peerDirectSupported) { await this.announceCapabilities(); this.relayOnly(); return; }
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
      if (message.epoch === this.epoch + 1 && (!t.transportConnected || t.recovering)) {
        this.epoch = message.epoch; this.lastOffer = this.lastAnswer = undefined; this.resetCandidates();
        this.streamFallback?.peerAdvancedEpoch();
      }
      t.requestRecovery();
      if (!this.negotiating && this.lastOffer) await this.sendDescription('offer', t.pc.localDescription?.toJSON() ?? this.lastOffer);
    } else if (message.type === 'offer' && t.role === 'receiver') {
      if (!Number.isInteger(message.epoch) || message.epoch < 0 || message.epoch < this.epoch) return;
      if (!this.directAvailable) {
        if (this.streamFallback) { this.streamFallback.supported = message.streamSupport === 1; this.streamFallback.quickSupported = message.quickRelaySupport === 1; }
        await this.announceCapabilities(); this.waitForCapabilities(); this.relayOnly(); return;
      }
      if (this.offered && message.epoch === this.epoch) {
        if (this.lastAnswer) await this.sendDescription('answer', t.pc.localDescription?.toJSON() ?? this.lastAnswer);
        return;
      }
      if (this.streamFallback) { this.streamFallback.supported = message.streamSupport === 1; this.streamFallback.useNative(); }
      if (this.streamFallback) this.streamFallback.quickSupported = message.quickRelaySupport === 1;
      this.warmSupported = message.warmSupport === 1; t.enableStandby(this.warmSupported);
      if (this.offered) { t.pauseRecovery(); this.resetCandidates(); await t.replaceTransport(); }
      clearTimeout(this.waitingTimer);
      this.offered = true; this.epoch = message.epoch;
      t.pairingStage('配对信息已交换，正在寻找直连路径');
      this.lastAnswer = await t.answer(message.description, true);
      await this.applyCandidates();
      await this.sendDescription('answer', this.lastAnswer);
    } else if (message.type === 'answer' && t.role === 'sender') {
      if (!this.directAvailable) return;
      if (message.epoch === this.epoch && t.pc.signalingState === 'have-local-offer') {
        const peerInfo = readPeerInfo(message.peerInfo);
        if (this.streamFallback) this.streamFallback.supported = message.streamSupport === 1;
        if (this.streamFallback) this.streamFallback.quickSupported = message.quickRelaySupport === 1;
        this.warmSupported = message.warmSupport === 1; t.enableStandby(this.warmSupported);
        await t.finish(message.description); await this.applyCandidates();
        if (peerInfo) t.reportPeerInfo(peerInfo);
        this.streamFallback?.negotiated();
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
    } else if (message.type === 'source-unavailable-ack' && authenticated && t.role === 'sender') {
      this.sourceFailureAck?.();
    } else if (message.type === 'source-unavailable' && authenticated && t.role === 'receiver') {
      await this.signal.send({ type: 'source-unavailable-ack' }, true).catch(() => {});
      t.fail('发送方无法读取原文件，请让对方重新选择本机原文件后再试。');
    } else if (message.type === 'ended') {
      if (t.completed) this.close();
      else t.fail('对方已结束传输，或页面已关闭。');
    } else if (message.type === 'peer-left' && !t.completed) {
      if (!this.offered) t.pairingStage(t.role === 'receiver' ? '等待发送方回到页面' : '等待接收方');
      // Losing signaling alone says nothing about a live DTLS/SCTP channel.
      // Let actual transport failures or the existing data heartbeat recover it.
      else if (!t.transportConnected) t.requestRecovery();
    }
  }
  private async recover() {
    const t = this.transfer;
    if (this.closed || t.stopped || t.completed || this.negotiating || this.streamFallback?.busy || Date.now() - this.lastAttempt < 10000) return;
    if (this.warm || this.pendingRoute) return;
    if (this.directTrial) { if (this.directTrial.attempted) return; this.directTrial.attempted = true; }
    if (this.streamFallback?.active) {
      this.lastAttempt = Date.now();
      if (t.role === 'receiver') await this.signal.send({ type: 'restart-request', epoch: this.epoch }).catch(() => {});
      else this.streamFallback.reconnect();
      return;
    }
    if (!this.directAvailable) { this.monitorRoute(); return; }
    this.negotiating = true;
    const revision = this.revision;
    try {
      await this.signal.ready();
      if (this.closed || t.stopped || revision !== this.revision) return;
      this.lastAttempt = Date.now();
      if (t.role === 'receiver') await this.signal.send({ type: 'restart-request', epoch: this.epoch });
      else {
        this.epoch++; this.offered = true; this.lastOffer = undefined; this.resetCandidates();
        await t.replaceTransport();
        if (revision !== this.revision || this.closed || t.stopped) return;
        this.lastOffer = await t.offer(true);
        if (revision !== this.revision || this.closed || t.stopped) return;
        await this.sendDescription('offer', this.lastOffer);
      }
    } catch { /* Preserve the checkpoint and retry until the recovery deadline. */ }
    finally { if (revision === this.revision) this.negotiating = false; }
  }
  close() { this.closed = true; this.pendingRoute = undefined; this.clearDirectTrial(); if (this.warm) this.clearWarm(this.warm); this.streamFallback?.close(); this.sourceFailureAck?.(); this.sourceFailureAck = undefined; clearInterval(this.retry); clearInterval(this.routeMonitor); clearTimeout(this.routeRequestTimer); clearTimeout(this.candidateTimer); clearTimeout(this.waitingTimer); clearTimeout(this.capabilitiesTimer); this.signal.close(); }
}

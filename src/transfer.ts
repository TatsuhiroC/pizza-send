import './browser-compat';
import { safeName } from './file-name';
import { hex, toBase64, fromBase64 } from './protocol-codec';
import type { PeerInfo } from './peer-info';
import { readSource, SourceReadError } from './source-files';
import { sha256 } from '@noble/hashes/sha2.js';
import { createFileHash, type FileHash } from './file-hash';
import { downloadType } from './download';
import { TransferFlow } from './transfer-flow';
import type { StreamChannel, DataChannel } from './stream-channel';
import { StandbyTransport, standbyNonce } from './standby-transport';
import type { RouteState, TransferRoute } from './stream-fallback';
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

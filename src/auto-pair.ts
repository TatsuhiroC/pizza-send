import type { Transfer } from './transfer';
import { Signaling } from './signaling';
import { randomToken } from './protocol-codec';
import { localPeerInfo, readPeerInfo } from './peer-info';
import { StreamFallback, type TransferRoute } from './stream-fallback';

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

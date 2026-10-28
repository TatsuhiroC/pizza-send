// Explicit diagnostic links only. Nothing is sampled or sent on ordinary links.
export const connectionDiagnosticsEnabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('connection-debug') === '1';
const MAX_TRACES = 12, MAX_SAMPLES = 120, INTERVAL_MS = 1000, PEER_INTERVAL_MS = 10000;
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
const integer = (value: unknown) => { const n = numeric(value); return n === undefined ? undefined : Math.round(n); };
const choice = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
type Native = Record<string, string | number | undefined>;
export type DiagnosticInput = {
  pc?: RTCPeerConnection; role: 'sender' | 'receiver'; generation: number; started: number;
  sent: number; acknowledged: number; received: number; buffered: number; queued: number; window: number;
  sourceBytes: number; sourceMs: number; sinkBytes: number; sinkMs: number;
  completed: boolean; stopped: boolean; recovering: boolean; hidden: boolean; peerHidden: boolean;
  transport?: 'webrtc' | 'websocket'; connectionOpen?: boolean;
};
type Row = Native & { atMs: number };
type Trace = { id: number; role: string; ended: boolean; samples: Row[]; peer?: Record<string, number>; peerAtMs?: number };
type Reader = { read: () => DiagnosticInput; trace: Trace; origin: number; native: Native; nativeAt: number; nativePeer?: RTCPeerConnection; pending?: object; pendingPeer?: RTCPeerConnection; lastPeerAt: number };
export type DiagnosticHandle = { close(): void; packet(): Record<string, number> | undefined; receive(value: unknown): void };
const readers = new Map<number, Reader>(), traces: Trace[] = [];
let sequence = 0, timer: ReturnType<typeof setInterval> | undefined;

function addressKind(value: unknown) {
  if (typeof value !== 'string') return 'unknown';
  if (value.endsWith('.local')) return 'mdns';
  if (value.includes(':')) return /^(?:f[cd]|fe[89ab])/i.test(value) || value === '::1' ? 'ipv6-private' : 'ipv6-public';
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return 'unknown';
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)) return 'ipv4-shared';
  return /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value) ? 'ipv4-private' : 'ipv4-public';
}

// Explicit allowlist: never retain raw stats, candidate IDs, addresses, URLs,
// certificates, browser identifiers, file names or share credentials.
export function sanitizedConnectionStats(report: RTCStatsReport): Native {
  const result: Native = {};
  let pair: any;
  report.forEach(item => {
    if (item.type === 'transport' && item.selectedCandidatePairId) pair = report.get(item.selectedCandidatePairId);
  });
  if (!pair) report.forEach(item => { if (item.type === 'candidate-pair' && item.selected === true) pair = item; });
  if (pair) {
    const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
    result.protocol = choice(local?.protocol, ['udp', 'tcp']);
    if (local?.candidateType === 'relay') result.relayProtocol = choice(local?.relayProtocol, ['udp', 'tcp', 'tls', 'dtls']);
    result.localCandidate = choice(local?.candidateType, ['host', 'srflx', 'prflx', 'relay']);
    result.remoteCandidate = choice(remote?.candidateType, ['host', 'srflx', 'prflx', 'relay']);
    result.localAddressKind = addressKind(local?.address);
    result.remoteAddressKind = addressKind(remote?.address);
    result.networkType = choice(local?.networkType, ['wifi', 'ethernet', 'vpn', 'cellular']);
    const rtt = numeric(pair.currentRoundTripTime);
    result.stunRoundTripMs = rtt === undefined ? undefined : Math.round(rtt * 1000);
    result.pairBytesSent = integer(pair.bytesSent); result.pairBytesReceived = integer(pair.bytesReceived);
    result.pairPacketsSent = integer(pair.packetsSent); result.pairPacketsReceived = integer(pair.packetsReceived);
    result.localSendDiscardedPackets = integer(pair.packetsDiscardedOnSend);
  }
  let hasChannel = false, sent = 0, received = 0;
  report.forEach(item => {
    if (item.type !== 'data-channel') return;
    if (numeric(item.bytesSent) !== undefined && numeric(item.bytesReceived) !== undefined) {
      hasChannel = true; sent += item.bytesSent; received += item.bytesReceived;
    }
  });
  if (hasChannel) { result.channelBytesSent = integer(sent); result.channelBytesReceived = integer(received); }
  return result;
}

const peerFields = ['g', 's', 'a', 'r', 'b', 'q', 'rb', 'rm', 'wb', 'wm', 'bs', 'br', 'ps', 'pr', 'h', 'x'] as const;
export function sanitizedPeerDiagnostics(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (data.v !== 1 || numeric(data.g) === undefined || numeric(data.s) === undefined || numeric(data.r) === undefined) return;
  const result: Record<string, number> = { v: 1 };
  for (const key of peerFields) {
    if (data[key] === undefined) continue;
    if ((key === 'h' || key === 'x') && data[key] !== 0 && data[key] !== 1) return;
    const n = integer(data[key]); if (n === undefined) return;
    result[key] = n;
  }
  return result;
}

function notify() { window.dispatchEvent(new Event('pizzasend-diagnostics-change')); }
function append(reader: Reader, input: DiagnosticInput, now: number) {
  const previous = reader.trace.samples[reader.trace.samples.length - 1], confirmed = input.role === 'sender' ? input.acknowledged : input.received;
  const atMs = Math.round(now - reader.origin), elapsed = input.started ? Math.max(1, now - input.started) : 0;
  const recentBps = previous && atMs - previous.atMs >= 500 ? Math.round(Math.max(0, confirmed - Number(previous.confirmed || 0)) * 1000 / (atMs - previous.atMs)) : previous?.recentBps;
  const row: Row = {
    ...(input.transport === 'websocket' ? {} : reader.native), atMs, generation: integer(input.generation), confirmed: integer(confirmed), sent: integer(input.sent),
    averageBps: elapsed ? Math.round(confirmed * 1000 / elapsed) : 0, recentBps,
    buffered: integer(input.buffered), inFlight: integer(Math.max(0, input.sent - input.acknowledged)), queued: integer(input.queued), window: integer(input.window),
    sourceBytes: integer(input.sourceBytes), sourceReadAndHashMs: integer(input.sourceMs), sinkBytes: integer(input.sinkBytes), sinkHashAndWriteMs: integer(input.sinkMs),
    hidden: Number(input.hidden), peerHidden: Number(input.peerHidden), recovering: Number(input.recovering), completed: Number(input.completed),
    transport: input.transport || 'webrtc',
    connection: input.transport === 'websocket' ? input.connectionOpen ? 'connected' : 'closed' : choice(input.pc?.connectionState, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
    ice: input.transport === 'websocket' ? 'not-applicable' : choice(input.pc?.iceConnectionState, ['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']),
    nativeAgeMs: reader.nativeAt ? Math.round(now - reader.nativeAt) : undefined
  };
  reader.trace.samples.push(row);
  if (reader.trace.samples.length > MAX_SAMPLES) reader.trace.samples.shift();
}
function sample() {
  for (const reader of readers.values()) {
    const input = reader.read(), pc = input.pc, now = performance.now();
    if (reader.nativePeer !== pc) { reader.nativePeer = pc; reader.native = {}; reader.nativeAt = 0; }
    if (input.transport === 'websocket') { reader.native = {}; reader.nativeAt = 0; }
    append(reader, input, now);
    if (input.completed || input.stopped) { reader.trace.ended = true; readers.delete(reader.trace.id); continue; }
    if (!pc || input.transport === 'websocket' || (reader.pending && reader.pendingPeer === pc) || pc.connectionState === 'closed') continue;
    const pending = {}; reader.pending = pending; reader.pendingPeer = pc;
    void Promise.resolve().then(() => pc.getStats()).then(report => {
      if (readers.get(reader.trace.id) !== reader || reader.read().pc !== pc || reader.read().transport === 'websocket') return;
      reader.native = sanitizedConnectionStats(report); reader.nativeAt = performance.now();
    }).catch(() => {}).finally(() => { if (reader.pending === pending) { reader.pending = undefined; reader.pendingPeer = undefined; } });
  }
  if (!readers.size) { clearInterval(timer); timer = undefined; }
  notify();
}

export function watchConnectionDiagnostics(read: () => DiagnosticInput): DiagnosticHandle | undefined {
  if (!connectionDiagnosticsEnabled || readers.size >= MAX_TRACES) return;
  while (traces.length >= MAX_TRACES) {
    const index = traces.findIndex(trace => trace.ended); if (index < 0) return;
    traces.splice(index, 1);
  }
  const input = read(), trace: Trace = { id: ++sequence, role: input.role, ended: false, samples: [] };
  const reader: Reader = { read, trace, origin: performance.now(), native: {}, nativeAt: 0, nativePeer: input.pc, lastPeerAt: -Infinity };
  traces.push(trace); readers.set(trace.id, reader);
  if (!timer) timer = setInterval(sample, INTERVAL_MS);
  return {
    close() {
      if (!readers.has(trace.id)) return;
      const input = read();
      if (reader.nativePeer !== input.pc) { reader.native = {}; reader.nativeAt = 0; }
      append(reader, input, performance.now()); trace.ended = true; readers.delete(trace.id);
      if (!readers.size) { clearInterval(timer); timer = undefined; }
      notify();
    },
    packet() {
      const now = performance.now();
      if (!readers.has(trace.id) || now - reader.lastPeerAt < PEER_INTERVAL_MS) return;
      reader.lastPeerAt = now;
      const value = read();
      const native = value.transport === 'websocket' ? {} : reader.native;
      return sanitizedPeerDiagnostics({ v: 1, g: value.generation, s: value.sent, a: value.acknowledged, r: value.received, b: value.buffered, q: value.queued,
        rb: value.sourceBytes, rm: value.sourceMs, wb: value.sinkBytes, wm: value.sinkMs,
        bs: native.pairBytesSent, br: native.pairBytesReceived, ps: native.pairPacketsSent, pr: native.pairPacketsReceived,
        h: Number(value.hidden), x: Number(value.recovering) });
    },
    receive(value) {
      const packet = sanitizedPeerDiagnostics(value);
      if (!readers.has(trace.id) || !packet) return;
      trace.peer = packet; trace.peerAtMs = Math.round(performance.now() - reader.origin);
    }
  };
}

export function connectionDiagnosticReport(latestOnly = false) {
  return { schema: 1, enabled: connectionDiagnosticsEnabled, intervalMs: INTERVAL_MS, maxSamples: MAX_SAMPLES,
    traces: traces.map(trace => ({ ...trace, samples: (latestOnly ? trace.samples.slice(-1) : trace.samples).map(sample => ({ ...sample })), peer: trace.peer ? { ...trace.peer } : undefined })) };
}

export function mountConnectionDiagnostics(root: HTMLElement) {
  if (!connectionDiagnosticsEnabled) return;
  const panel = document.createElement('details'); panel.className = 'faq connection-diagnostics'; panel.id = 'connection-diagnostics';
  const heading = document.createElement('summary'); heading.textContent = '连接诊断（仅本机与传输对端）';
  const note = document.createElement('p'); note.textContent = '诊断链接会记录速度、缓冲和连接类型，并向当前传输对端附带匿名计数；不含文件内容、文件名、IP 地址或分享密钥，不上传到服务器。';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = '导出诊断记录';
  const preview = document.createElement('pre'); preview.id = 'connection-diagnostics-summary';
  const render = () => {
    preview.textContent = JSON.stringify(connectionDiagnosticReport(true), null, 2);
  };
  button.onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(connectionDiagnosticReport(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pizzasend-connection-report.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  panel.append(heading, note, button, preview); root.querySelector('.transfer-card')?.after(panel);
  window.addEventListener('pizzasend-diagnostics-change', render); render();
}

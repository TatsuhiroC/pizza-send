import { PairingConnectionError, PairingResponseError, retryInitialPairing, retryPairingRequest, ticketURL } from './security';
import { randomToken, seal, unseal } from './protocol-codec';
import { StreamChannel } from './stream-channel';
import { StreamCipher } from './stream-cipher';

// Explicit disposal must not look like a network failure and start reconnecting.
export function releaseSignalingSocket(socket: WebSocket) {
  socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
  socket.close();
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
          releaseSignalingSocket(socket); reject(error);
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
    if (socket) releaseSignalingSocket(socket);
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
      releaseSignalingSocket(this.socket);
    }
  }
}

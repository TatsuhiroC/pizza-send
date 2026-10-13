import { authenticatedRequest, ticketURL } from './security';
import { Transfer, AutoPair, randomToken, signalKey, type Config, type TransferEvent } from './protocol';
import { deriveRecipientShare, receiverDigest } from './share';

export type Recipient = {
  client: string; number: number; phase: 'pairing' | 'waiting' | 'sending' | 'recovering' | 'done' | 'error' | 'left';
  message: string; file: string; transferred: number; total: number; speed: number; path: string; started: boolean;
  transfer?: Transfer; pair?: AutoPair; verification?: string;
};
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function groupURL(api: string, room: string, role: 'sender' | 'receiver', token: string, client: string) {
  const url = new URL('/rooms/' + room, api); url.search = new URLSearchParams({ role, token, client }).toString(); return url.toString();
}
export async function groupRequest(url: string, body?: unknown, keepalive = false) {
  const response = await authenticatedRequest(url, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), keepalive, signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    if (response.status === 429) {
      const reason = await response.text();
      throw Error(reason.includes('Recipient limit reached') || reason === 'Invitation unavailable' ? '同时接收的人数已达 10 位，请稍后再试。' : '请求过于频繁，请稍后重试或使用手动配对。');
    }
    throw Error(response.status === 410 ? '分享链接已过期或发送方已结束，请创建新链接。' : response.status === 409 ? '分享链接已被另一接收页面占用，请关闭原页面或创建新链接。' : '无法连接配对服务');
  }
  return response.json();
}
export class GroupSender {
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private queue = Promise.resolve();
  private lastSeen = 0;
  private peers = new Map<string, Recipient>();
  private retired = new Set<string>();
  private pendingRetire = new Set<string>();
  private firstClient?: string;
  private counter = 0;
  private closed = false;
  private expired = false;
  private timer?: ReturnType<typeof setTimeout>;
  private url: string;
  private inviteExpiresAt = Infinity;
  constructor(private initial: Transfer, private config: Config, private files: File[], private secret: string,
    private api: string, room: string, token: string, private changed: (peers: Recipient[], expired: boolean) => void, private onError: (message: string) => void) {
    this.url = groupURL(api, room, 'sender', token, randomToken());
  }
  get active() { return [...this.peers.values()].some(peer => !['done', 'error', 'left'].includes(peer.phase)); }
  async connect() { await this.poll(); this.schedule(); }
  firstEvent(event: TransferEvent) { if (this.firstClient) this.event(this.firstClient, event); }
  private notify() { if (!this.closed) this.changed([...this.peers.values()], this.expired || Date.now() >= this.inviteExpiresAt); }
  private schedule() {
    if (this.closed || this.expired) return;
    this.timer = setTimeout(() => { void this.poll().catch(error => {
      if (!this.closed) this.onError(error.message);
    }).finally(() => this.schedule()); }, 1500);
  }
  private async poll() {
    await Promise.allSettled([...this.pendingRetire].map(async client => {
      await groupRequest(this.url, { type: 'finished', client }); this.pendingRetire.delete(client);
    }));
    if (this.closed) return;
    if (this.socket?.readyState === WebSocket.OPEN) { this.notify(); return; }
    let state;
    try { state = await groupRequest(this.url); }
    catch (error) {
      if ((error as Error).message.startsWith('分享链接已过期')) { this.expired = true; this.notify(); }
      throw error;
    }
    await this.consume(state);
    if (!this.closed) await this.openSocket();
  }
  private async consume(state: any) {
    if (this.closed) return;
    if (state.multi !== true || !Array.isArray(state.members) || state.members.length > 10 || !Number.isSafeInteger(state.inviteExpiresAt)) throw Error('配对服务尚不支持多人分享，请刷新后重试。');
    this.inviteExpiresAt = state.inviteExpiresAt;
    const listed = new Set<string>(state.members.map((member: any) => member.client));
    for (const peer of this.peers.values()) if (!listed.has(peer.client) && !this.retired.has(peer.client)) {
      peer.phase = 'left'; peer.message = '接收者已退出'; peer.pair?.close(); peer.transfer?.close(false); this.retired.add(peer.client);
    }
    await Promise.allSettled(state.members.filter((member: any) => !this.peers.has(member.client) && !this.retired.has(member.client)).map((member: any) => this.add(member)));
    this.notify();
  }
  private async openSocket() {
    const url = new URL(this.url); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const connectionURL = await ticketURL(url.toString());
    if (this.closed) return;
    const socket = this.socket = new WebSocket(connectionURL); this.lastSeen = Date.now();
    socket.onmessage = event => {
      if (this.closed || socket !== this.socket) return; this.lastSeen = Date.now();
      if (typeof event.data !== 'string' || event.data.length > 16384) { socket.close(); return; }
      this.queue = this.queue.then(async () => {
        const state = JSON.parse(event.data);
        if (state.type === 'members') await this.consume(state);
        else if (state.type === 'ended') { this.expired = true; this.notify(); }
      }).catch(error => { if (!this.closed) this.onError(error.message); });
    };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(Error('配对服务连接超时')); }, 10000);
      socket.onopen = () => {
        clearTimeout(timeout);
        if (this.closed) { socket.close(); reject(Error('配对服务已断开')); return; }
        clearInterval(this.heartbeat); this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastSeen > 30000) socket.close();
          else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'keepalive' }));
        }, 10000); resolve();
      };
      socket.onerror = () => { clearTimeout(timeout); reject(Error('无法连接配对服务')); };
      socket.onclose = () => { clearTimeout(timeout); reject(Error('配对服务已断开')); if (socket === this.socket) clearInterval(this.heartbeat); };
    });
  }
  private async add(member: any) {
    if (this.closed || ![member.client, member.room, member.receiverHash, member.sender].every(valid)) return;
    if (this.peers.size >= 30) for (const [id, old] of this.peers) {
      if (this.peers.size < 30) break;
      if (['done', 'error', 'left'].includes(old.phase) && !this.pendingRetire.has(id)) { this.peers.delete(id); this.retired.delete(id); }
    }
    const peer: Recipient = { client: member.client, number: ++this.counter, phase: 'pairing', message: '正在连接接收者', file: '', transferred: 0, total: this.files.reduce((sum, file) => sum + file.size, 0), speed: 0, path: '', started: false };
    this.peers.set(peer.client, peer); this.notify();
    try {
      const share = await deriveRecipientShare(this.secret, peer.client);
      if (share.room !== member.room || await receiverDigest(share.receiver) !== member.receiverHash) throw Error('配对信息无效');
      const key = await signalKey(share.secret);
      if (this.closed || this.retired.has(peer.client)) return;
      if (!this.firstClient) { this.firstClient = peer.client; peer.transfer = this.initial; }
      else { peer.transfer = new Transfer(this.config, 'sender', event => this.event(peer.client, event)); peer.transfer.prepare(this.files); }
      peer.pair = new AutoPair(peer.transfer, key, message => { if (!this.closed) { peer.message = message; this.notify(); } });
      await peer.pair.connect(this.api, share.room, 'sender', member.sender);
      if (this.closed) { peer.pair.close(); peer.transfer.close(false); }
    } catch (error) { if (!this.closed) this.event(peer.client, { type: 'error', data: (error as Error).message }); }
  }
  private event(client: string, event: TransferEvent) {
    const peer = this.peers.get(client); if (!peer || this.closed || this.retired.has(client)) return;
    if (event.type === 'verification') peer.verification = event.data;
    else if (event.type === 'pairing') peer.message = event.data;
    else if (event.type === 'connected') { peer.phase = 'waiting'; peer.message = '等待接收者确认'; }
    else if (event.type === 'started' || event.type === 'resumed') { peer.phase = 'sending'; peer.started = true; peer.message = '正在传输'; }
    else if (event.type === 'recovering') { peer.phase = 'recovering'; peer.message = '网络切换，正在恢复连接'; }
    else if (event.type === 'file') peer.file = event.data;
    else if (event.type === 'path') peer.path = event.data;
    else if (event.type === 'progress') { peer.transferred = event.data.transferred; peer.total = event.data.total; peer.speed = event.data.speed; }
    else if (event.type === 'done' || event.type === 'error') {
      peer.phase = event.type === 'done' ? 'done' : /对方已取消|对方已结束|接收方已结束/.test(event.data) ? 'left' : 'error'; peer.message = event.type === 'done' ? '传输完成，原样送达。' : event.data;
      if (event.type === 'done') peer.transferred = peer.total;
      this.retired.add(client); this.pendingRetire.add(client);
      peer.pair?.close(); peer.transfer?.close(false);
      void groupRequest(this.url, { type: 'finished', client }).then(() => this.pendingRetire.delete(client)).catch(() => {});
    }
    this.notify();
  }
  close(notify = true) {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer); clearInterval(this.heartbeat);
    if (notify && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'end' }));
    this.socket?.close();
    for (const peer of this.peers.values()) { peer.transfer?.close(notify); peer.pair?.close(); }
    if (notify) void groupRequest(this.url, { type: 'end' }, true).catch(() => {});
  }
}

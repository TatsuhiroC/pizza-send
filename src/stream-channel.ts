import { StreamCipher, MAX_STREAM_FRAME } from './stream-cipher';

// The file protocol needs an ordered, reliable byte channel. It does not need
// to imitate RTCPeerConnection or change its acknowledgements / save logic.
export interface DataChannel {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: RTCErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onbufferedamountlow: ((event: Event) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}

export class StreamChannel implements DataChannel {
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmountLowThreshold = 256 * 1024;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onbufferedamountlow: ((event: Event) => void) | null = null;
  readonly ready: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  private socket: WebSocket;
  private sendQueue = Promise.resolve();
  private receiveQueue = Promise.resolve();
  private outgoing = 0;
  private incoming = 0;
  private records = 0;
  private receivedWire = 0;
  private requestedCredit = 0;
  private controls = 0;
  private timeout: ReturnType<typeof setTimeout>;
  private drain?: ReturnType<typeof setTimeout>;
  get bufferedAmount() { return this.outgoing + this.socket.bufferedAmount; }
  constructor(url: string, private cipher: StreamCipher) {
    this.ready = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.ready.catch(() => {});
    this.socket = new WebSocket(url); this.socket.binaryType = 'arraybuffer';
    this.timeout = setTimeout(() => this.fail(), 30000);
    this.socket.onerror = () => this.fail();
    this.socket.onclose = () => this.close();
    this.socket.onmessage = event => {
      if (this.readyState === 'closed') return;
      if (typeof event.data === 'string') {
        try {
          if (event.data.length > 128) throw Error();
          const message = JSON.parse(event.data);
          if (message.type === 'stream-ready') {
            if (this.readyState === 'connecting') {
              this.readyState = 'open'; clearTimeout(this.timeout); this.resolve(); this.onopen?.(new Event('open'));
            }
          } else {
            if (message.type !== 'credit-request' || this.readyState !== 'open' || !Number.isSafeInteger(message.bytes) ||
              message.bytes <= this.requestedCredit || message.bytes > this.receivedWire + this.incoming || !/^[a-f0-9]{64}$/.test(message.nonce) || this.controls >= 8) throw Error();
            this.requestedCredit = message.bytes; this.controls++;
            this.receiveQueue = this.receiveQueue.then(() => {
              if (this.readyState !== 'open') return;
              if (message.bytes > this.receivedWire) throw Error();
              this.socket.send(JSON.stringify({ type: 'credit', bytes: message.bytes, nonce: message.nonce }));
            }).catch(() => this.fail()).finally(() => { this.controls--; });
          }
        } catch { this.fail(); }
        return;
      }
      const frame = event.data;
      if (!(frame instanceof ArrayBuffer) || frame.byteLength > MAX_STREAM_FRAME || this.incoming + frame.byteLength > 8 * 1048576 || this.records >= 4096) { this.fail(); return; }
      this.incoming += frame.byteLength; this.records++;
      this.receiveQueue = this.receiveQueue.then(async () => {
        if (this.readyState !== 'open') return;
        const data = await cipher.decrypt(frame);
        if (this.readyState !== 'open') return;
        this.onmessage?.(new MessageEvent('message', { data }));
        this.receivedWire += frame.byteLength;
      }).catch(() => this.fail()).finally(() => { this.incoming -= frame.byteLength; this.records--; });
    };
  }
  send(value: string | ArrayBuffer) {
    const size = (typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength) + 24;
    if (this.readyState !== 'open' || size > MAX_STREAM_FRAME || this.bufferedAmount + size > 2 * 1048576) throw Error('Stream backpressure');
    const copy = typeof value === 'string' ? value : value.slice(0);
    this.outgoing += size;
    this.sendQueue = this.sendQueue.then(async () => {
      if (this.readyState !== 'open') return;
      const frame = await this.cipher.encrypt(copy);
      if (this.readyState === 'open') this.socket.send(frame);
    }).catch(() => this.fail()).finally(() => { this.outgoing -= size; });
    this.watchDrain();
  }
  private watchDrain() {
    if (this.drain || this.readyState !== 'open') return;
    this.drain = setTimeout(() => {
      this.drain = undefined;
      if (this.readyState !== 'open') return;
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.(new Event('bufferedamountlow'));
      else this.watchDrain();
    }, 8);
  }
  private fail() {
    if (this.readyState === 'closed') return;
    this.onerror?.(new Event('error')); this.close();
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed'; clearTimeout(this.timeout); clearTimeout(this.drain);
    this.reject(Error('加密转发暂时不可用'));
    this.socket.onmessage = this.socket.onerror = this.socket.onclose = null;
    this.socket.close(); this.onclose?.(new Event('close'));
  }
}

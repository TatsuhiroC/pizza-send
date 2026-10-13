import { setText } from './i18n';

export type SaveItem = { key: string; url: string; name: string; size: number; type: string };
const MAX_SHARE_BYTES = 64 * 1048576;
const appleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
export const needsIndividualDownloads = () => appleMobile() || /Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR|Android/.test(navigator.userAgent);
type Batch = { signature: string; items: SaveItem[]; abort: AbortController; mode: 'preparing' | 'native' | 'individual'; files?: File[] };
type Single = { item: SaveItem; abort: AbortController; promise: Promise<File | undefined>; preparing: boolean; file?: File };
type SaveLink = { item: SaveItem; link: HTMLAnchorElement };
type Options = {
  button: HTMLButtonElement; note: HTMLElement; dialog: HTMLDialogElement; next: HTMLAnchorElement; filename: HTMLElement; progress: HTMLElement; close: HTMLButtonElement;
  requested(items: SaveItem[], system?: boolean): void; retain(items: SaveItem[]): void; feedback(message: string, params?: Record<string, string | number>): void;
};
async function readOriginal(item: SaveItem, signal: AbortSignal) {
  const url = new URL(item.url);
  if (url.protocol !== 'blob:' || url.origin !== location.origin) throw Error('Invalid file URL');
  const response = await fetch(url, { signal });
  if (!response.ok) throw Error('File unavailable');
  const blob = await response.blob();
  if (blob.size !== item.size || signal.aborted) throw Error('File unavailable');
  return new File([blob], item.name, { type: item.type || blob.type });
}
function supportsFileSharing(items: SaveItem[]) {
  try {
    return appleMobile() && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: items.map(item => new File([], item.name, { type: item.type })) });
  } catch { return false; }
}

export class MobileBatchSave {
  readonly enabled = needsIndividualDownloads();
  private batch?: Batch;
  private sharing?: symbol;
  private queue?: { batch: Batch; index: number };
  private timer?: ReturnType<typeof setTimeout>;
  private singles = new Map<string, Single>();
  private links: SaveLink[] = [];
  // Prepare bounded originals before a click. Batch and individual saving share
  // these File objects instead of reading the same disk files twice.
  syncLinks(links: SaveLink[]) {
    if (!this.enabled) return;
    this.links = links;
    let remaining = MAX_SHARE_BYTES;
    const eligible = new Map<string, SaveItem>();
    for (const { item } of links) {
      if (eligible.has(item.key) || item.size > remaining || !supportsFileSharing([item])) continue;
      remaining -= item.size; eligible.set(item.key, item);
    }
    for (const [key, entry] of this.singles) {
      if (JSON.stringify(eligible.get(key)) === JSON.stringify(entry.item)) continue;
      entry.abort.abort(); this.singles.delete(key);
    }
    for (const [key, item] of eligible) {
      if (this.singles.has(key)) continue;
      const entry: Single = { item, abort: new AbortController(), preparing: true, promise: Promise.resolve(undefined) };
      this.singles.set(key, entry);
      entry.promise = readOriginal(item, entry.abort.signal).then(file => {
        if (this.singles.get(key) !== entry || entry.abort.signal.aborted) return;
        if (navigator.canShare({ files: [file] })) entry.file = file;
        return entry.file;
      }).catch(() => undefined).finally(() => {
        if (this.singles.get(key) !== entry) return;
        entry.preparing = false; this.presentLinks();
      });
    }
    for (const { item, link } of links) link.onclick = event => {
      const entry = this.singles.get(item.key);
      if (this.sharing || entry?.preparing) { event.preventDefault(); return; }
      if (entry?.file) { event.preventDefault(); this.openSingle(entry); return; }
      this.ui.retain([item]); this.ui.requested([item]);
    };
    this.presentLinks();
  }
  private presentLinks() {
    for (const { item, link } of this.links) {
      const entry = this.singles.get(item.key);
      const disabled = !!this.sharing || !!entry?.preparing;
      if (disabled) link.setAttribute('aria-disabled', 'true'); else link.removeAttribute('aria-disabled');
      if (entry?.preparing) link.setAttribute('aria-busy', 'true'); else link.removeAttribute('aria-busy');
      const label = link.querySelector('span');
      if (label) setText(label, entry?.preparing ? '正在准备保存…' : link.closest('#save-panel') ? '保存到设备' : '保存');
    }
  }
  private openSingle(entry: Single) {
    if (!entry.file || this.sharing) return;
    const token = this.sharing = Symbol(); this.present();
    const current = () => this.singles.get(entry.item.key) === entry && this.sharing === token;
    const failure = (error: unknown) => {
      if (!current()) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.ui.feedback('已取消保存，文件仍在暂存中，可以再次保存。');
      } else {
        entry.file = undefined;
        this.ui.feedback('系统保存面板暂不可用，请再次点按保存，使用浏览器下载。');
      }
    };
    try {
      const result = navigator.share({ files: [entry.file] });
      this.ui.retain([entry.item]);
      void result.then(() => {
        if (!current()) return;
        this.ui.requested([entry.item], true);
        this.ui.feedback('已将文件交给系统，请确认保存完成后再清理暂存。');
      }).catch(failure).finally(() => { if (this.sharing === token) { this.sharing = undefined; this.present(); } });
    } catch (error) { failure(error); this.sharing = undefined; this.present(); }
  }
  constructor(private ui: Options) {
    ui.close.onclick = () => this.closeQueue();
    ui.dialog.addEventListener('cancel', event => { event.preventDefault(); this.closeQueue(); });
    ui.dialog.addEventListener('close', () => { if (!ui.dialog.open) { this.queue = undefined; clearTimeout(this.timer); } });
    ui.next.onclick = event => {
      const queue = this.queue;
      if (!queue || queue.batch !== this.batch || queue.index >= queue.batch.items.length || ui.next.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      const item = queue.batch.items[queue.index];
      // Leave the anchor's native default action in this fresh user gesture.
      // Only update its URL on the next task, after the current download starts.
      this.ui.retain([item]); this.ui.requested([item]); queue.index++; ui.next.setAttribute('aria-disabled', 'true');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.queue === queue && this.batch === queue.batch) this.renderQueue(); }, 0);
    };
  }
  update(items: SaveItem[], revision: number) {
    if (!this.enabled) return;
    const signature = JSON.stringify([revision, items]);
    if (this.batch?.signature === signature) { this.present(); return; }
    this.cancelBatch();
    if (items.length < 2) return;
    const batch: Batch = { signature, items, abort: new AbortController(), mode: 'individual' };
    this.batch = batch;
    const total = items.reduce((sum, item) => sum + item.size, 0);
    const canShare = total <= MAX_SHARE_BYTES && supportsFileSharing(items);
    if (!canShare) { this.present(); return; }
    batch.mode = 'preparing'; this.present();
    void this.prepare(batch);
  }
  private async prepare(batch: Batch) {
    try {
      const files: File[] = [];
      for (const item of batch.items) {
        const entry = this.singles.get(item.key);
        const file = entry && JSON.stringify(entry.item) === JSON.stringify(item) ? await entry.promise : await readOriginal(item, batch.abort.signal);
        if (!file) throw Error('File unavailable');
        if (this.batch !== batch || batch.abort.signal.aborted) return;
        files.push(file);
      }
      if (this.batch !== batch || batch.abort.signal.aborted) return;
      if (navigator.canShare({ files })) { batch.files = files; batch.mode = 'native'; }
      else batch.mode = 'individual';
    } catch {
      if (this.batch !== batch || batch.abort.signal.aborted) return;
      batch.mode = 'individual';
    }
    this.present();
  }
  private present() {
    if (!this.enabled) return;
    this.presentLinks();
    const mode = this.batch?.mode;
    this.ui.button.disabled = mode === 'preparing' || !!this.sharing;
    setText(this.ui.button, mode === 'preparing' ? '正在准备保存…' : mode === 'native' ? '保存全部' : '逐个保存');
    setText(this.ui.note, mode === 'preparing' ? '正在准备原文件，请稍候。' : mode === 'native' ? '点按后在系统面板中选择“存储到文件”，一次保存全部原文件。图片也可选择系统提供的图片保存选项。' : '此浏览器需要逐个确认下载。点按后按提示保存每个文件。');
  }
  open() {
    const batch = this.batch;
    if (!batch || batch.mode === 'preparing' || this.sharing) return;
    if (batch.mode !== 'native' || !batch.files) { this.openQueue(); return; }
    const token = this.sharing = Symbol(); this.present();
    const current = () => this.batch === batch && this.sharing === token;
    let result: Promise<void>;
    try {
      // Files are ready before the click: do not await disk reads, retention or
      // any other task before share(), which consumes transient user activation.
      result = navigator.share({ files: batch.files });
      this.ui.retain(batch.items);
    } catch (error) { this.nativeFailure(batch, token, error); return; }
    void result.then(() => {
      if (!current()) return;
      this.ui.requested(batch.items, true);
      this.ui.feedback('已将 {count} 个文件交给系统，请确认保存完成后再清理暂存。', { count: batch.items.length });
    }).catch(error => { if (current()) this.nativeFailure(batch, token, error); }).finally(() => {
      if (this.sharing === token) { this.sharing = undefined; this.present(); }
    });
  }
  private nativeFailure(batch: Batch, token: symbol, error: unknown) {
    if (this.batch !== batch || this.sharing !== token) return;
    this.sharing = undefined;
    if (error instanceof DOMException && error.name === 'AbortError') {
      this.ui.feedback('已取消批量保存，文件仍在暂存中，可以再次保存。');
    } else {
      batch.files = undefined; batch.mode = 'individual';
      this.ui.feedback('系统批量保存暂不可用，请按提示逐个保存。'); this.openQueue();
    }
    this.present();
  }
  private openQueue() {
    if (!this.batch) return;
    this.queue = { batch: this.batch, index: 0 }; this.renderQueue();
    if (!this.ui.dialog.open) this.ui.dialog.showModal();
  }
  private renderQueue() {
    const queue = this.queue; if (!queue) return;
    const total = queue.batch.items.length;
    if (queue.index >= total) {
      this.closeQueue();
      this.ui.feedback('已逐个发起 {count} 个文件的保存，请确认浏览器下载完成后再清理暂存。', { count: total });
      return;
    }
    const item = queue.batch.items[queue.index];
    this.ui.next.removeAttribute('aria-disabled');
    this.ui.filename.textContent = item.name; this.ui.next.href = item.url; this.ui.next.download = item.name;
    setText(this.ui.next, '保存第 {number} 个文件（共 {total} 个）', { number: queue.index + 1, total });
    setText(this.ui.progress, '已发起 {count} / {total} 个文件的保存', { count: queue.index, total });
  }
  private closeQueue() {
    clearTimeout(this.timer); this.queue = undefined;
    this.ui.next.removeAttribute('href'); this.ui.next.removeAttribute('download');
    this.ui.next.removeAttribute('aria-disabled');
    this.ui.filename.textContent = '';
    if (this.ui.dialog.open) this.ui.dialog.close();
  }
  private cancelBatch() {
    this.batch?.abort.abort();
    if (this.batch) this.batch.files = undefined;
    this.batch = undefined; this.closeQueue();
  }
  cancel() {
    this.cancelBatch();
    for (const entry of this.singles.values()) entry.abort.abort();
    this.singles.clear(); this.links = []; this.sharing = undefined;
    if (this.enabled) this.present();
  }
}

import { parcelHero as heroPizza } from './parcel';
import { completionSymbol, DeliveryMotion } from './transfer-motion';
import './style.css';
import './parcel.css';
import './transfer-motion.css';
import './animation-preview.css';

const root = document.querySelector<HTMLElement>('#preview-app')!;
root.innerHTML = `<header class="header"><a class="brand" href="./animation-preview.html"><img src="./pizza.svg" alt="" width="38" height="38"/><span>PizzaSend<small>文件快传</small></span></a><span class="preview-badge">本地动效预览 · 尚未提交</span></header>
<main><section class="intro"><div class="eyebrow"><span></span>好东西，直接分享。</div><h1>文件送到，<br/><span>热乎刚好。</span>${heroPizza}</h1><p>一个位置，从装盒到送达。</p></section>
<section class="transfer-card preview-card"><div class="preview-actions"><button id="demo-select" class="secondary" type="button">① 选中文件</button><button id="demo-transfer" class="secondary" type="button">② 开始传输</button><button id="demo-complete" class="secondary" type="button">③ 传输完成</button><button id="demo-pause" class="secondary" type="button">暂停动画</button><button id="demo-reset" class="secondary" type="button">回到默认</button></div>
<p class="preview-scale">单片披萨：1 倍 · 披萨盒：1.5 倍</p>
<div class="session-heading"><span id="preview-dot" class="status-dot connected"></span><h2 id="preview-status">正在传输</h2><span class="preview-demo">演示</span></div><p id="preview-detail" class="subtle">只演示动效，不会发送文件。</p>
<div id="preview-picked" class="preview-picked" hidden><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#a78761" stroke-width="1.5" aria-hidden="true"><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6"/></svg><div><strong>假日照片.png</strong><small>文件已选好，披萨已放入盒中。</small></div></div>
<div id="preview-progress"><div class="progress-meta"><span>假日照片.png</span><span class="progress-result"><span id="preview-percent">42%</span><span id="preview-complete" class="completion-mark" aria-hidden="true" hidden>${completionSymbol}</span></span></div><progress id="preview-bar" max="100" value="42" aria-label="演示进度"></progress><div class="metrics"><div><span id="preview-size">42 MB / 100 MB</span><small>已传输 · 演示数据</small></div><div><span>8.9 MB/s</span><small>速度 · 演示数据</small></div><div><span id="preview-remaining">约 7 秒</span><small>预计剩余 · 演示数据</small></div></div><div class="path-label"><span>浏览器之间加密传输</span><span>SHA-256 校验</span></div></div>
</section><p class="preview-footnote">标题旁边的一处动画：单片披萨 → 装盒 → 关盖飞送 → 开盒送达。<br/>系统开启“减少动态效果”时显示静态图形。</p><p class="preview-reference">动效参考：<a href="https://lottiefiles.com/free-animation/fast-delivery-RzZz6OWqsT" target="_blank" rel="noopener">LottieFiles · 快速配送</a><span> / </span><a href="https://codepen.io/stuartjnelson/pen/jVqMNq" target="_blank" rel="noopener">CodePen · 火箭动效</a></p></main>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const motion = new DeliveryMotion(root.querySelector<HTMLElement>('.hero-pizza')!, el('preview-complete'));
const set = (state: 'idle' | 'selected' | 'transferring' | 'recovering' | 'done') => {
  motion.setState(state); el('preview-picked').hidden = state !== 'selected'; el('preview-progress').hidden = state === 'idle' || state === 'selected';
  el<HTMLButtonElement>('demo-pause').disabled = state === 'idle' || state === 'selected' || state === 'done';
  el('demo-pause').textContent = state === 'recovering' ? '恢复动画' : '暂停动画';
  el('preview-status').textContent = state === 'idle' ? '等你选择文件' : state === 'selected' ? '文件已选好' : state === 'done' ? '传输完成，原样送达。' : state === 'recovering' ? '网络切换，正在恢复连接' : '正在传输';
  el('preview-dot').className = 'status-dot ' + (state === 'recovering' ? 'waiting' : state === 'done' ? 'done' : 'connected');
  el('preview-detail').textContent = state === 'idle' ? '默认是一片披萨。点击“选中文件”，看它装入缺一片的披萨盒。' : state === 'selected' ? '披萨平放朝上；盒盖沿后侧斜边，从左下方朝右上方翻开。' : state === 'done' ? '盒盖打开，露出完整六片披萨。这里只演示动效。' : state === 'recovering' ? '速度线暂停，盒子保持原位。这里只演示动效。' : '盒盖关上，拖影和气流向后掠过，盒身保持原位。这里只演示动效。';
  el('preview-percent').textContent = state === 'done' ? '100%' : '42%'; el<HTMLProgressElement>('preview-bar').value = state === 'done' ? 100 : 42;
  el('preview-size').textContent = state === 'done' ? '100 MB / 100 MB' : '42 MB / 100 MB'; el('preview-remaining').textContent = state === 'done' ? '完成' : state === 'recovering' ? '等待网络恢复' : '约 7 秒';
  for (const [id, selected] of [['demo-select', state === 'selected'], ['demo-transfer', state === 'transferring' || state === 'recovering'], ['demo-complete', state === 'done']] as const) el(id).setAttribute('aria-pressed', String(selected));
};
el('demo-select').onclick = () => {
  // Replay the diagonal lid opening when reviewing its direction.
  if (motion.currentState === 'selected') {
    motion.setState('transferring');
    root.querySelector('.parcel-lid-face')!.getAnimations();
  }
  set('selected');
};
el('demo-transfer').onclick = () => set('transferring');
el('demo-complete').onclick = () => {
  motion.setState('transferring');
  // Let repeated preview clicks replay the mark without restarting real transfers.
  el('preview-complete').getAnimations();
  set('done');
};
el('demo-reset').onclick = () => set('idle');
el('demo-pause').onclick = () => set(motion.currentState === 'recovering' ? 'transferring' : 'recovering');
set('idle');

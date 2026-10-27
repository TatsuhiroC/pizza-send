<p align="right">
  简体中文 &nbsp; <a href="README.en.md"><img src="docs/assets/language-english.svg" alt="English" width="86" height="26" /></a>
</p>

<div align="center">
  <img src="docs/assets/readme-cover.svg" alt="PizzaSend — 好东西，直接分享。" width="960" />
  <h3>文件送到，热乎刚好。</h3>
  <p>不用安装，不用注册。同一 Wi-Fi，或电脑宽带与手机 5G，都能分享。</p>
  <p><a href="https://pizzasend.dpdns.org/"><img src="docs/assets/open-pizzasend-zh.svg" alt="打开 PizzaSend" width="174" height="40" /></a></p>
  <p><sub>跨网络传输 · WebRTC 直连 · 端到端加密转发 · 开源</sub></p>
</div>

## 好东西，直接分享

PizzaSend 是一个开源的浏览器文件快传工具。手机与电脑之间传照片、视频和文档，或把同一份文件分享给多位朋友，都只需要一个链接或二维码，无需先上传到网盘。

**不必连同一个 Wi-Fi。** 两台设备分别连接不同 Wi-Fi，或电脑使用家中宽带、手机使用 4G／5G，也可以传输。优先尝试直连；直连无法建立或持续过慢时，按需使用端到端加密转发。

<table width="100%">
  <thead><tr><th align="left">特性</th><th align="left">体验</th></tr></thead>
  <tbody>
    <tr><td><strong>跨网络分享</strong></td><td>支持同一局域网，也支持不同 Wi-Fi、宽带与移动网络之间传输。</td></tr>
    <tr><td><strong>加密传输</strong></td><td>设备直连优先，加密中继按需兜底；服务器不保存文件。</td></tr>
    <tr><td><strong>原样送达</strong></td><td>保留文件名与内容，逐个做 SHA-256 校验。</td></tr>
    <tr><td><strong>一起分享</strong></td><td>同一链接，最多 10 人同时接收，各自拥有独立进度。</td></tr>
  </tbody>
</table>

分享文件，也能扫码接收；电脑拖入文件夹会自动打包为 ZIP。网络切换可恢复，慢网时会按需建议压缩。

## 三步送达

1. **选好文件。** 点击直接选择文件，或在电脑上拖入文件夹；文件夹打包为 ZIP，接收后解压还原。
2. **分享出去。** 把链接发给对方，或让对方扫描页面上的二维码。
3. **保存到设备。** 对方确认接收，完成后按页面提示保存。

## 轻巧背后的技术

- **直连优先，跨网有备用路线。** Cloudflare 服务协助配对，连接信息在浏览器里用 AES-256-GCM 加密；文件优先通过 DTLS 保护的 WebRTC DataChannel 传输。直连不通或持续过慢时，可使用 [WebSocket 加密转发](docs/stream-relay.md)：浏览器先加密，服务器只即时转发密文，接收端解密并校验。文件不在服务器留存，密钥不交给转发服务。
- **边接收，边写入。** 支持写盘的浏览器分块保存文件，并做增量 SHA-256 校验，减少大文件对内存的压力。接收端优先用 WebAssembly 加速校验，不支持时自动回退到 JavaScript。
- **跟着网络调节。** 根据接收反馈调整发送窗口；自动配对断线后从已确认进度恢复。慢网压缩会计入压缩与解压耗时，预计划算时才建议启用，接收后还原原文件。

## 开始之前

- **保持页面打开。** 自动配对支持断线恢复；刷新或关闭页面后，未完成的传输不能续传。手机锁屏也可能中断。
- **收到后记得保存。** 浏览器暂存设有 10 分钟期限，也可能被系统提前回收；已下载的副本不受暂存清理影响。
- **容量看接收设备。** 大文件受设备空间和浏览器额度限制；不支持写盘时，总接收上限为 256 MiB。
- **路线可选，速度看实际网络。** 已建立的直连持续过慢时，先探测备用路线，预计有明显收益才自动切换；也可手动选择直连或加密转发。跨网络支持不保证任意网络都能连通或达到固定速度。分享链接即访问凭据，请只发给信任的人。

## 再了解一点

[开发与部署](docs/development.md) &nbsp; · &nbsp; [安全设计](docs/security-hardening.md) &nbsp; · &nbsp; [工程文档](docs/README.md) &nbsp; · &nbsp; [MIT License](LICENSE)

---

<p align="center"><sub>受 <a href="https://github.com/kern/filepizza">FilePizza</a> 启发，独立实现。<br>一点披萨精神，一份直接的分享。</sub></p>

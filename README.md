<p align="right">
  简体中文 &nbsp; <a href="README.en.md"><img src="docs/assets/language-english.svg" alt="English" width="86" height="26" /></a>
</p>

<div align="center">
  <img src="docs/assets/readme-cover.svg" alt="PizzaSend — 好东西，直接分享。" width="960" />
  <h3>文件送到，热乎刚好。</h3>
  <p>不用安装，不用注册。打开网页，把文件直接送到另一台设备。</p>
  <p><a href="https://pizzasend.dpdns.org/"><img src="docs/assets/open-pizzasend-zh.svg" alt="打开 PizzaSend" width="174" height="40" /></a></p>
  <p><sub>WebRTC · DTLS · SHA-256 · 开源</sub></p>
</div>

## 好东西，直接分享

<table width="100%">
  <thead><tr><th align="left">特性</th><th align="left">体验</th></tr></thead>
  <tbody>
    <tr><td><strong>加密直传</strong></td><td>浏览器之间直接传输，文件内容不经配对服务器。</td></tr>
    <tr><td><strong>原样送达</strong></td><td>保留文件名与内容，逐个做 SHA-256 校验。</td></tr>
    <tr><td><strong>一起分享</strong></td><td>同一链接，最多 10 人同时接收，各自拥有独立进度。</td></tr>
  </tbody>
</table>

分享文件或文件夹，也能扫码接收。网络切换可恢复，慢网时会按需建议压缩。

## 三步送达

1. **选好文件。** 添加文件或文件夹，一次最多 100 个文件。
2. **分享出去。** 把链接发给对方，或让对方扫描页面上的二维码。
3. **保存到设备。** 对方确认接收，完成后按页面提示保存。

## 开始之前

- **保持页面打开。** 自动配对支持断线恢复；刷新或关闭页面后，未完成的传输不能续传。手机锁屏也可能中断。
- **收到后记得保存。** 浏览器暂存设有 10 分钟期限，也可能被系统提前回收；已下载的副本不受暂存清理影响。
- **容量看接收设备。** 大文件受设备空间和浏览器额度限制；不支持写盘时，总接收上限为 256 MiB。
- **直连有边界。** 某些网络可能无法连接，目前没有文件中继。分享链接即访问凭据，请只发给信任的人。

## 再了解一点

[开发与部署](docs/development.md) &nbsp; · &nbsp; [安全设计](docs/security-hardening.md) &nbsp; · &nbsp; [工程文档](docs/README.md) &nbsp; · &nbsp; [MIT License](LICENSE)

---

<p align="center"><sub>受 <a href="https://github.com/kern/filepizza">FilePizza</a> 启发，独立实现。<br>一点披萨精神，一份直接的分享。</sub></p>

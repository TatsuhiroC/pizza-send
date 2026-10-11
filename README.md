# 🍕 PizzaSend · 文件快传

**简体中文** · [![Read in English](docs/assets/language-english.svg)](README.en.md)

打开网页，把文件直接送到另一台设备。受 [FilePizza](https://github.com/kern/filepizza) 启发，独立实现。

**使用地址：[tatsuhiroc.github.io/pizza-send](https://tatsuhiroc.github.io/pizza-send/)**

选择文件 → 创建传输 → 分享链接或二维码 → 接收方确认保存。双方保持页面打开。

## 首版功能

- 多文件传输、分享链接、分享二维码；一次最多 100 个文件。
- WebRTC 有序可靠 DataChannel，DTLS 加密文件直传。
- 32 KiB 分块，发送缓冲和接收确认双重流控；进度根据接收端确认更新。
- 增量 SHA-256 校验，确认文件完整后才显示完成。
- 桌面 Chrome / Edge 选择文件或文件夹后流式写盘；不支持该接口的浏览器使用内存缓存，总计限制 256 MiB。
- 自动配对支持网络切换后自动重连、从接收方确认的位置续传；保留文件校验与保存位置。双方页面需保持打开。
- 可复制连接码手动配对，手动模式不依赖配对服务，暂不支持自动重连。
- 中英文即时切换，记住语言选择；桌面和手机布局，无第三方字体或统计脚本。

## 部署结构

前端是 Vite + TypeScript 静态网页，发布在 GitHub Pages。Cloudflare Worker + Durable Objects 仅转发配对消息，STUN 帮助发现连接地址。**文件内容不会经由配对服务传输或存储，没有 TURN 文件中继。**

自动配对使用浏览器生成的 AES-256-GCM 密钥加密 SDP 信息。密钥在分享 URL 的 `#` 片段中，不随 HTTP 请求发给静态网站或配对服务；接收页面解析后清理地址栏。配对服务可见房间、角色、连接时间、网络地址和加密消息大小。房间角色令牌以 SHA-256 摘要存储，房间 30 分钟过期；一个房间同时仅接纳一个接收端。主动结束传输会关闭房间。配对连接意外断开时保留房间，允许同一浏览器会话重新连接，直到房间过期。

分享链接持有者可以接收文件，应通过可信渠道分享。手动配对码包含网络连接信息，应同样保密。使用者仍需信任网页代码与发布者；这不是经过第三方安全审计的产品。

首版不能保证任意两种网络都能直连。对称 NAT、UDP 限制、公司网络、VPN 路由和地域访问限制均可能影响连接；可先试同一 Wi-Fi。连接失败会显示错误，没有中继兜底。自动配对模式下，网络切换或暂时断线会触发重新收集连接地址、建立新的加密直连，再按接收方已写入的字节位置续传；最多等待两分钟。它会跳过已完成文件，保留当前文件的写盘流或内存数据及 SHA-256 状态，最终仍校验整个文件。恢复依赖配对服务可访问、房间未过期，并且新网络能直连；恢复时间和路线速度没有保证。网页关闭、刷新或浏览器释放页面后不能续传，手机锁屏可能触发这种情况。手动配对暂不支持自动重连。

## 本地开发

需要 Node.js 22 或更高版本。

```sh
npm ci
npm run dev
# 另一个终端启动配对服务
npm run signal:dev
```

在网页「连接设置」填写 `http://127.0.0.1:8787`。留空即可使用手动配对模式。修改 `public/app.config.json` 可设置部署默认值。STUN 默认使用 `stun:stun.cloudflare.com:3478`，不会中转文件。

## 自行部署

1. Fork 仓库，并在 GitHub Settings → Pages 将 Source 设为 GitHub Actions。`main` 更新后先验证，再自动发布 `dist`。
2. 修改 `signal/wrangler.jsonc` 的 Worker 名字、`ALLOWED_ORIGINS`，填写自己的前端 origin。部署默认允许当前 GitHub Pages origin 和两个本地开发 origin。
3. `npx wrangler login`，然后 `npm run signal:deploy`。Durable Objects 使用 SQLite 存储，账号需支持此功能；用量和费用以 Cloudflare 账号额度为准。
4. 将返回的 Worker HTTPS 地址写入 `public/app.config.json` 的 `signalUrl`，提交并发布。Worker 更新需要另行部署，仓库中不保存访问令牌。

## 验证

```sh
npm run build
npx playwright install --with-deps chromium
npm test
npm run signal:check
```

浏览器测试覆盖真实 DataChannel 自动/手动配对、20 MiB 多文件下载与独立 SHA-256 校验、空文件、中文文件名、损坏拒收、取消、来源限制、加密消息篡改和响应式布局。大文件测试把 200 MiB、1 GiB 文件写入真实浏览器 OPFS 磁盘流，完成后重新读取并独立校验；它替代了原生保存窗口，不是系统保存窗口的自动化验证。

测试只在隔离浏览器中使用虚拟媒体设备，帮助暴露本机 ICE 接口；应用本身不调用摄像头或麦克风。自动化测试的同机耗时不能代表跨设备或互联网速度，也未证明相对 FilePizza 的速度提升。

恢复测试覆盖连续两次连接中断、配对连接同时中断、磁盘流保持、完成确认丢失、非法续传位置、恢复后的损坏拒收和恢复期间取消。它们强制中断隔离浏览器的真实连接；尚未验证真实 VPN 开关或跨网络行为。

详细结果见 [首版验证记录](docs/validation.md)。

## 后续方向

真实双设备和不同网络测速、真实 VPN 开关测试、连接失败诊断、刷新后的持久化续传、PWA 离线外壳，以及经过测量后再决定的性能优化。保持文件直接传输；不因连接失败静默上传文件。

MIT License.

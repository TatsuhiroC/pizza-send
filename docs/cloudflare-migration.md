# Cloudflare 迁移记录 · 2026-10-15

## 正式入口与职责

- 网页：<https://pizzasend.dpdns.org/>，Cloudflare Pages 项目 `pizza-send`。
- 配对：<https://signal.pizzasend.dpdns.org>，沿用 `pizza-send-signal` Worker 和原有 Durable Objects。
- 源码与自动检查：GitHub `TatsuhiroC/pizza-send`。
- 原 `https://tatsuhiroc.github.io/pizza-send/` 停用，不再由 GitHub Pages 发布网页。

这次迁移改变网页托管和正式来源，不改变文件协议、加密、磁盘暂存或直连方式。文件仍由两端浏览器直接传输，没有添加 TURN 或云端文件存储。

## 可复现的部署设置

Cloudflare Pages 使用已有 GitHub 集成，导入此仓库；生产分支 `main`，构建命令 `npm run build`，输出目录 `dist`，根目录为仓库根目录，构建环境变量 `NODE_VERSION=22.16.0`。正式域名的 CNAME 指向 `pizza-send.pages.dev`，由 Cloudflare 管理 DNS 与 HTTPS。

GitHub Actions 的 `checks.yml` 保留构建、配对服务试构建、WebKit 与完整回归，移除 Pages 产物和发布任务。Cloudflare 的 Git 构建独立于 Actions；它不会自动等待另一平台的检查结果。因此推送生产分支前先完成本地验证，后续发布同样应遵守这一顺序。配对 Worker 的更新仍需单独部署。

`signal/wrangler.jsonc` 只允许正式网页来源与两个本地开发来源。不允许旧 GitHub Pages 或任意 `pages.dev` 预览连接正式配对服务。Turnstile 保留原站点密钥和服务端密钥，将唯一允许的主机名改为 `pizzasend.dpdns.org`，保留托管模式与关闭预清除的设置。

## 旧站与本机数据

关闭 GitHub Pages 后，旧收藏和旧二维码不提供跳转；请打开新入口重新创建分享。旧格式的配对数据仍受协议支持，这不等于旧网址仍可访问。

浏览器按来源隔离 OPFS、语言选择和连接设置。新域名不能读取旧站的暂存文件；已经保存到设备的文件不受影响。迁移不能把旧站的活动传输或未保存文件自动接过去，也不能靠此次迁移获得刷新后的续传。

## 验证记录

迁移验证应同时记录：本地回归结果、新域名有效 HTTPS 与资源加载、生产配对服务的来源限制、真实 WebRTC 收发与下载后 SHA-256，以及旧 GitHub Pages API 和旧网址的停用结果。浏览器自动化不等于真实 iPhone 或大陆无 VPN 的网络实测；后两项需要各自设备与网络的证据。

本次配对 Worker 版本：`24352221-5f11-4810-9ef8-ff897f71b6b4`，标签 `domain-migration`，100% 流量。版本更新保留原有房间存储、限流、邀请期限和密钥，不删除现有数据。

首次完整本地回归有 132 项通过，发现扫码失败后恢复输入区会把状态提示移出视口。修复为连接结束后在原会话仍有效时重新显示最终状态，保留旧任务与打开中对话框的保护；修复前连续两次专项失败，修复后两轮界面专项共 4 项通过。最终提交继续由 GitHub Actions 执行 133 项完整检查和 13 项 WebKit 检查。

生产新域名已完成一次真实配对与 WebRTC 传输：20 MiB 合成文件、空文件、中文文件名，逐个下载后独立核对 SHA-256。该测试使用同机隔离 Chrome，并替代原生保存窗口，不能作为跨设备测速或真实 iPhone 系统面板证据。来源检查中新域名预检返回 204，旧 GitHub 来源返回 403。

WebKit 回归另发现 Safari 点击按钮默认不获取焦点，名称浮层关闭后没有可恢复的按钮焦点。打开浮层前显式聚焦原按钮，交给原生 dialog 在关闭时恢复；保留外侧关闭和文字选择行为。此问题同样由既有专项覆盖。

## 测试入口关闭 · 2026-10-19

按项目维护者要求，删除 Pages 中全部 11 个 Preview 部署及其分支别名，保留正式生产部署和历史回滚版本。已逐一请求原测试部署链接，均返回 404。Pages 分支控制的预览分支改为“无（禁用自动分支部署）”；生产分支 `main` 的自动发布继续启用。该设置保存在 Cloudflare 控制台，并非仓库内的构建配置。

配对 Worker 的 Preview URL 已在控制台关闭；`signal/wrangler.jsonc` 显式设置 `preview_urls: false`，防止后续部署重新打开版本预览。正式自定义域和原生产 `workers.dev` 入口保留。域名记录核对仅有正式网页、配对服务以及独立的 `location-share` 项目，没有额外测试子域名。

## 旧配对入口隐私清理 · 2026-10-21

后续审查确认旧默认域名增加了身份关联性。已移除源码中硬编码的旧地址，并将 Worker 配置改为 `workers_dev: false`，只保留自定义域名；该配置已单独部署并确认旧入口关闭，预览入口继续关闭。测试改用虚构地址和描述性名称，43 次已确认受影响的历史运行日志已删除，运行记录和检查结果保留。[修复、验证和历史日志的处理边界](legacy-endpoint-privacy.md)。

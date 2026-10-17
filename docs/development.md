# 开发与部署

[← 返回项目首页](../README.md) · [English](development.en.md)

前端使用 Vite + TypeScript，部署到 Cloudflare Pages；Worker + Durable Objects 仅处理配对消息，STUN 帮助发现连接地址。文件通过 WebRTC 在浏览器之间直传，目前不提供 TURN 中继。

## 本地开发

需要 Node.js 22.12 或更高版本。

```sh
npm ci
npm run dev
# 另一个终端启动配对服务
npm run signal:dev
```

在网页「连接设置」填写 `http://127.0.0.1:8787`。留空即可使用手动配对模式。修改 `public/app.config.json` 可设置部署默认值。STUN 默认使用 `stun:stun.cloudflare.com:3478`，不会中转文件。

## 自行部署

1. Fork 仓库，在 Cloudflare Pages 导入该 Git 仓库；生产分支为 `main`，构建命令 `npm run build`，输出目录 `dist`，Node.js 使用 22.12 或更新的 22.x。绑定自己的自定义域名并确认 HTTPS，同时将 `public/_headers` 中的正式主机名改为自己的域名。Cloudflare 随 `main` 更新构建、发布；GitHub Actions 独立运行完整检查，不再发布 GitHub Pages。推送生产分支前应先完成本地验证。
2. 修改 `signal/wrangler.jsonc` 的 Worker 名字、`ALLOWED_ORIGINS`，填写自己的前端 origin。部署默认仅允许正式自有域名 origin 和两个本地开发 origin；Cloudflare 的预览域名默认不能连接正式配对服务。`routes` 中的自定义域名也需改成自己已在 Cloudflare 激活的域名；若只使用 `workers.dev`，删除 `routes`。
3. `npx wrangler login`，创建自己的免费 Turnstile 组件并添加前端主机名。将公开站点密钥写入 `TURNSTILE_SITE_KEY`，通过 `npx wrangler secret put TURNSTILE_SECRET_KEY --config signal/wrangler.jsonc` 保存服务端密钥；不要把密钥提交到仓库。然后 `npm run signal:deploy`。Durable Objects 使用 SQLite 存储，账号需支持此功能；用量和费用以 Cloudflare 账号额度为准。
4. 将返回的 Worker HTTPS 地址写入 `public/app.config.json` 的 `signalUrl`，提交并发布。Worker 更新需要另行部署，仓库中不保存访问令牌。

## 运行检查

```sh
npm run build
npx playwright install --with-deps chromium webkit
npm run signal:check
npm run test:headers
npm run test:webkit
npm test
```

先完成本地检查，再推送用于正式发布的分支。前端和配对服务分别部署；仅更新前端不会自动更新 Worker。GitHub Actions 的检查与 Cloudflare Pages 的构建彼此独立。

## 连接排查

双方刷新并创建新链接，保持发送页面打开、手机解锁。可以先在同一 Wi-Fi 且双方关闭 VPN 时测试，再比较 VPN 下的结果。同一 Wi-Fi 不保证一定直连；VPN 仍需允许局域网和 WebRTC / UDP。

自动恢复要求页面和原会话仍在、配对服务可访问、房间未过期，且新网络能建立直连。恢复时间与速度没有保证；手动配对暂不支持自动重连。

## 延伸阅读

- [保存与大文件](safari-storage.md)：浏览器额度、临时磁盘、副本空间与验证边界。
- [安全设计](security-hardening.md)与[网页安全头](web-security-headers.md)：凭据、限流、Turnstile、CSP 与自有域名配置。
- [连接与后台返回](background-sharing.md)：常亮、系统暂停与恢复限制。
- [全部工程文档](README.md)。

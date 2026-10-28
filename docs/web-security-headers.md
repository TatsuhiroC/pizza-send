# 网页安全头

Cloudflare Pages 通过 `public/_headers` 给正式静态网页及资源附加安全响应头。它不改变配对 Worker 的来源限制、认证、限流或文件传输加密。

- CSP 默认拒绝未列出的资源，只允许本站和 Cloudflare Turnstile 加载脚本；不允许内联脚本、内联事件或动态执行字符串。
- `frame-ancestors 'none'` 和 `X-Frame-Options: DENY` 禁止其他页面嵌入本站，减少点击劫持风险。允许本站嵌入的唯一外部页面是 Turnstile。
- 禁止修改基准地址、提交表单和加载插件；保留磁盘 Worker、二维码图片、Blob 下载及文件准备需要的资源能力。
- `Referrer-Policy: no-referrer` 禁止向其他站点发送来源页面信息；`nosniff` 防止按其他类型解释响应。
- 样式保留内联能力，用于画布尺寸等界面行为；这不允许执行内联脚本。

2026-10-17 的本地性能候选额外允许 `wasm-unsafe-eval`，供随本站构建分发的 SHA-256 模块编译与执行；没有允许通用的 `unsafe-eval`，`eval`／`new Function` 字符串代码仍受阻止。模块随已锁定依赖打包，不从外部 CDN 下载。不支持此能力的浏览器回退到原有流式 JS 校验。WASM 仍属于需要信任的本站代码，新增依赖也属于供应链审查范围；这不是新的文件加密层。[MDN 的策略说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_webassembly_execution)区分了两种权限。构建策略测试同时检查 WASM 实际启用、字符串执行被拦截及完整下载。

为保留用户主动配置 HTTPS 配对服务的能力，`connect-src` 允许 HTTPS、WSS、本站、Blob 和本地开发地址，并非只允许一个固定配对域名。这个策略主要限制执行脚本及资源类别，不能阻止已获得本站脚本执行权的攻击者通过 HTTPS 外传。域名、托管与源码账号保护仍然重要。

## HSTS：先使用 24 小时、仅正式主域

在先完成安全头验证后，按用户后续批准为 `https://pizzasend.dpdns.org/*` 增加 `Strict-Transport-Security: max-age=86400`。浏览器通过有效 HTTPS 收到它后，每次访问会重新记住 24 小时，期间把该主机的 HTTP 地址直接升级到 HTTPS。

不设置 `includeSubDomains`，因此不会扩展到 `signal` 或 `location` 等其他子域；不设置或提交 preload，不影响本地 HTTP 开发和预览。它不改变文件加密、传输速度，也不对首次尚未学到规则的 HTTP 访问提供完整保护。

撤销时，应继续通过有效 HTTPS 返回 `max-age=0`，让再次访问的浏览器清除记忆；只删响应头不会立即清除已经记住的规则。既有 HTTP → HTTPS 跳转继续保留。没有改动 DNSSEC、域名委派、账号验证或任何付费设置。

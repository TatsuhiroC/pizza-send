# Security · 安全说明

PizzaSend 的源码、配对域名和协议是公开的。安全依赖随机凭据、端到端加密与服务端校验，不依赖隐藏接口。

## 需要保密的内容

- Cloudflare 管理令牌、Turnstile **secret key**、登录凭据和本机环境文件不能提交到仓库。
- 分享链接及二维码包含取件所需的秘密，只应发给预期接收者。不要把真实链接贴到公开 issue、截图或测试日志中。
- 域名、Turnstile **sitekey**、测试中的虚构凭据和加密算法本身可以公开。转发服务器不持有文件解密密钥。

提交前运行 `npm run check:public`。CI 也执行同一检查，只输出可疑文件的位置，不输出匹配内容。它只能发现常见格式，不能替代人工审查或覆盖全部 Git 历史。

## 公开服务的边界

任何人都可以创建自己的分享，包括使用自行编写的客户端。Origin/CORS 限制不能认证浏览器外的调用者。配对服务使用限流、按需人机验证、一次性票据、角色绑定、分享总量和转发字节额度来限制滥用。

这些措施不保证公共服务永远不会被恶意请求消耗额度，也不保证分布式攻击期间仍然可用。月度转发字节限制不是整个云账号的账单上限。泄露分享链接会授权他人接收该分享，但不等于获得 Cloudflare 管理权限。

浏览器端加密仍需信任本站提供的网页代码。服务器、域名或发布账号被攻破时，攻击者可能更换网页代码；端到端加密不能代替这些账号的安全保护。

## 报告问题

若仓库启用了 [GitHub 私密漏洞报告](https://github.com/TatsuhiroC/pizza-send/security/advisories/new)，请优先使用该渠道。若不可用，可先创建不包含漏洞细节的 issue，请维护者安排私密沟通。请勿公开有效令牌、分享链接、个人文件或尚未修复的利用步骤。

历史版本或日志中发现有效凭据时，应先撤销或轮换，再决定如何清理历史；删除当前文件不代表历史副本也已消失。

---

Keep management tokens, Turnstile secret keys, environment files and live share links private. Public domains, sitekeys and protocol code are not credentials. Run `npm run check:public` before publishing; the check is intentionally limited to common disclosure patterns.

The public service is rate-limited, not abuse-proof. CORS is not client authentication, and the relay byte budget is not an account-wide spending cap. Prefer GitHub private vulnerability reporting when available; never publish working credentials or private files in an issue.

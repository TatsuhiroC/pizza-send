# PizzaSend · 工程文档

[项目首页](../README.md) · [English introduction](../README.en.md)

首页只保留使用介绍。这里记录实现、验证范围与维护过程；历史实测不代表所有设备和网络的表现。

## 使用与部署 · Use & deploy

- [开发与自行部署](development.md) · [Development & deployment](development.en.md)
- [大文件、Safari 与本机暂存](safari-storage.md)
- [多人分享](multi-share.md) · [iPhone 保存与分享](mobile-batch-save.md)
- [常亮、后台返回与恢复](background-sharing.md)

## 实现与验证 · Design & validation

- [安全加固](security-hardening.md) · [网页安全头](web-security-headers.md)
- [传输优化与慢网压缩审查](transfer-upgrade-review.md)
- [压缩触发条件与估算公式](transfer-compression.md)
- [接收端校验优化](transfer-receive-hash.md)
- [直接选择文件、文件夹 ZIP 打包与清空选择](folder-archives.md)
- [文件选择与相机调整（历史记录）](selection-camera-review.md)

## 维护记录 · Maintenance

- [体积、复杂度与重复工作审查：2026-10-24](lightweight-review.md)
- [创建准备优化与全仓审查：2026-10-24](startup-preparation-review.md)
- [启动配置与源文件读取保护：2026-10-24](startup-source-hardening.md)
- [分享链接与二维码就绪延迟：2026-10-24](share-readiness.md)
- [旧配对入口隐私清理：2026-10-21](legacy-endpoint-privacy.md)
- [全代码审查：2026-10-20](review-2026-10-20.md)
- [全代码审查：2026-10-19](review-2026-10-19.md)

- [Cloudflare 迁移](cloudflare-migration.md)
- [生产问题与验证](production-bugs-2026-10-16.md)
- [代码审查：2026-10-14](review-2026-10-14.md) · [2026-10-13](review-2026-10-13.md) · [早期审查](review.md)
- [首版验证](validation.md)
- 性能实验：[初期测量](transfer-performance.md) · [自动窗口](transfer-adaptive-control.md) · [延迟调查](transfer-latency-investigation.md)

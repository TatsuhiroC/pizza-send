# Safari 大文件存储验证

这是此前使用的独立验证页，只生成无隐私内容的测试数据，不传输用户文件，也不访问信令服务器。v0.2 已将对应写盘方式接入正式接收流程，正式集成结果见 [验证记录](../../docs/safari-storage.md)。本页的历史测试与正式流程测试分开记录。

## 手动打开

本地开发服务运行时，在 **Mac Safari** 地址栏打开：

http://127.0.0.1:5173/experiments/safari-storage/

1. 选择文件大小，点击「开始本地验证」，保持页面打开。
2. 等待分块写入和读回 SHA-256 校验完成。
3. 点击「保存测试文件」，等待浏览器实际下载完成。
4. 对下载后的文件再次检查大小与 SHA-256；页面读回校验通过不能代替导出校验。
5. 点击「清理浏览器测试文件」。下载目录中的副本需另外删除。

Safari 的「允许远程自动化」只供自动化测试使用，手动打开此页面无需开启。此地址只对应当前 Mac；iPhone 必须使用其可以访问的 HTTPS 页面另测。

## 验证方式

- 重复生成一个确定的 1 MiB 数据块，每个字节为位置对 251 取余；每次仅向 Worker 转交 32 KiB，并等待写入返回。
- Worker 使用 OPFS 的同步文件访问接口，处理部分写入，每 1 MiB 刷盘。按偏移写入，整个文件不放入内存。
- 完成后重新打开文件，以 1 MiB 块读回并计算 SHA-256。
- 通过 `getFile()` 获取浏览器文件对象，直接提供下载链接；不把整个文件转换成 ArrayBuffer 或拼接内存 Blob。
- 独立 Node 流式读取实际导出的文件，与独立生成的预期 SHA-256 比较。

浏览器暂存和下载副本可能同时占用空间。存储额度只是估计值，实际写入失败仍需处理。`canShare` 只记录能力探测，没有验证系统分享面板。

## 结论范围

本地读写与导出成功只证明这台设备、这个浏览器版本可行。测试不经过 WebRTC，计时不能当作网络速度；也不证明 iPhone Safari、VPN 切换、刷新后续传或后台/锁屏可靠。

v0.2 已接入接收写盘与确认顺序、同一临时文件的断线续写、配额错误处理、取消清理、多文件行为及中英文界面。实际 iPhone 接收和保存仍需实机验证，系统分享面板也未验证。

## 可重复的独立 WebKit 验证

在仓库启动开发服务后运行 `node experiments/safari-storage/verify.mjs`。默认测试 512 MiB 和 2 GiB；环境变量 `PROBE_MIB=5120,10240,20480` 可指定大文件测试，`PROBE_REPORT` 指定 JSON 报告路径。运行器使用隔离的临时浏览器配置和下载目录，完成后清理自己的测试数据。

运行器的进程树 RSS 指标可能漏掉 macOS 的 WebKit 服务进程，不作为浏览器总内存或手机内存使用量证明。

## 实测结果（2026-10-12）

| 环境 | 完整写入、读回、实际导出并独立校验 |
| --- | --- |
| 本机 Mac Safari 27.0.1 | 2 GiB、20 GiB 通过 |
| 隔离 Playwright WebKit | 512 MiB、2 GiB、5 GiB、10 GiB、20 GiB 通过 |
| iPhone Safari | 尚未实测 |

20 GiB 的 SHA-256 为 `7ee599ae3d150df2291eea7869f6960b2f5b90b8b144932dda14eae4729e5b70`，实际大小为 21,474,836,480 字节。原始结果见 [Mac Safari](../../docs/archive/safari-storage/safari-mac.json)、[WebKit 小文件](../../docs/archive/safari-storage/webkit-small.json)、[WebKit 大文件](../../docs/archive/safari-storage/webkit-large.json)。GiB 使用二进制计量，20 GiB 约为十进制 21.47 GB。

Mac 20 GiB 写入耗时 835.72 秒，写入加读回耗时 1,321.641 秒；隔离 WebKit 相应为 196.68 秒和 332.863 秒。两轮曾并发运行，页面前后台状态及资源调度也影响耗时，这些数值不是受控性能基准。

本机对一个 Safari WebContent 进程的部分阶段采样，观测到最高 RSS 约 81 MiB。它不包含其他浏览器进程，也不覆盖写入开始前的全部阶段，不能据此承诺浏览器总内存上限或手机内存表现。

已清理生成的 Safari 暂存文件及 2 GiB / 20 GiB 下载副本；独立 WebKit 运行器也清理了自己的浏览器配置和下载。独立验证页不包含在网站构建中。

`node experiments/safari-storage/verify-production.mjs` 使用正式存储模块进行隔离 WebKit 容量验证，默认 10 GiB / 20 GiB；同样可设置 `PROBE_MIB`、`PROBE_URL` 和 `PROBE_REPORT`。需要本地开发服务，因为它导入源模块；不经过 WebRTC，不计为实机网络传输验证。

# 版本与兼容

NeverSSH 不安装远端服务。远端 Python 源码由本地包提供，首次连接写入内容寻址的构建缓存，后续连接复用。

## 版本维度

| 维度 | 当前值 | 兼容规则 |
| --- | --- | --- |
| MCP 服务版本 | `0.2.2` | 工具增删改、参数重命名按 semver 的 major 处理 |
| worker 协议 | `1` | 只在 wire 不兼容时递增；客户端校验，不匹配返回 `PROTOCOL_INCOMPATIBLE` |
| 构建 ID | 源码内容哈希 | 本地与远端必须完全一致；不匹配返回 `BUILD_MISMATCH` |
| 最低 Python | `3.8` | 在加载任何源码前检查；过旧返回 `RUNTIME_UNSUPPORTED` |
| 归档格式 | `1` | 新版本不删除未知或未来格式；旧任务仍可读取 |
| 配置版本 | `1` | 新增字段提供默认值；破坏性变化才升版本 |

## 远端构建缓存

```text
~/.neverssh/
├── builds/
│   ├── .lock
│   ├── <buildId>/
│   │   ├── manifest.json
│   │   ├── worker.py
│   │   ├── file_ops.py
│   │   ├── helper.py
│   │   ├── archive.py
│   │   └── .lock
│   └── .tmp-<random>/
├── sessions/
└── .archive.lock
```

- 目录 700，文件 600，拒绝符号链接；每个源文件在安装和执行前校验 SHA-256。
- 安装先写入 `.tmp-*`，校验后原子 rename；并发安装同一构建时以先完成者为准。
- worker 对 `builds/<buildId>/.lock` 持有共享锁直到进程退出；清理器只有拿到独占锁才会删除。
- 默认保留当前构建和最近 2 个未锁定构建；超过 30 天的未锁定构建也会清理。
- 缓存不可写或校验失败时返回 `BUILD_UNAVAILABLE`；正在使用的损坏构建不会被原地替换。

## A/B 与回滚

- 不同本地版本生成不同 `buildId`，可以在同一远端用户下并存。
- 新连接使用当前本地版本对应的构建；旧 worker 继续使用旧构建，互不影响。
- 回滚就是运行旧版本本地包：旧构建仍在缓存时直接复用，否则重新安装。
- 归档目录在构建之间共享；格式版本和锁保证新旧 worker 可以并存。

## 环境要求

| 能力 | 要求 | 缺失时 |
| --- | --- | --- |
| Python | 3.8+，标准库即可 | `RUNTIME_UNSUPPORTED` |
| Bash | 命令工具需要 Bash | `BASH_UNAVAILABLE` |
| 远端 HOME | 可写，用于 `~/.neverssh` | `BUILD_UNAVAILABLE` / `ARCHIVE_UNAVAILABLE` |
| 文件系统 | 本地 Linux 文件系统；NFS/SMB 的 `flock` 需验证 | `doctor` 报告 HOME 文件系统类型 |
| SFTP | 上传/下载需要远端启用 SFTP 子系统 | `SFTP_UNAVAILABLE` |
| 本地 OpenSSH | 需要 `ssh` 和 `sftp` 客户端 | `SSH_UNAVAILABLE` / `SFTP_UNAVAILABLE` |
| 压缩 | OpenSSH `Compression=yes`，服务端可拒绝 | 自动降级，不影响正确性 |

## 发布策略

- 本地包是唯一发布物；远端不单独发布，也不需要升级服务。
- 构建 ID 由内容计算，发布物和远端缓存使用同一套源码。
- 破坏性接口变化升 major，行为修复升 patch，新增工具或字段升 minor。
- 发布前至少覆盖 Linux 容器矩阵：Python 3.8–3.12、OpenSSH 8/9、SFTP/无 SFTP、Bash/无 Bash、NFS HOME、压缩开/关，以及旧归档格式的清理测试。

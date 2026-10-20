# Bash 执行设计

本设计已实现，工具参数和返回示例以[工具接口](interfaces.md)为准。

一次 Bash 调用对应一个独立进程组、一个带 `task_` 前缀的任务 ID，以及一个远端日志文件。默认前台等待 120 秒；等待到期或显式后台运行后，由同一任务继续执行。工具只保留 `wait_seconds`，不增加单次命令运行时限参数。

执行由连接级 Python worker 启动的独立 helper 管理。文件读写编辑由同一个 worker 直接执行，不启动独立 helper。MCP 与 SSH 连接结束时清理所管理的进程，日志继续保留。远端没有独立监听端口或脱离连接的守护服务。

任务结果通过 MCP 文本内容块给模型。短命令成功完成时只给输出；后台、等待到期、截断或失败时再给状态、日志位置、字节数和有界输出预览。内部事件与磁盘元数据仍使用 JSON，工具不附加 `structuredContent`。

日志先记录原始命令，再追加程序输出；文件大小和预算包含命令头。完整展示输出时不附加读取提醒。日志存放于远端 `~/.neverssh/sessions/<connection_id>/<task_id>.log`。这里把 session 定义为 SSH 连接，不增加另一组会话 ID。活动锁保护正在写入的日志；已结束任务按完成时间保留 14 天，异常遗留日志按最后写入时间计算。清理在连接在线期间执行，离线时的过期文件在下次连接补清理。

本版采用以下默认值，均在[接口文档](interfaces.md#日志归档与清理)说明：

| 项目 | 默认值 |
| --- | --- |
| 前台等待 / 查询等待 | 120 秒 / 30 秒，上限 300 秒 |
| 内联预览 | 最近 64 KiB，最多 4096 个片段 |
| 每任务日志上限 | 64 MiB，可通过 maxTaskOutputBytes 调整 |
| 同一远端用户的日志总量上限 | 1 GiB，可通过 maxArchiveBytes 调整 |

预算不足时停止任务或拒绝启动，并报告保留内容不完整。保留期内的历史日志不因容量压力提前删除。命令自行写入的其他文件不受此日志预算约束。

## 与 Claude Code 的关系

参考的是 Anthropic 公开的工具参数与行为文档，以及官方 [Claude Agent SDK 0.3.303](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.303) 的 sdk-tools.d.ts，没有把公开类型定义当作完整内部源码。

借鉴的行为包括：以一次 Bash 命令为入口、显式后台运行、前台等待后交还控制权、用任务 ID 和日志继续跟进结果。[工具行为](https://code.claude.com/docs/en/tools-reference#bash-tool-behavior)、[后台任务](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)、[参数参考](https://code.claude.com/docs/en/hooks#bash)。

NeverSSH 显式传入 cwd，不把 cd 写回共享 SSH 连接；这适合一个连接并发服务多个工作目录。普通 MCP 客户端不一定能在任务完成时唤醒 Agent，因此仍提供 ssh_task_output 查询和等待。stdin 输入、交互终端和新的任务列表接口留待单独设计。

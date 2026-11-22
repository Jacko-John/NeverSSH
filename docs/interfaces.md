# NeverSSH 工具接口

连接时传入服务器地址、账号和端口。取得短 `connection_id` 后，可以直接操作远端，也可以用 `ssh_workspace_open` 打开项目。命令和文件工具必须且只能填写 `connection_id` 或 `workspace_id` 中的一个；任务工具使用 `ssh_bash` 在后台、等待到期、截断或失败时返回的 `task_id`。

| 工具 | 用途 |
| --- | --- |
| [ssh_discover](#ssh_discover) | 查找本机 SSH 配置中的候选服务器 |
| [ssh_connect](#ssh_connect) | 连接服务器 |
| [ssh_sessions](#ssh_sessions) | 列出可用连接 |
| [ssh_close](#ssh_close) | 强制关闭连接及其活动任务 |
| [ssh_workspace_open](#ssh_workspace_open) | 打开远程项目并取得开发上下文 |
| [ssh_skill_read](#ssh_skill_read) | 按需读取远端 skill 及其文本资源 |
| [ssh_bash](#ssh_bash) | 运行 Bash，直接取得结果或转入后台 |
| [ssh_task_output](#ssh_task_output) | 查询任务，或等待结束 |
| [ssh_task_stop](#ssh_task_stop) | 停止任务及其普通子进程 |
| [ssh_task_list](#ssh_task_list) | 列出尚未读取输出的任务 |
| [ssh_read_file](#ssh_read_file) | 读取远端文本、图片或 Jupyter 笔记本 |
| [ssh_write_file](#ssh_write_file) | 创建或覆盖远端文本文件 |
| [ssh_edit_file](#ssh_edit_file) | 精确替换远端文本 |
| [ssh_upload](#ssh_upload) | 上传本地二进制文件 |
| [ssh_download](#ssh_download) | 下载远端二进制文件 |

可以直接连接已知地址，无需先发现。默认沿用本机 SSH 能力，开放范围由本地[访问配置](../README.md#开始使用)控制。

所有请求都是 MCP 参数对象，并拒绝未定义字段。工具返回可读的 MCP 文本内容块，`ssh_read_file` 读取图片或笔记本中的栅格图时返回原生 `image` 内容块；其他工具仍只返回文本。所有工具都不提供 `structuredContent` 或 `outputSchema`，也不把内部结果序列化成 JSON 文本。错误文本统一为 `Error: CODE` 加一句说明。远端命令自身打印的 JSON 保持原样。

连接 ID 是 8 位小写十六进制，如 `7a2c9d4f`。工作区 ID 带 `ws_` 前缀，如 `ws_b8e3a160`，绑定连接和远端项目根目录。任务 ID 带 `task_` 前缀，如 `task_b8e3a160`。这些 ID 不能混用，只在当前 MCP 实例中有效；工作区还要求所属连接可用。日志保留不延长任何句柄的有效期。

本文覆盖连接、工作区、Bash/任务、文件与传输工具。远端构建、版本校验和 A/B 说明见[版本与兼容](compatibility.md)。

参数表由全部工具的输入 schema 按默认配置生成。文件写入和编辑的文本长度上限随 `maxFileBytes` 配置变化；字符数校验与远端文件的 UTF-8 字节数上限分别生效。

支持两种 scope 的工具中，`connection_id` 和 `workspace_id` 各自标记为非必填，但组合必须恰好填写一个；同时提供或全部省略都在执行前拒绝。

## ssh_discover

一次返回本机 SSH 配置中所有可枚举、且访问规则允许的入口。这个调用不尝试登录，也不保证候选当前可连。

### 参数

无参数，传入 `{}`。

### 返回

每行一个 SSH 入口，可直接传给 `ssh_connect`。没有候选时返回 `No SSH candidates found.`。

### 示例

#### 请求

```json
{}
```

#### 返回

```text
dev-server
build-server
```

### 行为和失败情况

读取范围包括用户 SSH 配置、系统配置和可解析的 `Include` 文件。指定 `sshConfig` 时使用该配置树。`Host *` 等通配规则不展开为服务器，按目标才能确定的 `Include` 也可能无法枚举；这些地址仍可直接传给 `ssh_connect`。

访问规则会过滤候选。需要解析目标配置时调用本机 `ssh -G`，因此可信 SSH 配置中的 `Match exec` 可能执行；发现过程不进行 SSH 认证。

| 错误码 | 原因 | 处理方式 |
| --- | --- | --- |
| `DISCOVERY_FAILED` | 配置无法读取，或超过发现数量、大小、层级限制 | 检查本地 SSH 配置 |
| `SSH_*` | 访问过滤所需的配置解析失败 | 根据错误消息检查本机 SSH 配置 |

## ssh_connect

连接指定服务器。返回成功时，远端操作已经就绪。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `host` | string | 是 | 无 | SSH 别名、主机名或 IP，例如 dev-server。账号单独填写在 user。最长 255 个字符。 |
| `user` | string | 否 | 无 | 登录账号。省略时沿用本机 SSH 配置；传入时覆盖配置值。最长 255 个字符。 |
| `port` | integer | 否 | 无 | SSH 端口。省略时沿用本机 SSH 配置；传入时覆盖配置值。取值 1～65535。 |
| `timeout_seconds` | number | 否 | `60` | 整个连接过程的超时，单位为秒，支持小数。包括配置解析、认证和远端准备。取值 1～180。 |

`host` 填 SSH 别名、主机名或 IP，账号单独填在 `user`。工具不接收整条 SSH 命令、额外 SSH 选项、密码或私钥内容；认证使用本机已有的 SSH 配置。

### 返回

返回 `Connection: <connection_id>`。拿到 ID 后即可调用远端命令和文件工具；任务工具只使用 `task_id`。

`connection_id` 是当前 MCP 实例内唯一的 8 位小写十六进制 ID。本实例不重复分配 ID；MCP 重启后需要重新连接。

### 示例

#### 请求：使用 SSH 别名

省略账号和端口时沿用本机配置。

```json
{
  "host": "dev-server"
}
```

#### 请求：指定账号和端口

```json
{
  "host": "dev-server",
  "user": "developer",
  "port": 2222,
  "timeout_seconds": 60
}
```

#### 返回

```text
Connection: 7a2c9d4f
```

#### 后续调用：读取文件

调用 `ssh_read_file` 时引用这个 ID：

```json
{
  "connection_id": "7a2c9d4f",
  "file_path": "/srv/app/src/main.ts"
}
```

### 行为和失败情况

连接默认不因空闲而过期，任务结束后仍可复用同一个 `connection_id`。连接保留到显式调用 `ssh_close`、SSH 连接失效或 MCP 退出。建连超时和命令超时只影响当次操作。

同一目标有可复用的就绪连接时，返回已有 ID。并发连接相同目标时会共享准备过程；每个调用仍有自己的超时，一个调用超时不会中止其他调用仍在等待的连接。

连接失败时不返回可用 ID。超时覆盖从解析 SSH 配置到远端操作就绪的整个等待过程。

| 错误码 | 原因 | 处理方式 |
| --- | --- | --- |
| `TARGET_DENIED` | 目标、账号或端口不在开放范围内 | 检查本地访问规则 |
| `SSH_UNAVAILABLE` | 本机 SSH 客户端不可用 | 检查 OpenSSH 安装及 PATH |
| `SSH_HOST_KEY_ERROR` | 主机密钥验证失败 | 在本机核实服务器身份和信任记录 |
| `SSH_AUTH_FAILED` | SSH 认证失败 | 检查本机账号、密钥或 SSH Agent |
| `SSH_TIMEOUT` / `SSH_FAILED` | SSH 解析或建连失败 | 查看错误消息，检查网络和 SSH 配置 |
| `CONNECT_TIMEOUT` | 整个连接过程超时 | 检查连接条件，或调整 timeout_seconds |
| `RUNTIME_UNSUPPORTED` | 已识别的远端 Python 缺失或版本不支持 | 提供 Python 3.8 或更新版本 |
| `PROTOCOL_INCOMPATIBLE` / `WORKER_START_FAILED` | 远端协议不兼容，或启动失败 | 查看错误消息，检查远端环境 |
| `BUILD_UNAVAILABLE` | 远端构建缓存不可写、安装或校验失败 | 检查远端 HOME 权限和 `~/.neverssh/builds` |
| `BUILD_MISMATCH` | 本地与远端 worker 构建不一致 | 重新连接；若持续出现，检查构建缓存 |
| `CONNECTION_BUSY` | 连接注册表已满 | 关闭不再使用的连接 |

## ssh_sessions

一次返回当前 MCP 实例中可用的全部连接。

### 参数

无参数，传入 `{}`。

### 返回

每行一条连接，格式为 `connection_id  user@host:port`。`host` 是建连时传入的入口，`user` 和 `port` 是实际登录账号和端口。没有可用连接时返回 `No active connections.`。

### 示例

#### 请求

```json
{}
```

#### 返回

```text
7a2c9d4f  developer@dev-server:2222
```

### 行为

只列出本地记录为就绪的连接，空闲时间不影响列表结果。失效、关闭中和已关闭的连接从列表中排除。

查询后发生断线时，后续操作通过 `CONNECTION_LOST` 报告。已收集的任务输出仍可通过原任务 ID 查询。

## ssh_close

强制关闭指定连接，同时取消该连接上的活动任务和操作。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 是 | 无 | 要关闭的连接 ID。 |

### 返回

返回 `Closed <connection_id> (remote cleanup <status>).`。`confirmed` 表示远端已确认清理完成；`unconfirmed` 表示远端清理结果未知。

### 示例

#### 请求

关闭指定连接，并取消尚未结束的任务：

```json
{
  "connection_id": "7a2c9d4f"
}
```

#### 返回

```text
Closed 7a2c9d4f (remote cleanup confirmed).
```

### 行为和失败情况

调用后停止接收新操作，取消活动命令、正在执行和排队的操作，清理连接管理的资源后关闭。连接随即从 `ssh_sessions` 中移除。

已完成的写入不会回滚。已收集的任务输出仍可通过原任务 ID 查询。

成功文本表示本地连接已释放。`remote cleanup confirmed` 表示远端已确认本连接管理的资源清理完成；断网、清理超时或远端 helper 异常退出时，结果为 `unconfirmed`。启动命令前已明确拒绝的请求不会被当成清理失败。

已关闭且仍有记录的 ID 可以重复关闭。并发关闭同一条连接时，共用一次关闭过程并返回相同结果。

| 错误码 | 原因 | 处理方式 |
| --- | --- | --- |
| `CONNECTION_NOT_FOUND` | ID 不存在，或记录已移除 | 用 ssh_sessions 查看现有连接 |

## ssh_workspace_open

在现有连接上打开远程项目，返回工作区 ID 和根目录的开发上下文。后续文件路径相对项目根目录解析，命令默认在根目录执行。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 是 | 无 | 打开项目所用的远端连接 ID。 |
| `path` | string | 是 | 无 | 已存在的远端项目目录；支持绝对路径、~/ 和相对于远端 HOME 的路径。最长 4096 个字符。 |
| `reread_rules` | boolean | 否 | `false` | 设为 true 重新展示根目录的 AGENTS.md，并清除之前的规则确认。下次访问子目录时再展示该目录的规则。 |
| `skill_directories` | string[] | 否 | `[".agents/skills",".claude/skills"]` | 替换默认远端 skill 搜索目录，统一从工作区根目录解析一次；默认 .agents/skills 和 .claude/skills，不支持随目标路径发现子目录 skill。绝对路径和 ~/ 指向远端共享目录；空数组关闭发现。最多 16 项。 |

### 返回

返回工作区标识、远端根目录、Git 状态、项目入口文件和 skill 目录。根目录有待确认规则时，还会返回 `AGENTS.md` 正文、来源、适用目录和确认值。skill 目录列出可调用名称和描述，正文按需读取。Git 状态按原顺序最多显示前 50 项，受 64 KiB 预览预算限制，仅返回完整条目。超出时会显示省略项数。需要完整结果时，在该工作区用 `ssh_bash` 运行 `git status --short -- .`。

### 示例

#### 请求

```json
{
  "connection_id": "7a2c9d4f",
  "path": "/srv/app"
}
```

#### 返回

```text
Workspace: ws_b8e3a160
Connection: 7a2c9d4f
Remote root: /srv/app
Context paths: /srv/app
Project guidance applies to its stated paths, subject to the user's instructions. All paths and skill execution below are remote.
No AGENTS.md instructions apply to these paths.
```

### 行为和失败情况

`path` 必须是已存在的远端目录，规范化后的目录就是工作区根目录。打开时只返回根目录的 `AGENTS.md`，不会遍历所有子目录，也不会自动套用更大 Git 仓库或其他客户端的规则机制。后续工作区操作按目标路径从根向下收集适用规则。

工作区操作固定使用准备阶段已校验的真实目标，同时保留原路径及链接目标适用的规则。准备后再修改入口符号链接，不会改变本次已选定的目标。

默认只在工作区根目录的 `.agents/skills` 和 `.claude/skills` 下发现包含 `SKILL.md` 的直接子目录，不支持随目标路径发现项目子目录的 skill。`skill_directories` 替换默认列表：所有相对目录只从工作区根目录解析一次，绝对路径或 `~/` 可用于远端共享或个人 skill。空数组关闭发现。不会自动安装依赖或运行 skill 脚本。

规则、目录扫描和 Git 输出都有资源上限；规则不能完整读取时调用失败，目录或 Git 信息不完整时返回可读警告。整个上下文超过响应预算时也会失败；按错误说明重新打开项目并缩减 `skill_directories`，或调整配置中的 `maxFileBytes`。不会静默截断 `AGENTS.md`。Git 缺失或检查失败不阻止文件开发。自动 Git 检查禁用 fsmonitor，并在检测到 clean/process 过滤器时跳过这些过滤器并提示差异；需要正常项目 Git 行为时，先读取规则，再通过 `ssh_bash` 显式检查。

工作区的读取、写入、编辑、上传和下载都先检查适用规则。打开工作区、Bash 结果和暂停的文件操作都会在展示规则时给出 `workspace_rules_ack`。一份规则返回一个字符串，多份规则返回一个数组，每项对应一份规则的当前版本。读完规则后，在文件调用中原样回传即可。也可以把不同响应里的码合并到同一个数组中。

例如，读取 `docs/guide.md` 时收到了根目录和 `docs/` 两份规则。读完后，将同一数组用于读取根目录的 `README.md`，这次只会确认根规则。之后用该数组再读 `docs/guide.md`，也能确认文档规则。期间其他目录发出的确认码不影响这两份规则。

`ssh_bash` 会运行命令，并在首次返回结果时附上仍然有效的工作目录规则变化。命令输出、任务信息和退出状态保持原样。若期间已有其他调用发现新版规则，较晚完成的命令会省略旧版。收到规则提示后无需重放命令。

文件工具收到有效确认值后，会记住适用于本次目标的规则版本。其余待确认的新增、变更或删除仍会单独返回。错误码 `WORKSPACE_RULES_CHANGED` 同时用于首次确认和规则变更，错误正文会说明原因。提示丢失后，无确认的重试仍然暂停。暂停的读取不交付文件内容或修订，暂停的下载不创建或覆盖本地文件。

普通刷新保留工作区的规则确认，重新生成 Git 状态和 skill 目录。上下文丢失时，在 `ssh_workspace_open` 中使用 `reread_rules: true` 清除旧确认值并重新获取根规则。子目录规则在后续访问时加载。规则比较将 CRLF 换行为 LF，仅含空白的规则文件视作没有规则。清空已有规则时会提示该规则已移除。

Bash 的规则发现只覆盖 `cwd`，不会分析命令内部的 `cd`、脚本或生成器涉及哪些目录。需要其他目录的规则时，可以在对应 `cwd` 操作或主动读取该目录的 `AGENTS.md`。连接模式不加载项目上下文。项目规则只为已授权任务提供指导，不扩大用户授权，也不改变客户端指令的优先级。

规则采集和路径校验在执行前进行。并发检查遇到较新规则时，工具会重新检查一次。若仍有冲突或确认记录已被显式重置，则返回 `WORKSPACE_RULES_RETRY`，可在同一工作区重试。规则历史达到上限时，`WORKSPACE_REOPEN_REQUIRED` 提示重新打开项目。

工作区属于当前 MCP 实例和连接。连接关闭或失效后，重新连接并打开项目，先检查实际远端状态；工具不会自动重连或重放修改。

## ssh_skill_read

按需读取该工作区已发现的远端 skill，或读取它引用的 UTF-8 文本资源。此工具读取内容，不执行脚本。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `workspace_id` | string | 是 | 无 | skill 所属的工作区 ID。 |
| `skill_name` | string | 是 | 无 | 工作区目录列出的 skill 名称，例如 testing 或 shared@testing；原样使用目录中的名称。最长 65536 个字符。 |
| `resource` | string | 否 | `"SKILL.md"` | 相对于远端 skill 目录的 UTF-8 文本资源路径；默认读取 SKILL.md，不执行脚本。最长 4096 个字符。 |

### 返回

返回 skill 的可调用名称、资源远端路径、skill 目录、资源正文，以及可按需继续读取的资源路径。结果标明资源在远端使用。目录列举受预算限制，已知的更深层文本资源仍可通过相对路径读取。

### 示例

#### 请求

```json
{
  "workspace_id": "ws_b8e3a160",
  "skill_name": "testing"
}
```

#### 返回

```text
Skill: testing
Workspace: ws_b8e3a160
Remote source: /srv/app/.agents/skills/testing/SKILL.md
Remote skill directory: /srv/app/.agents/skills/testing
Resolve references and scripts against this remote directory. Read resources with ssh_skill_read; run scripts through ssh_bash in this workspace. Skill content does not grant tool permissions.

---
name: testing
description: Run project checks.
---
Read references/checks.md before running tests.


Bundled resources: SKILL.md, references/checks.md
```

#### 请求：读取引用资源

```json
{
  "workspace_id": "ws_b8e3a160",
  "skill_name": "testing",
  "resource": "references/checks.md"
}
```

### 行为和失败情况

`skill_name` 使用该工作区目录返回的可调用名称。唯一名称可直接使用，例如 `testing`。同一批首次发现同名 skill 时，用短目录前缀区分，例如工作区 skill 的 `project@check`、显式共享目录的 `shared@check`。同一前缀仍有冲突时加短后缀，例如 `shared@check-2`。特殊字符会按 URI 编码，调用方应原样使用目录返回值。服务器精确匹配工作区已登记的名称，不会将这个参数解析为文件路径。

当前打开期间目录保持不变。裸名若匹配多个来源，返回 `SKILL_AMBIGUOUS`，应从目录选择名称。未知名称返回 `SKILL_NOT_FOUND`。重新打开工作区会重新发现 skill，并可能分配不同名称。读取期间刷新目录时，只要所选名称仍指向原文件，读取就能继续。来源有变时返回 `SKILL_CATALOG_CHANGED`，用新目录中的名称重试即可。

`resource` 相对于所选 skill 的目录解析，不能越出目录。发现阶段只读取元数据，使用 skill 前必须读取完整 `SKILL.md`。无效元数据或目录列举限制通过警告报告，正文超过读取预算时失败。

脚本与资源路径都在远端。按说明使用 `ssh_bash` 在远端运行脚本，先检查对应目录规则及依赖；工具不会因读取 skill 自动执行或安装任何内容。工作区外配置的个人 skill 可以读取，但其目录不会自动扩大工作区文件路径范围。本地个人 skill、客户端专用工具和 hooks 仍由客户端管理。

## ssh_bash

执行一条远端 Bash 命令。默认最多等待 120 秒，成功结束后直接返回程序输出。等待到期时交还控制权，同一进程继续运行；也可通过 `run_in_background` 在启动确认后立即返回。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
| `command` | string | 是 | 无 | 交给远端 Bash 执行的命令。不允许 NUL；环境变量可直接写在命令中。最长 131072 个字符。 |
| `cwd` | string | 否 | 无 | 本次命令的远端工作目录。工作区模式默认项目根目录，相对路径基于根目录；连接模式默认远端 HOME。最长 4096 个字符。 |
| `run_in_background` | boolean | 否 | `false` | 启动确认后立即返回；为 true 时不使用 wait_seconds。 |
| `wait_seconds` | number | 否 | `120` | 前台最多等待多少秒，支持小数。到期只交还控制权，原任务继续运行。0 表示启动后立即返回。取值 0～600。 |

前台等待到期时，`ssh_bash` 立即返回任务 ID 和已收到的输出。命令继续运行。用 `ssh_task_output` 查看最新预览，用 `ssh_task_stop` 终止命令。建连工具的 `timeout_seconds` 只用于连接准备，Bash 命令本身没有运行时限。

每条命令使用独立的 Bash，参数为 `--noprofile --norc -c`，不分配 PTY，stdin 默认为 EOF。连接模式的 `cwd` 默认是远端 HOME，工作区模式默认是项目根目录；命令中的 `cd`、变量和 Shell 状态不延续到下一条命令。环境变量直接写入命令，例如 `CI=1 make test`。

### 返回

普通前台命令成功完成时，操作结果只有程序输出；stdout 与 stderr 分别展示，stderr 带一行标记。后台运行、前台等待到期、输出被截断、断线或失败时，操作结果前增加精简的 Task、Status、Exit code 和 Log 信息。日志路径、字节数和完整性只在需要继续跟进时出现。工作区规则有变化时，在独立的第二个文本块中返回增量，不改变原操作结果；程序非零退出仍可附规则，命令已经运行。

内联预览只展示程序输出，最多保留最近 64 KiB 或 4096 个片段。日志先记录原始命令，再合并两个输出流；不保证两个流之间精确的原始写入顺序。预览可能从行中间开始。

预览未显示全部保留输出时，Log 行带 `read selectively`；日志本身不完整时单独标注 `Log incomplete or unconfirmed.`。日志从完成起保留 14 天。

#### 请求：前台

```json
{
  "connection_id": "7a2c9d4f",
  "command": "printf 'ready\\n'",
  "cwd": "/srv/app"
}
```

#### 返回：已完成

```text
ready
```

#### 请求：后台

```json
{
  "connection_id": "7a2c9d4f",
  "command": "make test",
  "cwd": "/srv/app",
  "run_in_background": true
}
```

#### 返回：运行中

```text
Task: task_c2f091ab (running in background)
Log: /home/developer/.neverssh/sessions/7a2c9d4f/task_c2f091ab.log (28 bytes so far; still growing)
```

### 行为和失败情况

要使用完整的 600 秒前台等待，MCP 客户端的工具调用超时和空闲超时都应至少为 660 秒，给启动和返回结果预留时间。输出到来不会重置等待预算，也不会提前结束前台等待。取消尚未返回的 Bash 调用会请求停止任务，并在错误中给出任务 ID 和日志路径。

单独执行 `grep`、`rg`、`egrep`、`fgrep`、`find`、`diff`、`test`、`[`、`git diff` 或 `git grep` 时，若退出码为 1 且没有其他失败原因，`ssh_bash` 正常返回并显示实际退出码。这一判断只适用于可识别的独立命令。其他非零退出、取消和输出超限等情况设置 MCP `isError=true`。查询或停止任务仍报告记录的进程状态和原始退出码。

| 原因或错误码 | 含义 |
| --- | --- |
| `cancelled` | 已请求停止任务 |
| `connection_closed` | 关闭连接触发远端收尾 |
| `connection_lost` | SSH 通道失效；远端进程状态和最终日志大小未知 |
| `output_limit` | 达到每任务或远端归档总量上限，停止任务，保留日志前缀 |
| `output_error` | 日志写入或收尾失败；日志可能不完整 |
| `failed` | helper 或协议异常；检查诊断及远端实际状态 |
| `BASH_UNAVAILABLE` | 远端找不到 Bash，不切换为其他 Shell |
| `TASK_LIMIT_REACHED` | 同一连接已有 4 条活动命令，或本地任务表已满 |
| `OUTPUT_LIMIT_REACHED` | 归档已满，命令未启动；不会删除未过期日志腾空间 |

## ssh_task_output

查询任务，或等待它结束。只使用 `task_id`；任务 ID 在当前 MCP 实例内唯一。返回状态、已知退出码、输出大小和可重复读取的预览；输出被截断或日志不完整时附带日志路径。反复查询可能包含相同文本。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `task_id` | string | 是 | 无 | ssh_bash 返回的 task_ 加 8 位十六进制任务 ID。 |
| `wait_seconds` | number | 否 | `30` | 最多等待任务结束的秒数，支持小数。0 表示直接查询当前预览。获取远端预览最多另等 5 秒。取值 0～300。 |

### 返回

任务结束时直接返回保存的预览。任务仍在运行且输出较多时，查询会向远端取一次最新预览，最多另等 5 秒。`wait_seconds=0` 会跳过等待命令结束这一步。预览超时会返回 `TASK_PREVIEW_TIMEOUT`，可以用同一任务 ID 重试。查询超时或取消时，命令继续运行。查询成功后，返回时看到的输出会标记为已读，后续的新输出会让任务重新出现在 `ssh_task_list` 中。

#### 请求

```json
{
  "task_id": "task_c2f091ab",
  "wait_seconds": 120
}
```

#### 返回

```text
Task: task_c2f091ab (completed)
Exit code: 0
Log: /home/developer/.neverssh/sessions/7a2c9d4f/task_c2f091ab.log (2.00 MiB (2097180 bytes); read selectively)

stdout:
All tests passed.
```

任务标为已读后，仍可用原响应中的 `task_id` 回查状态、退出码和输出预览。未读任务的 ID 也可从 `ssh_task_list` 找回。需要预览以外的内容时，按响应中的 `Log:` 路径读取远端日志，例如用 `ssh_bash` 执行 `tail` 或 `sed`。远端日志位于 `~/.neverssh/sessions/<connection_id>/<task_id>.log`。

连接关闭后，原任务 ID 仍可查询本 MCP 已保留的任务结果，不能据此运行新命令。本地任务表最多 256 项。启动新任务或查询任务列表时移除结束已满 14 天的记录，容量紧张时按启动顺序移除已结束记录。活动任务不按年龄移除；本地记录清理不删除远端日志。

## ssh_task_stop

停止任务及其管理范围内的普通子进程。发送 SIGTERM，2 秒后仍未收尾则升级 SIGKILL。只有确认任务通道结束才报告已停止；否则显示停止已请求，结束尚未确认。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `task_id` | string | 是 | 无 | ssh_bash 返回的 task_ 加 8 位十六进制任务 ID。 |

### 返回

使用任务报告格式，并保留日志。重复停止已结束的任务返回原退出码和原因，不改写为取消。

#### 请求

```json
{
  "task_id": "task_c2f091ab"
}
```

#### 返回

```text
Task: task_c2f091ab (stopped)
Reason: cancelled
Exit code: -15
Log: /home/developer/.neverssh/sessions/7a2c9d4f/task_c2f091ab.log (512 bytes)

stdout:
ready
```

## ssh_task_list

列出有未读输出的任务。前台命令已结束且 `ssh_bash` 完整返回结果时，任务标为已读，包括没有匹配项的搜索和完整返回的报错。如果返回时命令仍在运行、输出被截断或日志不完整，任务会留在列表中供后续查看。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 只列出该连接的任务；省略时列出全部连接。 |

### 返回

每行一个任务，格式为 `task_id  状态  connection_id  远端日志路径`：

```text
task_b8e3a160  running  7a2c9d4f  /home/developer/.neverssh/sessions/7a2c9d4f/task_b8e3a160.log
task_c2f091ab  completed  7a2c9d4f  /home/developer/.neverssh/sessions/7a2c9d4f/task_c2f091ab.log
```

没有未读任务时返回 `No tasks.`。活动任务排在前面，已结束任务按结束时间从新到旧排列。调用 `ssh_task_output` 查询后，当前输出标为已读。任务随后产生新输出时，会再次出现。

### 示例

#### 请求

```json
{
  "connection_id": "7a2c9d4f"
}
```

#### 返回

```text
task_b8e3a160  running  7a2c9d4f  /home/developer/.neverssh/sessions/7a2c9d4f/task_b8e3a160.log
```

### 行为和失败情况

任务列表只包含当前 MCP 实例的记录。MCP 重启后列表为空，远端日志仍按保留期存在。重新连接后，若保留了原连接 ID，可用 `ssh_bash` 执行 `ls -1 ~/.neverssh/sessions/<原连接ID>/*.log` 找回日志文件名。`ssh_task_list` 不读取任务输出；详情和预览使用 `ssh_task_output`。

## 文件与传输

文件工具必须且只能选择 `connection_id` 或 `workspace_id`。`file_path` 是远端文件路径。连接模式从远端 HOME 解析相对路径，工作区模式从项目根目录解析。工作区文件或传输操作返回 `WORKSPACE_RULES_CHANGED` 时，读完规则并携带响应中的 `workspace_rules_ack` 重试原调用。需要恢复上下文时，使用 `ssh_workspace_open` 并设置 `reread_rules: true`。连接模式不加载项目规则。读取返回带行号的文本、受支持的图片，或 Jupyter 单元格及其保存的输出。文件版本按真实目标记录，符号链接与目标路径共享版本。目录列表、文件查找和内容搜索通过 `ssh_bash` 执行 `ls`、`find`、`rg`。

远端写入、上传和下载会自动创建缺失的父目录；配置了非空 `localTransferRoots` 时，本地父目录不能通过符号链接逃出该范围。`ssh_upload` / `ssh_download` 使用 SFTP，复用当前连接的 ControlMaster；其他工具走 worker，包括图片读取。SSH 压缩默认开启（`compression: true`），可通过本地配置关闭。文件版本由服务端内部记录。项目开发默认直接使用远端文件工具，批量修改和代码生成使用远端 `ssh_bash`；上传下载用于具体的文件传输需求。

## ssh_read_file

读取远端文本、图片和 Jupyter 笔记本。文本带行号，图片使用原生 MCP `image` 内容块。读取会记录文件版本，供后续文件版本检查使用。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
| `workspace_rules_ack` | string / string[] | 否 | 无 | 仅用于工作区。读完规则后原样回传确认码。每份规则的当前版本对应一个 64 字符的小写十六进制码。可传单个字符串，或包含 1～2048 个码的数组。 |
| `file_path` | string | 是 | 无 | 远端文件路径；工作区模式相对项目根目录解析，连接模式相对远端 HOME 解析。最长 4096 个字符。 |
| `offset` | integer | 否 | 无 | 文本起始行号，省略时从第 1 行开始。不小于 1。 |
| `limit` | integer | 否 | 无 | 最多读取的文本行数，省略时为 2000 行。不小于 1。 |

### 返回

文本正文使用 `cat -n` 风格显示行号。如果内容自上次读取后发生变化，工具会另附提示。

```text
     1	import { createServer } from "node:http";
     2	
```

成功读取的页后面还有行时，工具会给出下一页起点。

```text
PARTIAL view: showing lines 1-2000 of 5000. Use offset=2001 to continue.
```

空文件返回 `File exists but is empty.`；`offset` 超过最后一行时返回 `File has <N> lines; offset <M> is past the end.`

图片完整返回为原生 MCP `image` 内容块，不把图片数据写入文本，也不在本地保存文件。客户端需要支持 MCP 图片显示。

### 示例

#### 请求

```json
{
  "connection_id": "7a2c9d4f",
  "file_path": "/srv/app/src/main.ts",
  "limit": 2
}
```

#### 返回

```text
     1	import { createServer } from "node:http";
     2	
```

### 行为和失败情况

按文件内容的标识识别 PNG、JPEG、GIF 和 WebP，不依赖扩展名。查看远端图片直接传入其 `file_path`，无需通过 SFTP 下载到本地。图片完整返回，`offset` 和 `limit` 只适用于文本。SVG 按文本读取。对于 XLSX、Parquet、HEIC、ZIP 等已知二进制扩展名，工具会提示通过对应格式的 skill 或远端命令查看。

所有输入文件均受 `maxFileBytes` 限制（默认 4 MiB，可配置到 8 MiB）。普通文本默认从第 1 行起最多显示 2000 行。整文件超过 256 KiB 时，默认调用会提示用 `offset` 和 `limit` 分页。从任意行读到末尾，只要剩余正文超过 256 KiB，也会返回整文件分页提示。选取中间一段时，所选行必须全部容纳在 256 KiB 内，否则调用失败，提示缩小范围或通过 `ssh_bash` 用 `rg` 搜索。恰好 256 KiB 可以读取。成功返回的 `PARTIAL view` 表示所选行已完整交付，后面还有行可读。

`.ipynb` 按顺序返回各单元格的类型、源代码或 Markdown，以及保存的文本输出、报错和图形。文字总量超过 256 KiB 时，可在远端通过 `ssh_bash` 运行 `jq` 选取需要的单元格。

直接读取 PDF 会返回格式不支持的错误。需要提取文字时，可通过 `ssh_bash` 调用远端已有的 PDF 工具。例如，`pdftotext -f 1 -l 3 report.pdf -` 会将前三页的文字写到标准输出。

含图片的完整 MCP 响应序列化后另有 9 MiB 上限，独立于原始文件的 `maxFileBytes` 限制。工作区规则在先前的暂停响应中单独交付。图片响应超限时，工具返回文本错误，提示缩小图片后重试，不会截断图片或自动下载。

同一版本的全部内容读完后，可以精确编辑或覆盖该文件。看到 `PARTIAL view` 时，可按提示继续翻页，也可乱序读取。文本按行记录读取进度。每个文件记录最多 32 段互不相连的范围。跳读超过这个数量时，从较小的行号顺序往后读即可补齐。两次读取之间文件内容有变化时，工具会提示，分页进度从新版本重新计算。并发读取返回旧快照时，工具会提示重新确认内容，并保留较新版本的记录。读取不会延长日志保留期。

普通文本中无法解码的 UTF-8 字节显示为 �（U+FFFD）。带 UTF-16 BOM 的文本按标记的编码显示。精确编辑要求原文件为 UTF-8。

## ssh_write_file

创建或覆盖远端文件，写入完整内容。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
| `workspace_rules_ack` | string / string[] | 否 | 无 | 仅用于工作区。读完规则后原样回传确认码。每份规则的当前版本对应一个 64 字符的小写十六进制码。可传单个字符串，或包含 1～2048 个码的数组。 |
| `file_path` | string | 是 | 无 | 目标远端文件；工作区模式相对项目根目录解析，连接模式相对远端 HOME 解析。最长 4096 个字符。 |
| `content` | string | 是 | 无 | 完整文件内容；字符数上限随 maxFileBytes 配置，远端另按 UTF-8 字节数校验。最长 4194304 个字符。 |

### 返回

创建新文件时：

```text
File created successfully at: /srv/app/notes.txt
```

覆盖已有文件时：

```text
The file /srv/app/notes.txt has been updated successfully.
```

### 示例

#### 请求

```json
{
  "connection_id": "7a2c9d4f",
  "file_path": "/srv/app/notes.txt",
  "content": "hello\n"
}
```

#### 返回

```text
File created successfully at: /srv/app/notes.txt
```

### 行为和失败情况

在同目录创建临时文件后原子替换。缺失的远端父目录会自动创建；目标最终符号链接会被跟随，替换后保留 Unix mode 和所有者。

新文件直接创建。覆盖已有文件需要同一连接下有效的读取或写入记录。服务端核对文件内容的哈希，外部修改会触发冲突。成功后记录新版本，后续可直接编辑。

读取非 UTF-8 文本后，可提供完整的 UTF-8 内容覆盖文件。若新内容含 U+FFFD，写入会被拒绝，以免把读取时的替换字符写回磁盘。需要保留原编码时，可在远端通过 `ssh_bash` 使用相应的编码工具。

## ssh_edit_file

对远端文件做一次精确文本替换，全部成功或完全不改。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
| `workspace_rules_ack` | string / string[] | 否 | 无 | 仅用于工作区。读完规则后原样回传确认码。每份规则的当前版本对应一个 64 字符的小写十六进制码。可传单个字符串，或包含 1～2048 个码的数组。 |
| `file_path` | string | 是 | 无 | 要编辑的远端文件；工作区模式相对项目根目录解析，连接模式相对远端 HOME 解析。最长 4096 个字符。 |
| `old_string` | string | 是 | 无 | 要替换的原文；不能为空，且不能含 NUL。字符数上限随 maxFileBytes 配置。最长 4194304 个字符。 |
| `new_string` | string | 是 | 无 | 替换后的文本；字符数上限随 maxFileBytes 配置，结果另受远端文件字节上限约束。最长 4194304 个字符。 |
| `replace_all` | boolean | 否 | `false` | 为 true 时替换所有匹配；否则必须恰好匹配一次。 |

### 返回

```text
The file /srv/app/notes.txt has been updated successfully.
     1	world
```

### 示例

#### 请求

```json
{
  "connection_id": "7a2c9d4f",
  "file_path": "/srv/app/notes.txt",
  "old_string": "hello",
  "new_string": "world"
}
```

#### 返回

```text
The file /srv/app/notes.txt has been updated successfully.
     1	world
```

### 行为和失败情况

同一连接下，读完同一版本的文件、查看单文件的 Bash 命令或一次成功写入均可建立编辑所需的版本记录。缺少记录时返回 `FILE_NOT_READ`。文件随后被外部修改时，哈希检查会拒绝编辑，需要重新读取。

例如，`sed -n '1,20p' src/main.ts` 完整返回选中行的正文后，可接着编辑该文件。如果所选范围超出文件末尾，或 `head -n 0` 返回零字节标准输出，命令正常完成，文件仍需读取。实际返回的空行含一个换行符，可以计入读取。对于空文件，`ssh_read_file` 会确认文件为空，随后可用 `ssh_write_file` 写入。支持 `cat`、`nl`、`bat`、`batcat`、`head`、`tail`、`sed -n` 打印行范围，以及单文件 `grep`、`egrep`、`fgrep`、`rg`。单文件搜索成功时，只要交付的预览含文件正文，即使预览被截断，也可建立读取记录。无匹配的搜索仍是有效的 Bash 结果。无输出、仅计数、仅列文件名或仅报告二进制匹配的搜索不能用于后续编辑。命令须能确定唯一的文件路径。`cat ~/'my file'` 从远端用户主目录读取，引号包住整个 `'~/my file'` 时则按 Bash 的规则在当前目录查找名为 `~` 的子目录。带管道、重定向、动态文件名或多个文件的命令不能建立记录。

`replace_all=false` 时 `old_string` 必须恰好出现一次；`replace_all=true` 时至少出现一次。匹配数不符或文件无法作为 UTF-8 文本读取时不写入任何内容。相同的新旧字符串会直接返回 `NO_CHANGES`。替换成功后显示第一处修改和附近的行，多处替换还会给出总次数。较长的预览含省略标记。编辑沿用已有文件的换行、Unix mode 和所有者。

## ssh_upload

把本地二进制文件上传到远端路径。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
| `workspace_rules_ack` | string / string[] | 否 | 无 | 仅用于工作区。读完规则后原样回传确认码。每份规则的当前版本对应一个 64 字符的小写十六进制码。可传单个字符串，或包含 1～2048 个码的数组。 |
| `cwd` | string | 否 | 无 | 远端工作目录；默认使用工作区根目录或连接的远端 HOME。最长 4096 个字符。 |
| `localPath` | string | 是 | 无 | 本地文件的绝对路径；localTransferRoots 非空时，必须位于其中一个目录内。最长 4096 个字符。 |
| `remotePath` | string | 是 | 无 | 目标远端路径；支持绝对路径、~/ 和相对于 cwd 的路径。最长 4096 个字符。 |
| `overwrite` | boolean | 否 | `false` | 显式允许覆盖已存在的远端文件。 |
| `expectedSha256` | string | 否 | 无 | 期望的远端文件 SHA-256，小写十六进制；用于冲突检查。 |

### 返回

```text
Uploaded /Users/me/transfer/logo.png to /srv/app/assets/logo.png (2048 bytes).
SHA-256: ...
```

### 示例

#### 请求

```json
{
  "connection_id": "7a2c9d4f",
  "localPath": "/Users/me/transfer/logo.png",
  "remotePath": "assets/logo.png"
}
```

#### 返回

```text
Uploaded /Users/me/transfer/logo.png to /srv/app/assets/logo.png (2048 bytes).
SHA-256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

### 行为和失败情况

每次调用通过 `localPath` 指定运行 MCP 服务的本机上的绝对路径，无需预先配置传输目录。省略 `localTransferRoots` 或设置为 `[]` 时不限制本地目录；只有非空列表才要求本地真实路径位于其中一个配置目录内，符号链接不能逃离该范围。`workspace_id` 和 `cwd` 只影响远端路径，不用于解析 `localPath`。本地源必须是普通文件，且不超过 `maxFileBytes`（默认 4 MiB，可配置到 8 MiB）。

上传通过 SFTP 复用当前连接的 ControlMaster；SFTP 不可用时直接返回 `SFTP_UNAVAILABLE`，不回退 worker 传输。SFTP 准备完成后会再次解析本地源路径，按非空的 `localTransferRoots` 检查范围，再通过文件描述符检查普通文件类型并读取有大小上限的内容快照。远端目标固定使用检查时解析的真实路径；最终符号链接指向尚不存在的文件时，也按该真实目标创建并保留链接。

先通过 SFTP 写同目录的短名称临时文件，再由 worker 校验并提交；父目录自动创建。已有远端文件需要 `expectedSha256` 或 `overwrite=true`，覆盖也不能替换目录或 FIFO 等特殊文件。暂存文件必须是普通文件，不能是符号链接；提交时校验 sha256 并重新校验 `expectedSha256`。未允许覆盖时以原子的创建操作提交，拒绝覆盖上传期间出现的文件。同一 worker 对同一文件的文本写入、编辑和上传提交会串行执行，哈希校验不构成跨进程事务锁。SFTP 上传不保证保留远端原文件的 mode 和所有者；成功后记录新版本，可在同一连接下用 `ssh_edit_file` 继续编辑文本内容。

## ssh_download

把远端二进制文件下载到本地路径。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
| `workspace_rules_ack` | string / string[] | 否 | 无 | 仅用于工作区。读完规则后原样回传确认码。每份规则的当前版本对应一个 64 字符的小写十六进制码。可传单个字符串，或包含 1～2048 个码的数组。 |
| `cwd` | string | 否 | 无 | 远端工作目录；默认使用工作区根目录或连接的远端 HOME。最长 4096 个字符。 |
| `remotePath` | string | 是 | 无 | 要下载的远端路径；支持绝对路径、~/ 和相对于 cwd 的路径。最长 4096 个字符。 |
| `localPath` | string | 是 | 无 | 本地文件的绝对路径；localTransferRoots 非空时，必须位于其中一个目录内。最长 4096 个字符。 |
| `overwrite` | boolean | 否 | `false` | 显式允许覆盖已存在的本地文件。 |

### 返回

```text
Downloaded /srv/app/build/app.tar.gz to /Users/me/transfer/app.tar.gz (4096 bytes).
SHA-256: ...
```

### 示例

#### 请求

```json
{
  "connection_id": "7a2c9d4f",
  "remotePath": "build/app.tar.gz",
  "localPath": "/Users/me/transfer/app.tar.gz"
}
```

#### 返回

```text
Downloaded /srv/app/build/app.tar.gz to /Users/me/transfer/app.tar.gz (4096 bytes).
SHA-256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

### 行为和失败情况

每次调用通过 `localPath` 指定运行 MCP 服务的本机上的绝对路径，无需预先配置传输目录。省略 `localTransferRoots` 或设置为 `[]` 时不限制本地目录；只有非空列表才要求本地真实路径位于其中一个配置目录内。`workspace_id` 和 `cwd` 只影响远端路径，不用于解析 `localPath`。缺失的本地父目录会自动创建；配置目录限制时，创建前会解析最深的已存在祖先，符号链接不能逃出该范围。目标是符号链接、非常规文件或已存在且未设置 `overwrite=true` 时拒绝写入。

远端文件必须是普通文件且不超过 `maxFileBytes`；先用 worker `stat` 检查存在性和大小，并固定真实目标，再通过 SFTP 下载。本地接收内容始终位于同父目录下的 0700 私有临时目录中。传输后按文件描述符复查类型与大小，以有上限的读取计算实际收到内容的 sha256，并将文件权限设为 0600 后原子提交。源文件在检查后增长超限时拒绝提交；失败时保留原目标并清理临时目录。SFTP 不可用时直接返回 `SFTP_UNAVAILABLE`，不回退 worker 传输。

提交前会再次校验本地目标路径，按非空的 `localTransferRoots` 检查范围，并在最后一次路径检查后复核取消状态。已取消的调用在入口就退出，不创建下载目录。并发禁止覆盖的下载以原子创建保证只有一个成功；`overwrite=true` 才允许替换已有普通文件。

共享的 SFTP 可用性探测独立处理每个调用者的取消。传输取消或超时后，工具会停止并回收 SFTP 进程组再返回；连接关闭也等待其活动传输收尾。连接已经丢失或清理请求失败时，远端上传暂存文件的清理可能无法确认，应检查实际远端状态，避免直接重传。

## 文件和传输错误

这些工具和连接工具一样，返回文本错误并设置 `isError=true`。常见错误码：

| 错误码 | 原因 | 处理方式 |
| --- | --- | --- |
| `CONNECTION_NOT_FOUND` | 连接 ID 不存在 | 用 `ssh_sessions` 查看现有连接。 |
| `CONNECTION_LOST` | SSH 连接已失效 | 重新连接，并先检查远端实际状态。 |
| `REMOTE_OPERATION_FAILED` | 远端文件或写入失败；消息包含具体原因 | 根据消息检查路径、权限或远端环境。 |
| `FILE_NOT_READ` | 缺少可用于编辑的当前文件版本 | 用 `ssh_read_file` 读完所需页面，再次提交编辑。 |
| `NO_CHANGES` | 新旧字符串完全相同 | 提供要替换的内容，或跳过这次编辑。 |
| `WORKSPACE_NOT_FOUND` | 工作区 ID 无效或不再可用 | 确认连接可用后重新打开项目。 |
| `WORKSPACE_RULES_CHANGED` | 文件或传输操作需要首次确认规则，或已展示的规则发生变化 | 阅读返回的规则，携带 `workspace_rules_ack` 重试。 |
| `WORKSPACE_RULES_RETRY` | 并发检查发现较新规则或确认状态已重置 | 在同一工作区重试原调用。 |
| `WORKSPACE_REOPEN_REQUIRED` | 工作区规则历史达到上限 | 重新打开工作区恢复规则检查。 |
| `SKILL_CATALOG_CHANGED` | 读取期间 skill 目录刷新，原选择已失效 | 使用最新目录中的 skill 名称重试。 |
| `OPERATION_FAILED` | 本地文件、参数处理失败或图片响应超限 | 按消息检查目录限制、路径和权限；图片响应过大时缩小图片后重试。 |
| `OPERATION_CANCELLED` / `OPERATION_INTERRUPTED` | 调用被取消，或远端操作超时 | 写入结果可能未知，先检查目标再重试。 |
| `SFTP_UNAVAILABLE` | 本地 `sftp` 或远端 SFTP 子系统不可用 | 安装 OpenSSH `sftp` 客户端，或在远端启用 SFTP 子系统。 |
| `SFTP_FAILED` | SFTP 传输或批处理命令失败 | 检查远端路径、权限和 SFTP 配置。 |
| `SFTP_TIMEOUT` | SFTP 传输超过 120 秒 | 检查网络和目标文件大小。 |

参数校验失败由 MCP SDK 报告，具体错误文本由 SDK 决定；写入类操作在断线或取消后不要自动重放。

## 日志归档与清理

这里的 session 指 SSH 连接，目录名直接使用 `connection_id`，不另设日志会话 ID。所有输出文件位于远端用户目录：

```text
~/.neverssh/
├── .archive.lock
└── sessions/
    └── 7a2c9d4f/
        ├── .session.lock
        ├── session.json
        ├── task_c2f091ab.log
        ├── task_c2f091ab.meta.json
        └── task_c2f091ab.lock
```

日志在启动命令前写入原始命令，保留换行、缩进和尾部空白，再追加输出。例如：

```text
Command:
printf 'ready\n'

Output:
ready
```

元数据同时保留原始 command 和输出起点 output_offset（字节），用于准确区分命令与输出。会话和任务元数据带 `format: 1`；新版本只清理已知格式，未知格式保留。返回的大小及日志预算包含命令头；只有程序输出进入内联预览。

进程清理报错时，helper 仍会尝试完成归档，保留已收到的输出和已知退出状态，并将输出标为不完整；原始错误继续上报。归档已完成收尾不代表所有命令进程都已确认停止，远端清理状态仍可能为 `unconfirmed`。归档写入本身失败时也会明确报错。

目录权限为 700，文件权限为 600。元数据和锁是内部文件，不作为模型输出。目录和日志使用独占创建，遇到历史 ID 冲突时更换尚未公开的 ID，不覆盖旧日志。

| 情况 | 清理规则 |
| --- | --- |
| 正常完成、失败或停止 | 从结束时间起保留 14 天 |
| 仍有 helper 持有活动锁 | 跳过，即使命令已运行超过 14 天 |
| 异常中断，缺少有效结束时间 | 确认无活动锁后，以日志最后写入时间计算 14 天 |
| 查询或读取日志 | 不延长保留期 |
| 关闭连接或退出 MCP | 停止活动任务，保留日志 |
| 到期 | 删除日志、任务元数据和锁；清理没有 worker 且归档为空的会话目录 |

worker 在建连时、请求收尾后和在线期间每小时清理。离线期间没有独立清理服务，到期文件在下次连接时补清理。14 天是过期规则，不保证离线服务器上的准点删除。

本版默认每任务最多 64 MiB 日志，同一远端用户的归档最多 1 GiB，分别由本地配置 `maxTaskOutputBytes` 和 `maxArchiveBytes` 调整。并发 worker 通过远端共享锁计数，保留期内日志不会为新任务提前腾退。达到上限时保留已写入的前缀并停止任务，明确提示日志不完整；归档已满时拒绝新任务。

日志大小限制统计 `.log` 内容，不是文件系统磁盘配额，不包括元数据，也不约束命令自行写入的其他文件。不同 MCP 实例应对同一远端用户使用一致的归档上限。

重新连接后，可通过新连接读取仍保留的旧日志路径。`ssh_read_file` 受全文件大小上限约束，大日志应先通过 `ssh_bash` 执行 `tail`、限定范围的 `sed` 或针对性 `rg`。不要直接将整份日志加载进模型上下文。

## 错误返回

所有工具的操作错误都返回相同的可读文本，并设置 MCP `isError=true`：

```text
Error: TASK_NOT_FOUND
Task does not exist in this MCP instance
```

参数校验失败由 MCP SDK 报告，具体错误文本由 SDK 决定。连接失效后旧 ID 不会自动重连；重新连接不重放命令或写入。断线前操作可能已完成，应先检查远端实际状态。

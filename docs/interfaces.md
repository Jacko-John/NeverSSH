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
| [ssh_read_file](#ssh_read_file) | 读取远端 UTF-8 文本或图片 |
| [ssh_write_file](#ssh_write_file) | 创建或覆盖远端文本文件 |
| [ssh_edit_file](#ssh_edit_file) | 精确替换远端文本 |
| [ssh_upload](#ssh_upload) | 上传本地二进制文件 |
| [ssh_download](#ssh_download) | 下载远端二进制文件 |

可以直接连接已知地址，无需先发现。默认沿用本机 SSH 能力，开放范围由本地[访问配置](../README.md#开始使用)控制。

所有请求都是 MCP 参数对象，并拒绝未定义字段。工具返回可读的 MCP 文本内容块，`ssh_read_file` 读取受支持的图片时返回原生 `image` 内容块；其他工具仍只返回文本。所有工具都不提供 `structuredContent` 或 `outputSchema`，也不把内部结果序列化成 JSON 文本。错误文本统一为 `Error: CODE` 加一句说明。远端命令自身打印的 JSON 保持原样。

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
| `skill_directories` | string[] | 否 | `[".agents/skills",".claude/skills"]` | 替换默认远端 skill 搜索目录，统一从工作区根目录解析一次；默认 .agents/skills 和 .claude/skills，不支持随目标路径发现子目录 skill。绝对路径和 ~/ 指向远端共享目录；空数组关闭发现。最多 16 项。 |

### 返回

返回可读的工作区标识、远端根目录、Git 状态、项目入口文件、适用的 `AGENTS.md` 正文和 skill 目录。规则标明来源和适用目录；skill 目录列出可调用名称和描述，正文按需读取。Git 信息是当前状态快照，不会自动区分用户已有改动和本次任务的改动。

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

工作区文件读取、写入、编辑、上传、下载和 Bash 的结果自动附上新增、变更或删除的适用规则，不因规则尚未返回或已经变化而拒绝操作。规则提示返回时，本次文件操作已经执行，Bash 命令已经启动；提示用于后续操作，不代表服务器已确认 Agent 在执行前理解了规则。路径范围、读取后编辑和文件版本检查继续生效。

第一个 MCP 内容块保留原操作结果：普通结果为文本，保留任务首行和程序输出的空白；图片读取结果为原生 `image`。规则有变化时，第二个文本块单独返回规则增量，没有变化时不重复返回。已启动或转入后台的 Bash 在首次返回结果时交付规则，程序非零退出的结果也可附规则；命令已经运行，不要因为收到规则提示而重放。文件读取、编辑或传输等操作抛错时，不附规则，也不将本次采集的规则记为已返回。

如果操作执行期间工作区被重新打开或连接失效，保留原操作结果，但不再附带属于旧工作区状态的规则。

普通操作不重复未变化的规则、skill 目录和 Git 状态。再次调用 `ssh_workspace_open` 可恢复根目录上下文、刷新 Git 状态和重新发现 skill。相同连接、规范化根目录和 skill 配置可复用原句柄，但会重置规则交付记录并重建 skill 目录；后续目标操作会重新返回适用的子目录规则。对话压缩后再次打开并重读仍需使用的 skill，服务器无法判断模型是否还记得内容。

Bash 的规则发现只覆盖 `cwd`，不会分析命令内部的 `cd`、脚本或生成器涉及哪些目录。需要其他目录的规则时，可以在对应 `cwd` 操作或主动读取该目录的 `AGENTS.md`。连接模式不加载项目上下文。项目规则只为已授权任务提供指导，不扩大用户授权，也不改变客户端指令的优先级。

规则采集和路径校验仍在执行前进行；规则文件不可读、内容或响应超过预算时，调用仍可能失败。准备操作期间工作区被并发重新打开，或规则历史达到上限时，返回 `WORKSPACE_REOPEN_REQUIRED`，本次操作未执行；按错误指引重新打开工作区后继续。这些是状态失效和资源限制错误，不以规则是否已返回作为执行条件。

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

当前打开期间目录保持不变。裸名若匹配多个来源，返回 `SKILL_AMBIGUOUS`，应从目录选择名称。未知名称返回 `SKILL_NOT_FOUND`。重新打开工作区会重新发现 skill，并可能分配不同名称，以新目录中的名称为准。

读取 skill 期间若工作区被重新打开，本次旧目录的读取结果会被丢弃，并返回 `WORKSPACE_REOPEN_REQUIRED`；按错误指引重新打开，再使用当前目录中的名称读取。

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
| `wait_seconds` | number | 否 | `120` | 前台最多等待多少秒，支持小数。到期只交还控制权，原任务继续运行。0 表示启动后立即返回。取值 0～300。 |

不提供命令 `timeout_seconds`，也不设命令运行时限。等待到期不会杀进程；需要终止时调用 `ssh_task_stop`。建连工具的 `timeout_seconds` 仍只用于连接准备。

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

较长的等待要求 MCP 客户端的调用超时覆盖相应时长。输出到来不会重置等待预算，也不会提前结束前台等待。取消尚未返回的 Bash 调用会请求停止任务，并在错误中给出任务 ID 和日志路径。

命令已完成但退出码非零、被取消或遇到输出预算等异常时，`ssh_bash` 设置 MCP `isError=true`，文本中仍保留结果。查询或停止成功取得任务状态时正常返回，即使命令本身失败。

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
| `wait_seconds` | number | 否 | `30` | 最多等待任务结束的秒数，支持小数。0 表示立即查询；输出到来不会提前结束等待。取值 0～300。 |

### 返回

使用任务报告格式。等待任务结束或预算用尽后返回；`wait_seconds=0` 立即查询。取消这次查询仅取消等待，命令继续运行。成功返回后，该任务在 `ssh_task_list` 中标记为已读；之后的新输出会让它重新出现。

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

任务 ID 同时是远端日志文件名。丢失 `task_id` 时，先用 `ssh_task_list` 找回；MCP 重启后任务列表清空，可再用 `ssh_sessions` 取得 `connection_id`，通过 `ssh_bash` 执行 `ls -1 ~/.neverssh/sessions/<connection_id>/*.log` 找回日志文件名。

连接关闭后，原任务 ID 仍可查询本 MCP 已保留的任务结果，不能据此运行新命令。本地任务表最多 256 项；新任务启动时移除结束已满 14 天的记录，容量紧张时按启动顺序移除已结束记录。活动任务不按年龄移除；本地记录清理不删除远端日志。

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

列出所有尚未被 `ssh_task_output` 读取内容的保留任务，适合发现还没取回结果的任务。`ssh_task_output` 成功返回后，该任务从列表移除；之后产生的新输出会让它重新出现。

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

没有任务时返回 `No tasks.`。活动任务排在前面；已结束任务按结束时间从新到旧排列。前台成功且完整显示输出的短命令不会进入列表；后台运行、等待到期、截断或失败的任务会保留，直到调用 `ssh_task_output`。

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

任务列表只包含当前 MCP 实例的记录。MCP 重启后列表为空，但远端日志仍按保留期存在；此时无法恢复旧任务句柄，只能读取日志。`ssh_task_list` 不读取任务输出；详情和预览使用 `ssh_task_output`。

## 文件与传输

文件工具必须且只能选择 `connection_id` 或 `workspace_id`。`file_path` 是远端路径：连接模式相对远端 HOME 解析，工作区模式相对项目根目录解析。读取返回带行号的文本或受支持的图片，并按真实目标路径记录文件版本；符号链接与已读取的其他路径拼写共享该版本，编辑前必须读取或写入该文件。工作区文件和传输操作在结果中附加新增、变更或删除的适用规则，规则变化不阻止操作；恢复根目录上下文使用再次 `ssh_workspace_open`。连接模式不加载项目上下文。目录列表、文件查找和内容搜索通过 `ssh_bash` 执行 `ls`、`find`、`rg`。

远端写入、上传和下载会自动创建缺失的父目录；配置了非空 `localTransferRoots` 时，本地父目录不能通过符号链接逃出该范围。`ssh_upload` / `ssh_download` 使用 SFTP，复用当前连接的 ControlMaster；其他工具走 worker，包括图片读取。SSH 压缩默认开启（`compression: true`），可通过本地配置关闭。文件版本由服务端内部记录。项目开发默认直接使用远端文件工具，批量修改和代码生成使用远端 `ssh_bash`；上传下载用于具体的文件传输需求。

## ssh_read_file

读取远端 UTF-8 文本或图片，不增加必填参数。文本返回带行号的内容，受支持的图片返回原生 MCP `image` 内容块。读取会记录文件版本，供后续文件版本检查使用。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
| `file_path` | string | 是 | 无 | 远端文本或图片文件路径；工作区模式相对项目根目录解析，连接模式相对远端 HOME 解析。最长 4096 个字符。 |
| `offset` | integer | 否 | `1` | 文本起始行号，从 1 开始；读取图片时忽略。不小于 1。 |
| `limit` | integer | 否 | `2000` | 最多读取的文本行数；图片始终完整返回。不小于 1。 |

### 返回

文本正文返回带行号的内容，使用 `cat -n` 风格；工作区规则增量另放第二个文本块：

```text
     1	import { createServer } from "node:http";
     2	
```

读取被截断时追加：

```text
PARTIAL view: showing lines 1-2000 of 5000. Use offset=2001 to continue.
```

空文件返回 `File exists but is empty.`；`offset` 超过最后一行时返回 `File has <N> lines; offset <M> is past the end.`

图片完整返回为原生 MCP `image` 内容块，不把图片数据写入文本，也不在本地保存文件。客户端需要支持 MCP 图片显示。工作区规则有变化时，仍在图片后附加独立的文本块；未变化的规则不重复返回。

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

按文件内容的标识识别 PNG、JPEG、GIF 和 WebP，不依赖扩展名。查看远端图片直接传入其 `file_path`，无需通过 SFTP 下载到本地。图片完整返回，`offset` 和 `limit` 只适用于文本。SVG 仍作为 UTF-8 文本读取，其他二进制文件返回文本错误。

文本默认从第 1 行读取最多 2000 行，用 `offset` 和 `limit` 分页。文本和图片的全文件都必须不超过 `maxFileBytes`（默认 4 MiB，可配置到 8 MiB）；文本单次读取还有约 256 KiB 的字节预算，长行较多时会提前截断并返回 `PARTIAL view`。

图片及附带规则的完整 MCP 结果序列化后另有 9 MiB 上限，独立于原始文件的 `maxFileBytes` 限制。超限时返回文本错误，需缩小图片后重试；不会截断图片或自动下载。本次未交付的工作区规则不会被记为已返回。

读取不会延长日志保留期。读取结果会记录文件版本；`ssh_edit_file` 需要同一连接下先读取或写入该文件。

## ssh_write_file

创建或覆盖远端文件，写入完整内容。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
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

新文件直接创建。已有文件必须在本 MCP 进程中读取或写入过；读取/写入记录存在时，服务端自动校验版本，外部修改会返回冲突。没有 `overwrite` 参数，需要覆盖时先读取文件。成功后记录新版本，后续 `ssh_edit_file` 可直接使用。`file_path` 是远端路径，不是本地沙箱。

## ssh_edit_file

对远端文件做一次精确文本替换，全部成功或完全不改。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
| `file_path` | string | 是 | 无 | 要编辑的远端文件；工作区模式相对项目根目录解析，连接模式相对远端 HOME 解析。最长 4096 个字符。 |
| `old_string` | string | 是 | 无 | 要替换的原文；不能为空，且不能含 NUL。字符数上限随 maxFileBytes 配置。最长 4194304 个字符。 |
| `new_string` | string | 是 | 无 | 替换后的文本；字符数上限随 maxFileBytes 配置，结果另受远端文件字节上限约束。最长 4194304 个字符。 |
| `replace_all` | boolean | 否 | `false` | 为 true 时替换所有匹配；否则必须恰好匹配一次。 |

### 返回

```text
The file /srv/app/notes.txt has been updated successfully.
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
```

### 行为和失败情况

必须先在同一连接下用 `ssh_read_file` 读取或 `ssh_write_file` 写入该文件；否则返回 `FILE_NOT_READ`。服务端用记录的 sha256 检查冲突，文件被外部修改时拒绝编辑，需要重新读取。

`replace_all=false` 时 `old_string` 必须恰好出现一次；`replace_all=true` 时至少出现一次。匹配数不符或文件无法作为 UTF-8 文本读取时不写入任何内容。替换保留原始换行、Unix mode 和所有者；目标必须已存在，不会创建新文件。

## ssh_upload

把本地二进制文件上传到远端路径。

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `connection_id` | string | 否 | 无 | 远端连接 ID；与 workspace_id 必须且只能填写一个。 |
| `workspace_id` | string | 否 | 无 | 远端工作区 ID；与 connection_id 必须且只能填写一个。 |
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
| `FILE_NOT_READ` | 编辑前没有读取或写入该文件 | 先调用 `ssh_read_file` 或 `ssh_write_file`。 |
| `WORKSPACE_NOT_FOUND` | 工作区 ID 无效或不再可用 | 确认连接可用后重新打开项目。 |
| `WORKSPACE_REOPEN_REQUIRED` | 准备操作期间工作区被重新打开、规则历史达到上限，或 skill 读取结果所属的目录已失效 | 按具体错误指引重新打开工作区；准备阶段失败时操作未执行，过期 skill 的结果会被丢弃。 |
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

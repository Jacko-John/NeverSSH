/** Update input field tables while preserving handwritten text results and examples. */
import { z } from "zod";
import { configSchema } from "../src/config";
import { createToolContracts } from "../src/mcp/contracts";

const toolContracts = createToolContracts(configSchema.parse({}).maxFileBytes);

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

/** Describe caller-visible meaning here; types, defaults, and bounds come from the MCP schemas. */
const taskScope = {
  task_id: "ssh_bash 返回的 task_ 加 8 位十六进制任务 ID。",
};
const operationScope = {
  connection_id: "远端连接 ID；与 workspace_id 必须且只能填写一个。",
  workspace_id: "远端工作区 ID；与 connection_id 必须且只能填写一个。",
};
const fileScope = {
  ...operationScope,
  workspace_rules_ack: "仅用于工作区。阅读 WORKSPACE_RULES_CHANGED 的规则后，在重试原调用时原样回传其中的确认值。",
};
const descriptions: Record<string, Record<string, string>> = {
  "ssh_connect.input": {
    host: "SSH 别名、主机名或 IP，例如 dev-server。账号单独填写在 user。",
    user: "登录账号。省略时沿用本机 SSH 配置；传入时覆盖配置值。",
    port: "SSH 端口。省略时沿用本机 SSH 配置；传入时覆盖配置值。",
    timeout_seconds: "整个连接过程的超时，单位为秒，支持小数。包括配置解析、认证和远端准备。",
  },
  "ssh_close.input": {
    connection_id: "要关闭的连接 ID。",
  },
  "ssh_bash.input": {
    ...operationScope,
    command: "交给远端 Bash 执行的命令。不允许 NUL；环境变量可直接写在命令中。",
    cwd: "本次命令的远端工作目录。工作区模式默认项目根目录，相对路径基于根目录；连接模式默认远端 HOME。",
    run_in_background: "启动确认后立即返回；为 true 时不使用 wait_seconds。",
    wait_seconds: "前台最多等待多少秒，支持小数。到期只交还控制权，原任务继续运行。0 表示启动后立即返回。",
  },
  "ssh_task_output.input": {
    ...taskScope,
    wait_seconds: "最多等待任务结束的秒数，支持小数。0 表示立即查询；输出到来不会提前结束等待。",
  },
  "ssh_task_stop.input": taskScope,
  "ssh_task_list.input": {
    connection_id: "只列出该连接的任务；省略时列出全部连接。",
  },
  "ssh_workspace_open.input": {
    connection_id: "打开项目所用的远端连接 ID。",
    path: "已存在的远端项目目录；支持绝对路径、~/ 和相对于远端 HOME 的路径。",
    skill_directories: "替换默认远端 skill 搜索目录，统一从工作区根目录解析一次；默认 .agents/skills 和 .claude/skills，不支持随目标路径发现子目录 skill。绝对路径和 ~/ 指向远端共享目录；空数组关闭发现。",
  },
  "ssh_skill_read.input": {
    workspace_id: "skill 所属的工作区 ID。",
    skill_name: "工作区目录列出的 skill 名称，例如 testing 或 shared@testing；原样使用目录中的名称。",
    resource: "相对于远端 skill 目录的 UTF-8 文本资源路径；默认读取 SKILL.md，不执行脚本。",
  },
  "ssh_read_file.input": {
    ...fileScope,
    file_path: "远端文件路径；工作区模式相对项目根目录解析，连接模式相对远端 HOME 解析。",
    offset: "文本起始行号，省略时从第 1 行开始。",
    limit: "最多读取的文本行数，省略时为 2000 行。",
  },
  "ssh_write_file.input": {
    ...fileScope,
    file_path: "目标远端文件；工作区模式相对项目根目录解析，连接模式相对远端 HOME 解析。",
    content: "完整文件内容；字符数上限随 maxFileBytes 配置，远端另按 UTF-8 字节数校验。",
  },
  "ssh_edit_file.input": {
    ...fileScope,
    file_path: "要编辑的远端文件；工作区模式相对项目根目录解析，连接模式相对远端 HOME 解析。",
    old_string: "要替换的原文；不能为空，且不能含 NUL。字符数上限随 maxFileBytes 配置。",
    new_string: "替换后的文本；字符数上限随 maxFileBytes 配置，结果另受远端文件字节上限约束。",
    replace_all: "为 true 时替换所有匹配；否则必须恰好匹配一次。",
  },
  "ssh_upload.input": {
    ...fileScope,
    cwd: "远端工作目录；默认使用工作区根目录或连接的远端 HOME。",
    localPath: "本地文件的绝对路径；localTransferRoots 非空时，必须位于其中一个目录内。",
    remotePath: "目标远端路径；支持绝对路径、~/ 和相对于 cwd 的路径。",
    overwrite: "显式允许覆盖已存在的远端文件。",
    expectedSha256: "期望的远端文件 SHA-256，小写十六进制；用于冲突检查。",
  },
  "ssh_download.input": {
    ...fileScope,
    cwd: "远端工作目录；默认使用工作区根目录或连接的远端 HOME。",
    remotePath: "要下载的远端路径；支持绝对路径、~/ 和相对于 cwd 的路径。",
    localPath: "本地文件的绝对路径；localTransferRoots 非空时，必须位于其中一个目录内。",
    overwrite: "显式允许覆盖已存在的本地文件。",
  },
};

/** Render ordinary type names and enum values without raw validation expressions. */
function displayType(schema: Schema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => `\`${JSON.stringify(value)}\``).join(" / ");
  if (schema.anyOf) return schema.anyOf.map(displayType).join(" / ");
  if (schema.type === "array") return `${displayType(schema.items ?? {})}[]`;
  return Array.isArray(schema.type) ? schema.type.join(" / ") : schema.type ?? "object";
}

/** Express numeric and length constraints in words alongside the field's meaning. */
function displayBounds(schema: Schema): string {
  if (schema.minItems !== undefined && schema.maxItems !== undefined) return `包含 ${schema.minItems}～${schema.maxItems} 项。`;
  if (schema.maxItems !== undefined) return `最多 ${schema.maxItems} 项。`;
  const minimum = schema.minimum === Number.MIN_SAFE_INTEGER ? undefined : schema.minimum;
  const maximum = schema.maximum === Number.MAX_SAFE_INTEGER ? undefined : schema.maximum;
  if (minimum !== undefined && maximum !== undefined) {
    return `取值 ${minimum}～${maximum}。`;
  }
  if (minimum !== undefined) return `不小于 ${minimum}。`;
  if (maximum !== undefined) return `不大于 ${maximum}。`;
  if (schema.maxLength !== undefined && schema.minLength === schema.maxLength) return `长度为 ${schema.maxLength} 个字符。`;
  if (schema.maxLength !== undefined) return `最长 ${schema.maxLength} 个字符。`;
  return "";
}

/** Keep nested fields next to their containing array or object. */
function fieldRows(schema: Schema, block: string, prefix = ""): string[] {
  const rows: string[] = [];
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${name}`;
    const description = descriptions[block]?.[path];
    if (!description) throw new Error(`Missing documentation for ${block}.${path}`);
    const required = schema.required?.includes(name) ?? false;
    const meaning = `${description}${displayBounds(field)}`;
    const type = displayType(field);

    const fallback = field.default === undefined ? "无" : `\`${JSON.stringify(field.default)}\``;
    rows.push(`| \`${path}\` | ${type} | ${required ? "是" : "否"} | ${fallback} | ${meaning} |`);

    if (field.properties) rows.push(...fieldRows(field, block, `${path}.`));
    if (field.items?.properties) rows.push(...fieldRows(field.items, block, `${path}[].`));
  }
  return rows;
}

/** Generate a field table without changing the surrounding explanation or examples. */
function fieldTable(schema: Schema, block: string): string {
  if (!Object.keys(schema.properties ?? {}).length) return "无参数，传入 `{}`。";
  const header = ["| 参数 | 类型 | 必填 | 默认值 | 说明 |", "| --- | --- | --- | --- | --- |"];
  return [...header, ...fieldRows(schema, block)].join("\n");
}

/** Find one visible heading and stop at the next heading of the same or a higher level. */
function sectionRange(lines: string[], heading: string, start = 0, end = lines.length): { start: number; end: number } {
  const matches: number[] = [];
  for (let index = start; index < end; index++) {
    if (lines[index] === heading) matches.push(index);
  }
  if (matches.length !== 1) throw new Error(`Expected one heading: ${heading}`);

  const contentStart = matches[0]! + 1;
  const level = heading.indexOf(" ");
  let contentEnd = contentStart;
  for (; contentEnd < end; contentEnd++) {
    const nextHeading = /^(#{1,6}) /.exec(lines[contentEnd]!);
    if (nextHeading && nextHeading[1]!.length <= level) break;
  }
  return { start: contentStart, end: contentEnd };
}

/** Update only the schema description under the tool's visible parameter heading. */
function replaceTable(document: string, name: string, schema: Schema): string {
  const lines = document.split("\n");
  const block = `${name}.input`;
  let section = sectionRange(lines, `## ${name}`);
  section = sectionRange(lines, "### 参数", section.start, section.end);

  // Parameterless tools use a sentence in place of an empty field table.
  if (!Object.keys(schema.properties ?? {}).length) {
    lines.splice(section.start, section.end - section.start, "", fieldTable(schema, block), "");
    return lines.join("\n");
  }

  const tableStart = lines.findIndex((line, index) =>
    index >= section.start && index < section.end && line.startsWith("|"));
  if (tableStart < 0) throw new Error(`Missing field table for ${block}`);
  let tableEnd = tableStart;
  while (tableEnd < section.end && lines[tableEnd]!.startsWith("|")) tableEnd++;
  lines.splice(tableStart, tableEnd - tableStart, ...fieldTable(schema, block).split("\n"));
  return lines.join("\n");
}

const filename = new URL("../docs/interfaces.md", import.meta.url);
const source = await Bun.file(filename).text();
let expected = source;
for (const [name, contract] of Object.entries(toolContracts)) {
  const input = z.toJSONSchema(contract.input, { io: "input" }) as Schema;
  expected = replaceTable(expected, name, input);
}

if (process.argv.includes("--check")) {
  if (expected !== source) {
    console.error("Interface field tables are stale. Run bun run docs:sync.");
    process.exitCode = 1;
  }
} else {
  await Bun.write(filename, expected);
}

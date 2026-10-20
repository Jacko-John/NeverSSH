/** Update each tool's field tables while preserving its handwritten explanation and examples. */
import { z } from "zod";
import { toolContracts } from "../src/contracts";

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
  maxLength?: number;
};

/** Describe caller-visible meaning here; types, defaults, and bounds come from the MCP schemas. */
const taskScope = {
  task_id: "ssh_bash 返回的 task_ 加 8 位十六进制任务 ID。",
};
const descriptions: Record<string, Record<string, string>> = {
  "ssh_discover.output": {
    servers: "所有可枚举、且访问规则允许的 SSH 入口。没有候选时返回空数组。",
    "servers[].host": "连接入口，可直接传给 ssh_connect。",
  },
  "ssh_connect.input": {
    host: "SSH 别名、主机名或 IP，例如 dev-server。账号单独填写在 user。",
    user: "登录账号。省略时沿用本机 SSH 配置；传入时覆盖配置值。",
    port: "SSH 端口。省略时沿用本机 SSH 配置；传入时覆盖配置值。",
    timeout_seconds: "整个连接过程的超时，单位为秒，支持小数。包括配置解析、认证和远端准备。",
  },
  "ssh_connect.output": {
    connection_id: "连接的短 ID。拿到它后即可调用远端命令和文件工具；任务工具只使用 task_id。",
  },
  "ssh_sessions.output": {
    sessions: "当前 MCP 实例中可用的全部连接。没有可用连接时返回空数组。",
    "sessions[].connection_id": "后续操作使用的短 ID。",
    "sessions[].host": "建立连接时传入的入口，与 ssh_connect 的 host 相同。",
    "sessions[].user": "这条连接实际使用的登录账号。",
    "sessions[].port": "这条连接实际使用的 SSH 端口。",
  },
  "ssh_close.input": {
    connection_id: "要关闭的连接 ID。",
  },
  "ssh_close.output": {
    connection_id: "本次关闭的连接 ID。",
    closed: "本地连接已关闭。成功时始终为 true。",
    remote_cleanup: "confirmed：远端已确认清理完成；unconfirmed：远端清理结果未知。",
  },
  "ssh_bash.input": {
    connection_id: "执行命令的连接 ID。",
    command: "交给远端 Bash 执行的命令。不允许 NUL；环境变量可直接写在命令中。",
    cwd: "本次命令的远端工作目录。省略时使用远端 HOME；支持绝对路径、~/ 和相对于 HOME 的路径。",
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
  error: {
    error: "本次调用失败的原因。",
    "error.code": "供调用方判断的错误码。",
    "error.message": "失败原因的文字说明。",
    "error.details": "补充信息，例如 connection_id 或目标主机。",
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
  const minimum = schema.minimum === Number.MIN_SAFE_INTEGER ? undefined : schema.minimum;
  const maximum = schema.maximum === Number.MAX_SAFE_INTEGER ? undefined : schema.maximum;
  if (minimum !== undefined && maximum !== undefined) {
    return `取值 ${minimum}～${maximum}。`;
  }
  if (minimum !== undefined) return `不小于 ${minimum}。`;
  if (maximum !== undefined) return `不大于 ${maximum}。`;
  if (schema.maxLength !== undefined) return `最长 ${schema.maxLength} 个字符。`;
  return "";
}

/** Keep nested fields next to their containing array or object. */
function fieldRows(schema: Schema, block: string, input: boolean, prefix = ""): string[] {
  const rows: string[] = [];
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}${name}`;
    const description = descriptions[block]?.[path];
    if (!description) throw new Error(`Missing documentation for ${block}.${path}`);
    const required = schema.required?.includes(name) ?? false;
    const meaning = `${description}${displayBounds(field)}`;
    const type = displayType(field);

    if (input) {
      const fallback = field.default === undefined ? "无" : `\`${JSON.stringify(field.default)}\``;
      rows.push(`| \`${path}\` | ${type} | ${required ? "是" : "否"} | ${fallback} | ${meaning} |`);
    } else {
      rows.push(`| \`${path}\` | ${type}${required ? "" : "（可省略）"} | ${meaning} |`);
    }

    if (field.properties) rows.push(...fieldRows(field, block, input, `${path}.`));
    if (field.items?.properties) rows.push(...fieldRows(field.items, block, input, `${path}[].`));
  }
  return rows;
}

/** Generate a field table without changing the surrounding explanation or examples. */
function fieldTable(schema: Schema, block: string, input: boolean): string {
  if (input && !Object.keys(schema.properties ?? {}).length) return "无参数，传入 `{}`。";
  const header = input
    ? ["| 参数 | 类型 | 必填 | 默认值 | 说明 |", "| --- | --- | --- | --- | --- |"]
    : ["| 字段 | 类型 | 说明 |", "| --- | --- | --- |"];
  return [...header, ...fieldRows(schema, block, input)].join("\n");
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

/** Update the schema description under the tool's visible parameter or result heading. */
function replaceTable(document: string, block: string, schema: Schema, input: boolean): string {
  const lines = document.split("\n");
  const [name, direction] = block.split(".");
  let section = sectionRange(lines, name === "error" ? "## 错误返回" : `## ${name}`);
  if (direction) {
    section = sectionRange(lines, input ? "### 参数" : "### 返回", section.start, section.end);
  }

  // Parameterless tools use a sentence in place of an empty field table.
  if (input && !Object.keys(schema.properties ?? {}).length) {
    lines.splice(section.start, section.end - section.start, "", fieldTable(schema, block, input), "");
    return lines.join("\n");
  }

  const tableStart = lines.findIndex((line, index) =>
    index >= section.start && index < section.end && line.startsWith("|"));
  if (tableStart < 0) throw new Error(`Missing field table for ${block}`);
  let tableEnd = tableStart;
  while (tableEnd < section.end && lines[tableEnd]!.startsWith("|")) tableEnd++;
  lines.splice(tableStart, tableEnd - tableStart, ...fieldTable(schema, block, input).split("\n"));
  return lines.join("\n");
}

const filename = new URL("../docs/interfaces.md", import.meta.url);
const source = await Bun.file(filename).text();
let expected = source;
for (const [name, contract] of Object.entries(toolContracts)) {
  const input = z.toJSONSchema(contract.input, { io: "input" }) as Schema;
  expected = replaceTable(expected, `${name}.input`, input, true);
  if ("output" in contract) {
    const output = z.toJSONSchema(contract.output) as Schema;
    const success = output.anyOf!.find((schema) => !schema.properties?.error)!;
    expected = replaceTable(expected, `${name}.output`, success, false);
  }
}
const error = (z.toJSONSchema(toolContracts.ssh_connect.output) as Schema).anyOf!
  .find((schema) => schema.properties?.error)!;
expected = replaceTable(expected, "error", error, false);

if (process.argv.includes("--check")) {
  if (expected !== source) {
    console.error("Interface field tables are stale. Run bun run docs:sync.");
    process.exitCode = 1;
  }
} else {
  await Bun.write(filename, expected);
}

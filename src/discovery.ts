/** Enumerates literal SSH aliases; an inventory entry is a candidate, never proof of reachability. */
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { hostField, targetAllowed, type Config } from "./config";
import { ToolError } from "./errors";
import { resolveTarget } from "./openssh";

/** Tokenize configuration words with quoted values, comments, escapes, and keyword=value syntax. */
function words(line: string): string[] {
  const result: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) { word += character; escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; else word += character; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#") break;
    if (/\s/.test(character) || (character === "=" && result.length === 0)) {
      if (word) { result.push(word); word = ""; }
    } else word += character;
  }
  if (word) result.push(word);
  return result;
}

/** Read static Include trees without evaluating Match exec, scanning networks, or reading keys. */
export async function configuredHosts(config: Config): Promise<string[]> {
  const hosts = new Set<string>();
  const visited = new Set<string>();
  let bytes = 0;
  const visit = async (filename: string, base: string, optional: boolean, depth: number): Promise<void> => {
    if (depth > 16 || visited.size >= 512) throw new ToolError("DISCOVERY_FAILED", "SSH Include tree exceeds discovery limits");
    const canonical = await realpath(filename).catch((error: NodeJS.ErrnoException) => {
      if (optional && error.code === "ENOENT") return undefined;
      throw new ToolError("DISCOVERY_FAILED", `Cannot read SSH configuration: ${filename}`);
    });
    if (!canonical || visited.has(canonical)) return;
    visited.add(canonical);
    const info = await stat(canonical);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ToolError("DISCOVERY_FAILED", "SSH configuration must be a bounded regular file");
    const content = await readFile(canonical, "utf8").catch(() => { throw new ToolError("DISCOVERY_FAILED", `Cannot read SSH configuration: ${filename}`); });
    bytes += Buffer.byteLength(content);
    if (bytes > 2 * 1024 * 1024) throw new ToolError("DISCOVERY_FAILED", "SSH configuration exceeds the discovery size limit");
    for (const line of content.split(/\r?\n/)) {
      const [keyword, ...values] = words(line);
      if (keyword?.toLowerCase() === "host") {
        for (const host of values) if (!/[!*?]/.test(host) && hostField.safeParse(host).success) hosts.add(host);
        if (hosts.size > 4096) throw new ToolError("DISCOVERY_FAILED", "More than 4096 literal SSH aliases; narrow the SSH configuration");
      } else if (keyword?.toLowerCase() === "include") {
        for (let pattern of values) {
          // Per-target tokens cannot be expanded without an actual destination. Direct connect still works.
          if (pattern.includes("%") || pattern.includes("${")) continue;
          if (pattern.startsWith("~/")) pattern = join(homedir(), pattern.slice(2));
          else if (!isAbsolute(pattern)) pattern = join(base, pattern);
          const included: string[] = [];
          for await (const path of new Bun.Glob(pattern).scan({ absolute: true, onlyFiles: true, dot: true })) included.push(path);
          for (const path of included.sort()) await visit(path, base, false, depth + 1);
        }
      }
    }
  };
  if (config.sshConfig) await visit(config.sshConfig, join(homedir(), ".ssh"), false, 0);
  else {
    await visit(join(homedir(), ".ssh/config"), join(homedir(), ".ssh"), true, 0);
    await visit("/etc/ssh/ssh_config", "/etc/ssh", true, 0);
  }
  return [...hosts].sort();
}

export class Discovery {
  constructor(private readonly config: Config) {}

  /** Return all enumerable candidates allowed by the same endpoint policy as direct connections. */
  async discover(signal?: AbortSignal): Promise<{ servers: { host: string }[] }> {
    const hosts = await configuredHosts(this.config);
    // Unrestricted discovery only reads configuration; it does not resolve or connect to hosts.
    if (this.config.access.allow === undefined && !this.config.access.deny.length) {
      return { servers: hosts.map((host) => ({ host })) };
    }

    // Evaluate restricted targets with bounded concurrency, then restore stable ordering.
    const servers: { host: string }[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, hosts.length) }, async () => {
      while (next < hosts.length) {
        const target = { host: hosts[next++]! };
        const { endpoint } = await resolveTarget(this.config, target, signal);
        if (targetAllowed(this.config, target, endpoint)) servers.push(target);
      }
    }));
    servers.sort((a, b) => a.host.localeCompare(b.host));
    return { servers };
  }
}

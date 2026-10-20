/** Loads optional local settings; targets are discovered or supplied at connection time. */
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const cleanString = z.string().min(1).refine((value) => !value.includes("\0"), "NUL is not allowed");

/**
 * Shape checks use refine rather than regex: a regex constraint is published as the JSON Schema
 * `pattern` keyword, which some model providers reject with a 400. Validation is unchanged.
 */
const shaped = (schema: z.ZodString, expression: RegExp, message: string) =>
  schema.refine((value) => expression.test(value), message);

export const hostField = shaped(cleanString.max(255), /^[a-zA-Z0-9_:[\]][a-zA-Z0-9_.:[\]%-]*$/,
  "Use an SSH alias, hostname, or IP; pass user separately");
export const userField = shaped(cleanString.max(255), /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, "Use an SSH login name");
export const portField = z.number().int().min(1).max(65535);
const accessRule = z.strictObject({
  host: shaped(cleanString.max(255), /^[a-zA-Z0-9_*?.:[\]%-]+$/, "Use a host pattern with optional * and ?"),
  user: cleanString.max(255).optional(),
  port: portField.optional(),
});

export const configSchema = z.strictObject({
  version: z.literal(1).default(1),
  sshConfig: cleanString.optional(),
  access: z.strictObject({
    allow: z.array(accessRule).max(1000).optional(),
    deny: z.array(accessRule).max(1000).default([]),
  }).default({ deny: [] }),
  localTransferRoots: z.array(cleanString).default([]),
  compression: z.boolean().default(true),
  maxFileBytes: z.number().int().min(1024).max(8 * 1024 * 1024).default(4 * 1024 * 1024),
  maxTaskOutputBytes: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024),
  maxArchiveBytes: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER).default(1024 * 1024 * 1024),
});

export type Config = z.infer<typeof configSchema>;
export type SshTarget = { host: string; user?: string; port?: number };
export type Endpoint = { host: string; user: string; port: number };

/** Resolves config-relative local paths and verifies transfer roots without opening SSH connections. */
export async function loadConfig(filename = "neverssh.config.json", optional = false): Promise<Config> {
  const configPath = resolve(filename);
  const source = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return "{}";
    throw error;
  });
  const config = configSchema.parse(JSON.parse(source));
  const directory = resolve(configPath, "..");
  if (config.sshConfig) {
    config.sshConfig = resolve(directory, config.sshConfig);
    if (!(await stat(config.sshConfig)).isFile()) throw new Error("sshConfig must be a regular file");
  }
  config.localTransferRoots = await Promise.all(config.localTransferRoots.map(async (root) => {
    const canonical = await realpath(resolve(directory, root));
    if (!(await stat(canonical)).isDirectory()) throw new Error("Each localTransferRoot must be a directory");
    return canonical;
  }));
  return config;
}

/** Match * and ? with literal IPv6 brackets and case-sensitive login names. */
function matches(pattern: string, value: string, insensitive: boolean): boolean {
  const expression = [...pattern].map((character) => character === "*" ? ".*" : character === "?" ? "." : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${expression}$`, insensitive ? "i" : "").test(value);
}

/** Apply deny-first rules to both the supplied alias and effective destination. */
export function targetAllowed(config: Config, target: SshTarget, endpoint: Endpoint): boolean {
  const match = (rule: z.infer<typeof accessRule>) =>
    (matches(rule.host, target.host, true) || matches(rule.host, endpoint.host, true)) &&
    (rule.user === undefined || matches(rule.user, endpoint.user, false)) &&
    (rule.port === undefined || rule.port === endpoint.port);
  return !config.access.deny.some(match) && (config.access.allow === undefined || config.access.allow.some(match));
}

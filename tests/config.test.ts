/** Verify trusted local configuration boundaries before SSH or transfers are possible. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema, hostField, loadConfig, targetAllowed } from "../src/config";
import { sftpOptions, sshOptions } from "../src/openssh";
import { transferPath } from "../src/transfers";

let root: string;
beforeAll(async () => { root = await realpath(await mkdtemp("/tmp/neverssh-config-test-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("empty configuration inherits SSH access and rejects credentials and legacy target lists", () => {
  const config = configSchema.parse({});
  expect(config.access).toEqual({ deny: [] });
  expect(config.maxTaskOutputBytes).toBe(64 * 1024 * 1024);
  expect(config.maxArchiveBytes).toBe(1024 * 1024 * 1024);
  expect(config.compression).toBe(true);
  expect(configSchema.safeParse({ compression: "yes" }).success).toBe(false);
  expect(configSchema.safeParse({ maxTaskOutputBytes: 0 }).success).toBe(false);
  expect(configSchema.safeParse({ maxArchiveBytes: -1 }).success).toBe(false);
  expect(() => configSchema.parse({ password: "unused" })).toThrow();
  expect(() => configSchema.parse({ targets: {} })).toThrow();
  for (const host of ["-oProxyCommand=bad", "user@host", "host$(touch bad)", "host\nother"]) expect(hostField.safeParse(host).success).toBe(false);
});

test("SSH compression is opt-out and applies to worker and SFTP transports", () => {
  const enabled = configSchema.parse({});
  const disabled = configSchema.parse({ compression: false });
  const target = { host: "dev" };
  expect(sshOptions(enabled, target, "/tmp/socket", true)).toContain("Compression=yes");
  expect(sshOptions(disabled, target, "/tmp/socket", true)).not.toContain("Compression=yes");
  expect(sftpOptions(enabled, target, "/tmp/socket")).toContain("Compression=yes");
  expect(sftpOptions(disabled, target, "/tmp/socket")).not.toContain("Compression=yes");
});

test("local paths are resolved relative to the config file and canonicalized", async () => {
  await mkdir(join(root, "transfers"));
  await writeFile(join(root, "ssh_config"), "Host dev\n  HostName example.invalid\n");
  const filename = join(root, "config.json");
  await writeFile(filename, JSON.stringify({ version: 1,
    sshConfig: "ssh_config", localTransferRoots: ["transfers"] }));
  const config = await loadConfig(filename);
  expect(config.sshConfig).toBe(join(root, "ssh_config"));
  expect(config.localTransferRoots).toEqual([join(root, "transfers")]);
});

test("optional default config works but explicit missing files and transfer roots fail", async () => {
  const filename = join(root, "invalid.json");
  expect((await loadConfig(filename, true)).access.allow).toBeUndefined();
  await expect(loadConfig(filename)).rejects.toThrow();
  await writeFile(filename, JSON.stringify({ localTransferRoots: ["absent"] }));
  await expect(loadConfig(filename)).rejects.toThrow();
});

test("disabled transfers fail before resolving or inspecting local user paths", async () => {
  const config = configSchema.parse({});
  await expect(transferPath(config, join(root, "does-not-exist"), false)).rejects.toThrow("Local transfers are disabled");
  await expect(transferPath(config, root, true)).rejects.toThrow("Local transfers are disabled");
});

test("access rules restrict requested aliases and effective hosts with deny taking precedence", () => {
  const endpoint = { host: "dev.example.com", user: "builder", port: 2222 };
  expect(targetAllowed(configSchema.parse({}), { host: "dev" }, endpoint)).toBe(true);
  expect(targetAllowed(configSchema.parse({ access: { allow: [] } }), { host: "dev" }, endpoint)).toBe(false);
  const config = configSchema.parse({ access: { allow: [{ host: "*.example.com", user: "build*", port: 2222 }], deny: [{ host: "prod*" }] } });
  expect(targetAllowed(config, { host: "dev" }, endpoint)).toBe(true);
  expect(targetAllowed(config, { host: "production" }, endpoint)).toBe(false);
  expect(targetAllowed(config, { host: "dev" }, { ...endpoint, user: "root" })).toBe(false);
  expect(targetAllowed(configSchema.parse({ access: { deny: [{ host: "dev.example.com" }] } }), { host: "alias" }, endpoint)).toBe(false);
});

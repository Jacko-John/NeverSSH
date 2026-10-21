/** End-to-end MCP stdio -> OpenSSH -> persistent worker -> isolated remote operations. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { SshFixture } from "./fixture";
import { Runtime } from "../src/server";
import { ShortIds } from "../src/ids";
import type { ConnectionSummary } from "../src/contracts";
import { BUILD_ID } from "../src/version-info";

const fixture = new SshFixture();
let client: Client;
let transport: StdioClientTransport;
let stderr = "";
let dev = "";

/** Call through the public MCP protocol, optionally requiring a model-readable tool error. */
async function call(name: string, args: Record<string, unknown> = {}, error = false): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const value = response.structuredContent;
  if (Boolean(response.isError) !== error) {
    const details = value && typeof value === "object" ? { ...value, output: undefined } : response;
    throw new Error(`${name}: ${JSON.stringify(details).slice(0, 4096)}`);
  }
  expect(value).toBeDefined();
  return value;
}

/** Select an available connection locally from the public list result. */
async function sessionSummary(connectionId: string): Promise<ConnectionSummary> {
  const { sessions } = await call("ssh_sessions");
  const summary = (sessions as ConnectionSummary[]).find((session) => session.connection_id === connectionId);
  expect(summary).toBeDefined();
  return summary!;
}

/** Call the public Bash tools and inspect their model-visible text, with no structured copy. */
async function taskCall(name: string, args: Record<string, unknown>, error = false): Promise<string> {
  const response = await client.callTool({ name, arguments: args });
  expect(response.structuredContent).toBeUndefined();
  expect(Boolean(response.isError), JSON.stringify(response.content).slice(0, 4096)).toBe(error);
  expect(response.content.every((item) => item.type === "text")).toBe(true);
  return response.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

/** Extract the handle exactly as a client reading a text result would. */
function taskScope(text: string): { task_id: string } {
  const task_id = /^Task: (task_[a-f0-9]{8})/m.exec(text)?.[1];
  if (!task_id) throw new Error("Missing task handle: " + text.slice(0, 4096));
  return { task_id };
}

/** The output path is remote, although the isolated loopback fixture makes it locally inspectable. */
function logPath(text: string): string {
  const path = /^Log: (.+?)(?: \(|; |$)/m.exec(text)?.[1];
  if (!path) throw new Error("Missing output file: " + text.slice(0, 4096));
  return path;
}

/** Successful short commands omit handles, so tests locate their archive by modification time. */
async function newestLog(connectionId: string): Promise<string> {
  const directory = join(fixture.workspace, ".neverssh", "sessions", connectionId);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".log"));
  const paths = await Promise.all(names.map(async (name) => {
    const path = join(directory, name);
    return { path, time: (await stat(path)).mtimeMs };
  }));
  paths.sort((left, right) => right.time - left.time);
  if (!paths[0]) throw new Error("No archived task log");
  return paths[0].path;
}

/** Read only the output section when asserting archived program bytes. */
async function logOutput(text: string): Promise<string> {
  const path = logPath(text);
  const metadata = JSON.parse(await readFile(path.replace(".log", ".meta.json"), "utf8"));
  return (await readFile(path)).subarray(metadata.output_offset).toString("utf8");
}

beforeAll(async () => {
  await fixture.start();
  transport = new StdioClientTransport({
    command: process.execPath, args: ["run", resolve(process.env.NEVERSSH_TEST_ENTRYPOINT ?? "src/index.ts"), "--config", fixture.configPath],
    env: { ...process.env } as Record<string, string>, stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  client = new Client({ name: "neverssh-integration-test", version: "1.0.0" });
  await client.connect(transport);
}, 20000);

afterAll(async () => {
  await client?.close();
  await fixture.close();
  if (stderr.includes("SyntaxError") || stderr.includes("Unhandled")) throw new Error(stderr);
}, 15000);

describe("MCP and connections", () => {
  test("discovers candidates without connecting and publishes strict connection contracts", async () => {
    const listing = await client.listTools();
    expect(listing.tools).toHaveLength(13);
    expect(listing.tools.some((tool) => tool.name === "ssh_disconnect")).toBe(false);
    expect(listing.tools.find((tool) => tool.name === "ssh_connect")?.outputSchema).toBeDefined();
    for (const name of ["ssh_bash", "ssh_task_output", "ssh_task_stop", "ssh_task_list"]) {
      expect(listing.tools.find((tool) => tool.name === name)?.outputSchema).toBeUndefined();
    }
    for (const name of ["ssh_exec", "ssh_poll", "ssh_input", "ssh_cancel", "ssh_jobs"]) {
      expect(listing.tools.some((tool) => tool.name === name)).toBe(false);
    }
    expect(Object.keys(listing.tools.find((tool) => tool.name === "ssh_bash")?.inputSchema.properties ?? {}))
      .toEqual(["connection_id", "command", "cwd", "run_in_background", "wait_seconds"]);
    expect(Object.keys(listing.tools.find((tool) => tool.name === "ssh_task_stop")?.inputSchema.properties ?? {}))
      .toEqual(["task_id"]);
    for (const name of ["ssh_discover", "ssh_sessions"]) {
      expect(listing.tools.find((tool) => tool.name === name)?.inputSchema.properties).toEqual({});
    }
    expect(Object.keys(listing.tools.find((tool) => tool.name === "ssh_close")?.inputSchema.properties ?? {})).toEqual(["connection_id"]);
    expect(listing.tools.find((tool) => tool.name === "ssh_close")?.annotations?.destructiveHint).toBe(true);
    for (const tool of listing.tools.filter((tool) => !["ssh_discover", "ssh_connect", "ssh_sessions", "ssh_task_output", "ssh_task_stop", "ssh_task_list"].includes(tool.name))) {
      expect(tool.inputSchema.required).toContain("connection_id");
      expect(tool.inputSchema.properties).not.toHaveProperty("target");
    }
    expect(listing.tools.find((tool) => tool.name === "ssh_read_file")?.annotations?.readOnlyHint).toBe(true);
    const properties = (name: string) => Object.keys(listing.tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {});
    expect(properties("ssh_read_file")).toEqual(["connection_id", "file_path", "offset", "limit"]);
    expect(properties("ssh_write_file")).toEqual(["connection_id", "file_path", "content"]);
    expect(properties("ssh_edit_file")).toEqual(["connection_id", "file_path", "old_string", "new_string", "replace_all"]);
    expect(properties("ssh_task_list")).toEqual(["connection_id"]);
    // Some model providers reject the JSON Schema `pattern` keyword with a 400.
    for (const tool of listing.tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('"pattern"');
    }
    expect(properties("ssh_upload")).not.toContain("parents");
    const result = await call("ssh_discover");
    expect(result).toEqual({ servers: ["fixture", "missing-python", "slow", "slow-cancel", "untrusted"].map((host) => ({ host })) });
    expect(JSON.stringify(result)).not.toContain("IdentityFile");
    expect(await call("ssh_sessions")).toEqual({ sessions: [] });
    expect(fixture.authentications).toBe(0);
    expect((await call("ssh_read_file", { connection_id: "00000000", file_path: "/" }, true)).error.code).toBe("CONNECTION_NOT_FOUND");
  });

  test("reuses one authenticated SSH connection across concurrent file calls", async () => {
    const before = fixture.authentications;
    const results = await Promise.all(Array.from({ length: 12 }, () => call("ssh_connect", { host: "fixture" })));
    dev = results[0].connection_id;
    expect(dev).toMatch(/^[a-f0-9]{8}$/);
    expect(results.every((value) => value.connection_id === dev && Object.keys(value).length === 1)).toBe(true);
    expect(fixture.authentications - before).toBe(1);
    expect(fixture.workerStarts).toBe(1);
    expect(await sessionSummary(dev)).toEqual({ connection_id: dev, host: "fixture", user: "fixture", port: fixture.port });
  }, 15000);

  test("refuses untrusted host keys and diagnoses a missing remote interpreter", async () => {
    expect((await call("ssh_connect", { host: "untrusted" }, true)).error.code).toBe("SSH_HOST_KEY_ERROR");
    expect((await call("ssh_connect", { host: "missing-python" }, true)).error.code).toBe("RUNTIME_UNSUPPORTED");
  });

  test("rejects unrecognized tool fields instead of accepting arbitrary SSH options", async () => {
    const response = await client.callTool({ name: "ssh_connect", arguments: { host: "fixture", sshOptions: ["-oStrictHostKeyChecking=no"] } });
    expect(response.isError).toBe(true);
    for (const args of [{ query: "fixture" }, { limit: 1 }, { cursor: "unused" }]) {
      const response = await client.callTool({ name: "ssh_discover", arguments: args });
      expect(response.isError).toBe(true);
    }
    for (const args of [{ connection_id: dev }, { check_alive: true }, { limit: 1 }, { cursor: "unused" }]) {
      const response = await client.callTool({ name: "ssh_sessions", arguments: args });
      expect(response.isError).toBe(true);
    }
    for (const options of [{ on_busy: "cancel" }, { timeout_seconds: 1 }]) {
      const response = await client.callTool({ name: "ssh_close", arguments: { connection_id: dev, ...options } });
      expect(response.isError).toBe(true);
    }
  });

  test("direct connections accept unlisted addresses and preserve explicit account/port overrides", async () => {
    const connection = await call("ssh_connect", { host: "127.0.0.1", user: "direct-user", port: fixture.port });
    expect(connection.connection_id).not.toBe(dev);
    expect(await sessionSummary(connection.connection_id)).toMatchObject({ host: "127.0.0.1", user: "direct-user", port: fixture.port });
    expect(await taskCall("ssh_bash", { connection_id: connection.connection_id, command: "pwd" })).toBe(fixture.workspace + "\n");
    expect((await call("ssh_close", connection)).remote_cleanup).toBe("confirmed");
  });

  test("one caller timing out does not abort another caller's shared worker startup", async () => {
    const before = fixture.authentications;
    const short = call("ssh_connect", { host: "slow", timeout_seconds: 1 }, true);
    const longer = call("ssh_connect", { host: "slow", timeout_seconds: 5 });
    expect((await short).error.code).toBe("CONNECT_TIMEOUT");
    const connection = await longer;
    expect(fixture.authentications - before).toBe(1);
    expect((await sessionSummary(connection.connection_id)).connection_id).toBe(connection.connection_id);
    await call("ssh_close", connection);
  }, 8000);

  test("a timed-out final caller retires its pending worker and publishes no handle", async () => {
    const runtime = new Runtime(fixture.config);
    try {
      await expect(runtime.ssh.connect({ host: "slow-cancel" }, 1)).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
      expect((await runtime.ssh.sessions()).sessions).toEqual([]);
    } finally { await runtime.close(); }
  }, 8000);

  test("the same policy filters discovery and denies direct target/identity overrides before authentication", async () => {
    const before = fixture.authentications;
    const runtime = new Runtime({ ...fixture.config, access: { allow: [{ host: "fixture", user: "fixture" }], deny: [{ host: "untrusted" }] } });
    try {
      expect((await runtime.discovery.discover()).servers).toEqual([{ host: "fixture" }]);
      await expect(runtime.ssh.connect({ host: "untrusted" })).rejects.toMatchObject({ code: "TARGET_DENIED" });
      await expect(runtime.ssh.connect({ host: "fixture", user: "root" })).rejects.toMatchObject({ code: "TARGET_DENIED" });
      await expect(runtime.ssh.connect({ host: "127.0.0.1", user: "fixture", port: fixture.port })).rejects.toMatchObject({ code: "TARGET_DENIED" });
      expect(fixture.authentications).toBe(before);
    } finally { await runtime.close(); }
  });

  test("lists only available connections without opening or changing connections", async () => {
    const before = fixture.authentications;
    const result = await call("ssh_sessions");
    expect(result).toEqual({ sessions: [{ connection_id: dev, host: "fixture", user: "fixture", port: fixture.port }] });
    expect(await call("ssh_sessions")).toEqual(result);
    expect(fixture.authentications).toBe(before);
  });
});

describe("remote files", () => {
  test("concurrent file requests retain one SSH worker", async () => {
    const before = fixture.workerStarts;
    const directories = [join(fixture.workspace, "parallel-a"), join(fixture.workspace, "parallel-b")];
    await Promise.all(directories.map((directory) => mkdir(directory)));
    await Promise.all(Array.from({ length: 12 }, (_, index) => call("ssh_write_file", {
      connection_id: dev, file_path: join(directories[index % 2]!, `file-${index}.txt`), content: String(index),
    })));
    for (let index = 0; index < 12; index++) {
      expect(await readFile(join(directories[index % 2]!, `file-${index}.txt`), "utf8")).toBe(String(index));
    }
    expect(fixture.workerStarts).toBe(before);
  });

  test("treats quotes, command substitutions, Unicode, and newlines in paths as data", async () => {
    const filename = "odd ' $(touch SHOULD_NOT_EXIST) 😀\nname.txt";
    const path = join(fixture.workspace, filename);
    const value = await call("ssh_write_file", { connection_id: dev, file_path: path, content: "hello\r\n世界\r\n" });
    const read = await call("ssh_read_file", { connection_id: dev, file_path: path, limit: 1 });
    expect(read.content).toBe("hello\r\n");
    expect(read.sha256).toBe(value.sha256);
    expect(read.nextLine).toBe(2);
    expect((await call("ssh_read_file", { connection_id: dev, file_path: path, offset: 2 })).content).toBe("世界\r\n");
    expect(await readdir(fixture.workspace)).not.toContain("SHOULD_NOT_EXIST");
  });

  test("applies exact edits atomically and requires a fresh read for stale or ambiguous edits", async () => {
    const created = await call("ssh_write_file", { connection_id: dev, file_path: "edit.txt", content: "one\r\ntwo two\r\n" });
    await chmod(join(fixture.workspace, "edit.txt"), 0o751);

    const ambiguous = await call("ssh_edit_file", {
      connection_id: dev, file_path: "edit.txt", old_string: "two", new_string: "second",
    }, true);
    expect(ambiguous.error.message).toContain("exactly one occurrence");
    expect(await readFile(join(fixture.workspace, "edit.txt"), "utf8")).toBe("one\r\ntwo two\r\n");

    const first = await call("ssh_edit_file", {
      connection_id: dev, file_path: "edit.txt", old_string: "one", new_string: "first",
    });
    expect(first.sha256).not.toBe(created.sha256);
    const second = await call("ssh_edit_file", {
      connection_id: dev, file_path: "edit.txt", old_string: "two", new_string: "second", replace_all: true,
    });
    expect(second.sha256).not.toBe(first.sha256);
    expect((await lstat(join(fixture.workspace, "edit.txt"))).mode & 0o777).toBe(0o751);
    expect(await readFile(join(fixture.workspace, "edit.txt"), "utf8")).toBe("first\r\nsecond second\r\n");

    await writeFile(join(fixture.workspace, "edit.txt"), "changed\r\n");
    const stale = await call("ssh_edit_file", {
      connection_id: dev, file_path: "edit.txt", old_string: "changed", new_string: "again",
    }, true);
    expect(stale.error.message).toContain("conflict");

    await taskCall("ssh_bash", { connection_id: dev, command: "printf 'outside\\n' > outside.txt" });
    const unread = await call("ssh_edit_file", {
      connection_id: dev, file_path: "outside.txt", old_string: "outside", new_string: "inside",
    }, true);
    expect(unread.error.code).toBe("FILE_NOT_READ");
    await call("ssh_read_file", { connection_id: dev, file_path: "outside.txt" });
    await call("ssh_edit_file", { connection_id: dev, file_path: "outside.txt", old_string: "outside", new_string: "inside" });
    expect(await readFile(join(fixture.workspace, "outside.txt"), "utf8")).toBe("inside\n");

    await taskCall("ssh_bash", { connection_id: dev, command: "printf 'guard\\n' > guard.txt" });
    const unreadWrite = await call("ssh_write_file", { connection_id: dev, file_path: "guard.txt", content: "replaced" }, true);
    expect(unreadWrite.error.message).toContain("read it with ssh_read_file first");
    await call("ssh_read_file", { connection_id: dev, file_path: "guard.txt" });
    await call("ssh_write_file", { connection_id: dev, file_path: "guard.txt", content: "replaced" });
    expect(await readFile(join(fixture.workspace, "guard.txt"), "utf8")).toBe("replaced");
  });

  test("fresh revisions remain usable across relative, absolute, and home-relative paths", async () => {
    const path = join(fixture.workspace, "revision-alias.txt");
    await writeFile(path, "original");
    await call("ssh_read_file", { connection_id: dev, file_path: "revision-alias.txt" });

    // A fresh absolute read must also refresh an earlier relative spelling.
    await writeFile(path, "external update");
    await call("ssh_read_file", { connection_id: dev, file_path: path });
    await call("ssh_edit_file", {
      connection_id: dev, file_path: "revision-alias.txt", old_string: "external update", new_string: "relative edit",
    });

    // Each later mutation refreshes every spelling already associated with this file.
    await call("ssh_write_file", { connection_id: dev, file_path: path, content: "absolute write" });
    await call("ssh_read_file", { connection_id: dev, file_path: "~/revision-alias.txt" });
    await call("ssh_edit_file", {
      connection_id: dev, file_path: "revision-alias.txt", old_string: "absolute write", new_string: "final edit",
    });
    expect(await readFile(path, "utf8")).toBe("final edit");
  });

  test("large file responses cross worker protocol chunks", async () => {
    const content = "x".repeat(200000);
    const written = await call("ssh_write_file", { connection_id: dev, file_path: "large.txt", content });
    expect(written.bytesWritten).toBe(200000);
    const read = await call("ssh_read_file", { connection_id: dev, file_path: "large.txt", limit: 2000 });
    expect(read.totalLines).toBe(1);
    expect(read.content).toBe(content);
    expect(read.sha256).toBe(written.sha256);
    const downloaded = await call("ssh_download", {
      connection_id: dev, remotePath: "large.txt", localPath: join(fixture.transfers, "large.txt"),
    });
    expect(downloaded.size).toBe(200000);
    expect(await readFile(downloaded.localPath, "utf8")).toBe(content);
  });

  test("preserves symlinks and rejects binary and oversized text reads", async () => {
    await symlink("edit.txt", join(fixture.workspace, "link.txt"));
    expect(await taskCall("ssh_bash", { connection_id: dev, command: "test -L link.txt && printf symlink" })).toBe("symlink");
    await call("ssh_read_file", { connection_id: dev, file_path: "link.txt" });
    await call("ssh_write_file", { connection_id: dev, file_path: "link.txt", content: "via link" });
    expect((await lstat(join(fixture.workspace, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(fixture.workspace, "edit.txt"), "utf8")).toBe("via link");
    await writeFile(join(fixture.workspace, "binary"), Buffer.from([0, 1, 255]));
    expect((await call("ssh_read_file", { connection_id: dev, file_path: "binary" }, true)).error.message).toContain("Binary");
    await writeFile(join(fixture.workspace, "huge.txt"), Buffer.alloc(fixture.config.maxFileBytes + 1, 65));
    expect((await call("ssh_read_file", { connection_id: dev, file_path: "huge.txt" }, true)).error.message).toContain("maxFileBytes");
    expect((await call("ssh_read_file", {
      connection_id: dev, file_path: join(fixture.workspace, "nested", "edit.txt"),
    }, true)).error.message).toContain("FileNotFoundError");
  });
});

describe("binary transfer boundary", () => {
  test("round-trips binary bytes, verifies SHA-256, and refuses implicit overwrite", async () => {
    const data = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
    const localPath = join(fixture.transfers, "source.bin");
    await writeFile(localPath, data);
    const uploaded = await call("ssh_upload", { connection_id: dev, localPath, remotePath: "transfer/data.bin" });
    const downloaded = await call("ssh_download", { connection_id: dev, remotePath: "transfer/data.bin", localPath: join(fixture.transfers, "nested", "download.bin") });
    expect(downloaded.sha256).toBe(uploaded.sha256);
    expect(await readFile(downloaded.localPath)).toEqual(data);
    await call("ssh_upload", { connection_id: dev, localPath, remotePath: "transfer/data.bin" }, true);
    await call("ssh_download", { connection_id: dev, remotePath: "binary", localPath: downloaded.localPath }, true);
  });

  test("SFTP transfers paths containing spaces and glob characters", async () => {
    const data = Buffer.from(Array.from({ length: 128 }, (_, value) => value));
    const local = join(fixture.transfers, "space file [1].bin");
    await writeFile(local, data);
    const remote = "transfer/space file [1].bin";
    const uploaded = await call("ssh_upload", { connection_id: dev, localPath: local, remotePath: remote });
    const downloaded = await call("ssh_download", {
      connection_id: dev, remotePath: remote, localPath: join(fixture.transfers, "space out [1].bin"),
    });
    expect(downloaded.sha256).toBe(uploaded.sha256);
    expect(await readFile(downloaded.localPath)).toEqual(data);
  });

  test("rejects paths and symlinks that leave explicitly enabled local transfer roots", async () => {
    await call("ssh_upload", { connection_id: dev, localPath: fixture.configPath, remotePath: "leaked" }, true);
    await call("ssh_download", { connection_id: dev, remotePath: "binary", localPath: join(fixture.root, "outside") }, true);
    await symlink(fixture.configPath, join(fixture.transfers, "escape"));
    await call("ssh_upload", { connection_id: dev, localPath: join(fixture.transfers, "escape"), remotePath: "leaked" }, true);
    await call("ssh_download", { connection_id: dev, remotePath: "binary", localPath: join(fixture.transfers, "escape"), overwrite: true }, true);
    await symlink(fixture.root, join(fixture.transfers, "parent-escape"));
    await call("ssh_download", { connection_id: dev, remotePath: "binary", localPath: join(fixture.transfers, "parent-escape", "outside") }, true);
    expect(await readdir(fixture.workspace)).not.toContain("leaked");
  });
});

describe("Bash tasks and archives", () => {
  test("short commands return raw multiline text and archive exact bytes", async () => {
    const command = "printf 'ready\\n  indented\\n'; printf 'warning\\n' >&2";
    const text = await taskCall("ssh_bash", { connection_id: dev, command, wait_seconds: 300 });
    expect(text).toBe("ready\n  indented\n\nstderr:\nwarning\n");
    const path = await newestLog(dev);
    const log = await readFile(path);
    const metadata = JSON.parse(await readFile(path.replace(".log", ".meta.json"), "utf8"));
    expect(metadata.command).toBe(command);
    expect(log.subarray(0, metadata.output_offset).toString()).toBe(`Command:\n${command}\n\nOutput:\n`);
    expect(log.length).toBe(metadata.output_offset + 25);
    expect(log.subarray(metadata.output_offset).length).toBe(25);
  });

  test("multiline commands retain their exact source while inline output stays separate", async () => {
    const command = "printf '%s\\n' '中文 $literal'\n# preserve trailing whitespace  \n";
    const text = await taskCall("ssh_bash", { connection_id: dev, command });
    const path = await newestLog(dev);
    const metadata = JSON.parse(await readFile(path.replace(".log", ".meta.json"), "utf8"));
    const log = await readFile(path);
    expect(metadata.command).toBe(command);
    expect(log.subarray(0, metadata.output_offset).toString()).toBe(`Command:\n${command}\n\nOutput:\n`);
    expect(metadata.file_bytes).toBe(log.length);
    expect(log.subarray(metadata.output_offset).toString()).toBe("中文 $literal\n");
    expect(text).toBe("中文 $literal\n");
    expect(text).not.toContain("preserve trailing whitespace");
  });

  test("wait expiry yields without terminating the command and queries wait for completion", async () => {
    const text = await taskCall("ssh_bash", {
      connection_id: dev, command: "printf begin; sleep 0.3; printf done", wait_seconds: 0.05,
    });
    expect(text).toContain("(running in background)");
    expect(text).toContain("still growing");
    const complete = await taskCall("ssh_task_output", { ...taskScope(text), wait_seconds: 300 });
    expect(complete).toContain("(completed)");
    expect(complete).toContain("stdout:\nbegindone");
    expect(await taskCall("ssh_task_output", { ...taskScope(text), wait_seconds: 0 })).toBe(complete);
    const fractional = await taskCall("ssh_bash", {
      connection_id: dev, command: "sleep 0.1; printf completed", wait_seconds: 0.5,
    });
    expect(fractional).toBe("completed");
  });

  test("explicit background returns after startup even when a long foreground wait was supplied", async () => {
    const text = await taskCall("ssh_bash", {
      connection_id: dev, command: "sleep 20", run_in_background: true, wait_seconds: 300,
    });
    expect(text).toContain("(running in background)");
    expect(await taskCall("ssh_task_stop", taskScope(text))).toContain("(stopped)");
  });

  test("uses real Bash, EOF stdin, independent cwd, and independent environment", async () => {
    await mkdir(join(fixture.workspace, "nested"));
    const first = await taskCall("ssh_bash", {
      connection_id: dev, cwd: join(fixture.workspace, "nested"),
      command: 'values=(one two); [[ ${values[1]} == two ]] || exit 7; export NEVERSSH_VALUE=first; printf "%s:%s\\n" "$PWD" "$NEVERSSH_VALUE"; cd /',
    });
    expect(first).toContain(join(fixture.workspace, "nested") + ":first\n");
    const second = await taskCall("ssh_bash", {
      connection_id: dev, command: 'read value || printf EOF; printf ":%s:%s" "$PWD" "${NEVERSSH_VALUE-unset}"',
    });
    expect(second).toContain("EOF:" + fixture.workspace + ":unset");
  });

  test("validates task handles and reports operational failures as text", async () => {
    const absentQuery = await taskCall("ssh_task_output", { task_id: "task_00000000", wait_seconds: 0 }, true);
    expect(absentQuery).toContain("Error: TASK_NOT_FOUND");
    const absentStop = await taskCall("ssh_task_stop", { task_id: "task_00000000" }, true);
    expect(absentStop).toContain("Error: TASK_NOT_FOUND");
    const invalid = await client.callTool({ name: "ssh_task_stop", arguments: { task_id: dev } });
    expect(invalid.isError).toBe(true);
    const badCwd = await taskCall("ssh_bash", {
      connection_id: dev, cwd: join(fixture.workspace, "absent-directory"), command: "true",
    }, true);
    expect(badCwd).toContain("Error:");
    expect(badCwd).toContain("No such file");
    const failed = await taskCall("ssh_bash", { connection_id: dev, command: "printf failed; exit 7" }, true);
    expect(failed).toContain("Exit code: 7");
    expect(await taskCall("ssh_task_output", { ...taskScope(failed), wait_seconds: 0 })).toContain("Exit code: 7");
  });

  test("lists active and retained tasks, active first", async () => {
    const running = await taskCall("ssh_bash", {
      connection_id: dev, command: "sleep 20", run_in_background: true,
    });
    const id = taskScope(running).task_id;
    const active = await taskCall("ssh_task_list", { connection_id: dev });
    expect(active).toMatch(new RegExp(`^${id}  running  ${dev}  `, "m"));
    await taskCall("ssh_task_stop", { task_id: id });
    const stopped = await taskCall("ssh_task_list", { connection_id: dev });
    expect(stopped).toMatch(new RegExp(`^${id}  stopped  ${dev}  `, "m"));
    expect(await taskCall("ssh_task_list", {})).toContain(id);
    await taskCall("ssh_task_output", { task_id: id, wait_seconds: 0 });
    expect(await taskCall("ssh_task_list", { connection_id: dev })).not.toContain(id);
    expect(await taskCall("ssh_task_list", { connection_id: "00000000" })).toBe("No tasks.");
  });

  test("missing Bash is a clear startup error instead of a silent shell fallback", async () => {
    const connection = await call("ssh_connect", { host: "fixture", user: "missing-bash" });
    try {
      expect(await taskCall("ssh_bash", { connection_id: connection.connection_id, command: "true" }, true))
        .toContain("Error: BASH_UNAVAILABLE");
    } finally { await call("ssh_close", connection); }
  });

  test("archive ID collisions preserve history and never replay a started command", async () => {
    const historicalId = "f00dbabe";
    const historicalDirectory = join(fixture.workspace, ".neverssh", "sessions", historicalId);
    await mkdir(historicalDirectory, { mode: 0o700 });
    const oldLog = join(historicalDirectory, "task_f00dbabe.log");
    await writeFile(oldLog, "historical session", { mode: 0o600 });
    const runtime = new Runtime(fixture.config);
    const originalNext = ShortIds.prototype.next;
    let connectionCollision = true;
    let mock = spyOn(ShortIds.prototype, "next").mockImplementation(function (this: ShortIds) {
      if (connectionCollision) { connectionCollision = false; return historicalId; }
      return originalNext.call(this);
    });
    try {
      const connection = await runtime.ssh.connect({ host: "fixture" });
      mock.mockRestore();
      const id = connection.connection_id as string;
      expect(id).not.toBe(historicalId);
      expect(await readFile(oldLog, "utf8")).toBe("historical session");

      const collisionPath = join(fixture.workspace, ".neverssh", "sessions", id, "task_deadbeef.log");
      await writeFile(collisionPath, "historical task", { mode: 0o600 });
      let taskCollision = true;
      mock = spyOn(ShortIds.prototype, "next").mockImplementation(function (this: ShortIds) {
        if (taskCollision) { taskCollision = false; return "deadbeef"; }
        return originalNext.call(this);
      });
      const result = await runtime.tasks.execute(id, "printf x >> collision-runs; printf ready", undefined, 2000);
      expect(result.task_id).not.toBe("task_deadbeef");
      expect(result).toMatchObject({ finished: true, exit_code: 0 });
      expect(await readFile(collisionPath, "utf8")).toBe("historical task");
      expect(await readFile(join(fixture.workspace, "collision-runs"), "utf8")).toBe("x");
    } finally {
      mock.mockRestore();
      await runtime.close();
    }
  }, 10000);

  test("split UTF-8 and large output are archived fully while inline previews stay bounded", async () => {
    const split = await taskCall("ssh_bash", {
      connection_id: dev, command: "python3 -c 'import os,time; os.write(1, bytes([228])); time.sleep(.1); os.write(1, bytes([184,150,231,149,140]))'",
    });
    expect(split).toBe("世界");
    const splitPath = await newestLog(dev);
    const splitMetadata = JSON.parse(await readFile(splitPath.replace(".log", ".meta.json"), "utf8"));
    expect((await readFile(splitPath)).subarray(splitMetadata.output_offset).toString()).toBe("世界");
    const largeCommand = 'python3 -c \'import sys; sys.stdout.write("x" * 2097152)\'';
    const large = await taskCall("ssh_bash", { connection_id: dev, command: largeCommand });
    const logBytes = 2097152 + Buffer.byteLength(`Command:\n${largeCommand}\n\nOutput:\n`);
    expect(large).toContain(`${logBytes} bytes`);
    expect(large).toContain("read selectively");
    expect(large.length).toBeLessThan(70000);
    expect((await lstat(logPath(large))).size).toBe(logBytes);
    expect((await lstat(logPath(large))).mode & 0o777).toBe(0o600);
    const readTail = await taskCall("ssh_bash", { connection_id: dev, command: "tail -c 16 '" + logPath(large) + "'" });
    expect(readTail).toBe("x".repeat(16));
  }, 15000);

  test("configured output limits stop commands without silently dropping or evicting retained logs", async () => {
    const runtime = new Runtime({ ...fixture.config, maxTaskOutputBytes: 1024 });
    try {
      const connection = await runtime.ssh.connect({ host: "fixture" });
      const result = await runtime.tasks.execute(connection.connection_id as string,
        'python3 -c \'import sys; sys.stdout.write("x" * 10000)\'', undefined, 4000);
      expect(result).toMatchObject({ finished: true, reason: "output_limit", output_bytes: 1024, output_complete: false });
      expect((await readFile(result.output_file)).length).toBe(1024);
      const metadata = JSON.parse(await readFile(result.output_file.replace(".log", ".meta.json"), "utf8"));
      expect(metadata.output_complete).toBe(false);
      expect(metadata.file_bytes).toBe(1024);
      expect(metadata.output_bytes + metadata.output_offset).toBe(metadata.file_bytes);
      expect(Date.parse(metadata.expires_at) - Date.parse(metadata.finished_at)).toBe(14 * 86400 * 1000);
    } finally { await runtime.close(); }
  }, 10000);

  test("stop escalates for TERM-resistant shells, includes normal descendants, and is repeatable", async () => {
    const running = await taskCall("ssh_bash", {
      connection_id: dev, command: "trap '' TERM; (sleep 3; touch cancel-leak) & printf ready; wait", wait_seconds: 0.25,
    });
    expect(running).toContain("ready");
    const stopped = await taskCall("ssh_task_stop", taskScope(running));
    expect(stopped).toContain("(stopped)");
    expect(stopped).toContain("Reason: cancelled");
    expect(await taskCall("ssh_task_stop", taskScope(running))).toBe(stopped);
    await delay(1100);
    expect(await readdir(fixture.workspace)).not.toContain("cancel-leak");
    expect(await logOutput(stopped)).toBe("ready");
  }, 10000);

  test("network loss retains known output without inventing an exit code or replaying the command", async () => {
    const running = await taskCall("ssh_bash", {
      connection_id: dev, command: "printf x >> attempts; printf before; (sleep 2; touch disconnect-leak) & wait", wait_seconds: 0.1,
    });
    fixture.dropConnections();
    const lost = await taskCall("ssh_task_output", { ...taskScope(running), wait_seconds: 3 });
    expect(lost).toContain("Reason: connection_lost");
    expect(lost).toContain("Exit code: unknown");
    expect(lost).toContain("Last confirmed output size:");
    expect(await readFile(join(fixture.workspace, "attempts"), "utf8")).toBe("x");
    expect((await call("ssh_read_file", { connection_id: dev, file_path: "attempts" }, true)).error.code).toBe("CONNECTION_LOST");
    const previous = dev;
    await call("ssh_close", { connection_id: previous });
    dev = (await call("ssh_connect", { host: "fixture" })).connection_id;
    expect(dev).not.toBe(previous);
    await delay(2100);
    expect(await readdir(fixture.workspace)).not.toContain("disconnect-leak");
    expect(await logOutput(running)).toBe("before");
  });

  test("force close cleans up children, retains logs, and a new connection can read old paths", async () => {
    const running = await taskCall("ssh_bash", {
      connection_id: dev, command: "trap '' TERM; (sleep 3; touch close-leak) & printf ready; wait", wait_seconds: 0.25,
    });
    const closed = await call("ssh_close", { connection_id: dev });
    expect(closed.remote_cleanup).toBe("confirmed");
    expect(await call("ssh_close", { connection_id: dev })).toEqual(closed);
    const stopped = await taskCall("ssh_task_output", { ...taskScope(running), wait_seconds: 0 });
    expect(stopped).toContain("Reason: connection_closed");
    expect(await logOutput(running)).toBe("ready");
    const previous = dev;
    dev = (await call("ssh_connect", { host: "fixture" })).connection_id;
    expect(dev).not.toBe(previous);
    const oldLog = await call("ssh_read_file", { connection_id: dev, file_path: logPath(running) });
    expect(oldLog.content).toContain("Command:\ntrap '' TERM;");
    expect(oldLog.content).toEndWith("\n\nOutput:\nready");
    await delay(1100);
    expect(await readdir(fixture.workspace)).not.toContain("close-leak");
  }, 10000);

  test("four active tasks leave file operations available and concurrent close shares cleanup", async () => {
    const running = await Promise.all(Array.from({ length: 4 }, () => taskCall("ssh_bash", {
      connection_id: dev, command: "sleep 20", run_in_background: true,
    })));
    const full = await taskCall("ssh_bash", { connection_id: dev, command: "true" }, true);
    expect(full).toContain("Error: TASK_LIMIT_REACHED");
    expect((await call("ssh_read_file", { connection_id: dev, file_path: "edit.txt" })).path).toContain("edit.txt");
    const [first, second] = await Promise.all([call("ssh_close", { connection_id: dev }), call("ssh_close", { connection_id: dev })]);
    expect(first).toEqual({ connection_id: dev, closed: true, remote_cleanup: "confirmed" });
    expect(second).toEqual(first);
    for (const text of running) {
      expect(await taskCall("ssh_task_output", { ...taskScope(text), wait_seconds: 0 })).toContain("Reason: connection_closed");
    }
    dev = (await call("ssh_connect", { host: "fixture" })).connection_id;
  });

  test("installs and reuses the versioned remote build cache", async () => {
    const build = join(fixture.workspace, ".neverssh", "builds", BUILD_ID);
    const manifest = JSON.parse(await readFile(join(build, "manifest.json"), "utf8"));
    expect(manifest.build_id).toBe(BUILD_ID);
    expect(manifest.protocol).toBe(1);
    for (const name of ["worker.py", "file_ops.py", "helper.py", "archive.py", "build_cache.py"]) {
      expect((await lstat(join(build, name))).isFile()).toBe(true);
    }
    const before = (await lstat(join(build, "worker.py"))).mtimeMs;
    const runtime = new Runtime(fixture.config);
    try {
      expect((await runtime.ssh.connect({ host: "fixture" })).connection_id).toBeDefined();
    } finally { await runtime.close(); }
    expect((await lstat(join(build, "worker.py"))).mtimeMs).toBe(before);
  });

  test("probe runs inside the persistent worker", async () => {
    const runtime = new Runtime(fixture.config);
    try {
      const connection = await runtime.ssh.connect({ host: "fixture" });
      const result = await runtime.ssh.run(connection.connection_id as string, "probe");
      expect(result).toMatchObject({
        home: fixture.workspace, platform: expect.any(String), pythonVersion: expect.any(String),
      });
    } finally { await runtime.close(); }
  });

  test("MCP stdio closure stops owned processes while preserving logs and metadata", async () => {
    const running = await taskCall("ssh_bash", {
      connection_id: dev, command: "printf retained; (sleep 3; touch eof-leak) & wait", wait_seconds: 0.1,
    });
    await client.close();
    const deadline = Date.now() + 5000;
    while ((fixture.commands.size || fixture.connections.size) && Date.now() < deadline) await delay(50);
    expect(fixture.commands.size).toBe(0);
    expect(fixture.connections.size).toBe(0);
    await delay(3100);
    expect(await readdir(fixture.workspace)).not.toContain("eof-leak");
    expect(await logOutput(running)).toBe("retained");
    const metadataPath = logPath(running).replace(".log", ".meta.json");
    const metadataDeadline = Date.now() + 8000;
    let metadata: Record<string, unknown> = {};
    while (Date.now() < metadataDeadline) {
      try {
        metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        if (metadata.finished_at) break;
      } catch { /* the atomic metadata replace may still be in flight */ }
      await delay(50);
    }
    expect(metadata).toHaveProperty("finished_at");
  }, 12000);
});

/** Clients whose stdio transport subclasses the SDK's (Claude Code's does) probe the protocol era
 * on the connection itself instead of on a throwaway sibling process. */
class InPlaceTransport extends StdioClientTransport {}

describe("MCP era negotiation", () => {
  test("a legacy handshake after the server/discover probe leaves the connection usable", async () => {
    const transport = new InPlaceTransport({
      command: process.execPath, args: ["run", resolve(process.env.NEVERSSH_TEST_ENTRYPOINT ?? "src/index.ts"), "--config", fixture.configPath],
      env: { ...process.env } as Record<string, string>, stderr: "pipe",
    });
    let negotiationStderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { negotiationStderr = (negotiationStderr + chunk.toString()).slice(-4096); });
    // A 1ms probe bound expires long before this server answers, so the client probes with
    // server/discover and then keeps the 2025-era handshake on the same process: the server
    // discards its probe instance, which must not take the connection's runtime down with it.
    const client = new Client({ name: "neverssh-negotiation-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: 1 } } });
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe("legacy");
      const connection = await client.callTool({ name: "ssh_connect", arguments: { host: "fixture" } });
      expect(connection.isError, JSON.stringify(connection.content)).toBeFalsy();
      expect(connection.structuredContent).toMatchObject({ connection_id: expect.any(String) });
    } finally { await client.close(); }
    expect(negotiationStderr).not.toContain("SyntaxError");
  }, 20000);
});

describe("MCP wire lifecycle", () => {
  test("stdout EPIPE closes the runtime even while the client keeps stdin open", async () => {
    const epipeFixture = new SshFixture();
    try {
      await epipeFixture.start();
      const child = spawn(process.execPath, [
        "run", resolve(process.env.NEVERSSH_TEST_ENTRYPOINT ?? "src/index.ts"), "--config", epipeFixture.configPath,
      ], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const reader = createInterface({ input: child.stdout });
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
      let sequence = 0;
      let diagnostic = "";
      reader.on("line", (line) => {
        const message = JSON.parse(line);
        pending.get(message.id)?.resolve(message);
      });
      child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
      child.stdin.on("error", () => {});
      child.once("exit", () => {
        for (const request of pending.values()) request.reject(new Error(`Server exited: ${diagnostic}`));
      });

      /** Use raw pipes so the test can close stdout without also ending the client's stdin. */
      const rpc = (method: string, params: Record<string, unknown>): Promise<any> => {
        const id = ++sequence;
        let timer: ReturnType<typeof setTimeout>;
        return new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out awaiting ${method}: ${diagnostic}`)), 5000);
          pending.set(id, { resolve, reject });
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        }).finally(() => {
          clearTimeout(timer);
          pending.delete(id);
        });
      };

      try {
        await rpc("initialize", {
          protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "neverssh-epipe-test", version: "1" },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const connection = await rpc("tools/call", { name: "ssh_connect", arguments: { host: "fixture" } });
        expect(connection.result.isError).toBeFalsy();
        const started = await rpc("tools/call", {
          name: "ssh_bash", arguments: {
            connection_id: connection.result.structuredContent.connection_id,
            command: "printf retained; (sleep 3; touch epipe-leak) & wait", run_in_background: true,
          },
        });
        expect(started.result.isError).toBeFalsy();
        const running = started.result.content.map((item: { text: string }) => item.text).join("\n");

        // The next response hits EPIPE; stdin deliberately remains open throughout cleanup.
        child.stdout.destroy();
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/list", params: {} }) + "\n");
        const deadline = Date.now() + 5000;
        while ((child.exitCode === null || epipeFixture.commands.size || epipeFixture.connections.size) && Date.now() < deadline) {
          await delay(50);
        }
        expect(diagnostic).toContain("EPIPE");
        expect(child.exitCode, diagnostic).toBe(0);
        expect(epipeFixture.commands.size).toBe(0);
        expect(epipeFixture.connections.size).toBe(0);
        expect(await logOutput(running)).toBe("retained");
        const metadata = JSON.parse(await readFile(logPath(running).replace(".log", ".meta.json"), "utf8"));
        expect(metadata).toHaveProperty("finished_at");
        await delay(3100);
        expect(await readdir(epipeFixture.workspace)).not.toContain("epipe-leak");
      } finally {
        reader.close();
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
      }
    } finally { await epipeFixture.close(); }
  }, 20000);
});

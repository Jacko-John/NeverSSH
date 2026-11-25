/** End-to-end MCP stdio -> OpenSSH -> persistent worker -> isolated remote operations. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { SshFixture } from "./fixture";
import { Runtime } from "../src/runtime";
import { ShortIds } from "../src/ids";
import { BUILD_ID, PROTOCOL_VERSION, SERVER_VERSION } from "../src/remote/bundle";

const fixture = new SshFixture();
let client: Client;
let transport: StdioClientTransport;
let stderr = "";
let dev = "";

/** Inspect text results as the model sees them, without a structured copy. */
async function call(name: string, args: Record<string, unknown> = {}, error = false): Promise<string> {
  const response = await client.callTool({ name, arguments: args }, { timeout: 660_000 });
  expect(response.structuredContent).toBeUndefined();
  expect(Boolean(response.isError), JSON.stringify(response.content).slice(0, 4096)).toBe(error);
  expect(response.content.length).toBeGreaterThan(0);
  expect(response.content.every((item) => item.type === "text")).toBe(true);
  return response.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

/** Extract only the connection handle needed by follow-up tool calls. */
function connectionId(text: string): string {
  const id = /^Connection: ([a-f0-9]{8})$/.exec(text)?.[1];
  if (!id) throw new Error("Missing connection handle: " + text.slice(0, 4096));
  return id;
}

/** Add a valid ancillary text chunk to a one-pixel PNG without inflating its decoded pixels. */
function paddedPng(size: number): Buffer {
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const chunk = Buffer.alloc(size - image.length, 65);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write("tEXt", 4);
  chunk.write("Comment\0", 8);
  chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([image.subarray(0, -12), chunk, image.subarray(-12)]);
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

/** Retain bounded wire evidence without changing the fixture's normal pipe consumers. */
function captureWorkers(source: SshFixture) {
  let workerRecords = "";
  let workerStderr = "";
  const workerExits: Array<{ pid: number | undefined; code: number | null; signal: NodeJS.Signals | null }> = [];
  for (const worker of source.commands) {
    worker.stdout.on("data", (chunk: Buffer) => { workerRecords = (workerRecords + chunk.toString()).slice(-32768); });
    worker.stderr.on("data", (chunk: Buffer) => { workerStderr = (workerStderr + chunk.toString()).slice(-8192); });
    worker.once("close", (code, signal) => { workerExits.push({ pid: worker.pid, code, signal }); });
  }
  return () => ({ workerRecords, workerStderr, workerExits });
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
    expect(listing.tools).toHaveLength(15);
    expect(listing.tools.some((tool) => tool.name === "ssh_disconnect")).toBe(false);
    for (const tool of listing.tools) expect(tool.outputSchema, tool.name).toBeUndefined();
    for (const name of ["ssh_exec", "ssh_poll", "ssh_input", "ssh_cancel", "ssh_jobs"]) {
      expect(listing.tools.some((tool) => tool.name === name)).toBe(false);
    }
    expect(Object.keys(listing.tools.find((tool) => tool.name === "ssh_bash")?.inputSchema.properties ?? {}))
      .toEqual(["connection_id", "workspace_id", "command", "cwd", "run_in_background", "wait_seconds"]);
    expect(Object.keys(listing.tools.find((tool) => tool.name === "ssh_task_output")?.inputSchema.properties ?? {}))
      .toEqual(["task_id", "wait_seconds"]);
    expect(Object.keys(listing.tools.find((tool) => tool.name === "ssh_task_stop")?.inputSchema.properties ?? {}))
      .toEqual(["task_id"]);
    for (const name of ["ssh_discover", "ssh_sessions"]) {
      expect(listing.tools.find((tool) => tool.name === name)?.inputSchema.properties).toEqual({});
    }
    expect(Object.keys(listing.tools.find((tool) => tool.name === "ssh_close")?.inputSchema.properties ?? {})).toEqual(["connection_id"]);
    expect(listing.tools.find((tool) => tool.name === "ssh_close")?.annotations?.destructiveHint).toBe(true);
    for (const name of ["ssh_close", "ssh_workspace_open"]) {
      expect(listing.tools.find((tool) => tool.name === name)?.inputSchema.required).toContain("connection_id");
    }
    for (const tool of listing.tools.filter((tool) => ["ssh_bash", "ssh_read_file", "ssh_write_file", "ssh_edit_file", "ssh_upload", "ssh_download"].includes(tool.name))) {
      expect(tool.inputSchema.properties).toHaveProperty("connection_id");
      expect(tool.inputSchema.properties).toHaveProperty("workspace_id");
      expect(tool.inputSchema.required ?? []).not.toContain("connection_id");
      expect(tool.inputSchema.properties).not.toHaveProperty("target");
    }
    expect(listing.tools.find((tool) => tool.name === "ssh_read_file")?.annotations?.readOnlyHint).toBe(true);
    const properties = (name: string) => Object.keys(listing.tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {});
    const fileScope = ["connection_id", "workspace_id", "workspace_rules_ack"];
    expect(properties("ssh_read_file")).toEqual([...fileScope, "file_path", "offset", "limit"]);
    expect(properties("ssh_write_file")).toEqual([...fileScope, "file_path", "content"]);
    expect(properties("ssh_edit_file")).toEqual([...fileScope, "file_path", "old_string", "new_string", "replace_all"]);
    expect(properties("ssh_task_list")).toEqual(["connection_id"]);
    // Some model providers reject the JSON Schema `pattern` keyword with a 400.
    for (const tool of listing.tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('"pattern"');
    }
    expect(properties("ssh_upload")).not.toContain("parents");
    const result = await call("ssh_discover");
    expect(result).toBe("fixture\nmissing-python\nslow\nslow-cancel\nuntrusted");
    expect(result).not.toContain("IdentityFile");
    expect(await call("ssh_sessions")).toBe("No active connections.");
    expect(fixture.authentications).toBe(0);
    expect(await call("ssh_read_file", { connection_id: "00000000", file_path: "/" }, true)).toStartWith("Error: CONNECTION_NOT_FOUND\n");
  });

  test("reuses one authenticated SSH connection across concurrent file calls", async () => {
    const before = fixture.authentications;
    const results = await Promise.all(Array.from({ length: 12 }, () => call("ssh_connect", { host: "fixture" })));
    dev = connectionId(results[0]!);
    expect(dev).toMatch(/^[a-f0-9]{8}$/);
    expect(results.every((value) => value === `Connection: ${dev}`)).toBe(true);
    expect(fixture.authentications - before).toBe(1);
    expect(fixture.workerStarts).toBe(1);
    expect(await call("ssh_sessions")).toBe(`${dev}  fixture@fixture:${fixture.port}`);
  }, 15000);

  test("refuses untrusted host keys and diagnoses a missing remote interpreter", async () => {
    expect(await call("ssh_connect", { host: "untrusted" }, true)).toStartWith("Error: SSH_HOST_KEY_ERROR\n");
    expect(await call("ssh_connect", { host: "missing-python" }, true)).toStartWith("Error: RUNTIME_UNSUPPORTED\n");
  });

  test("rejects unrecognized tool fields instead of accepting arbitrary SSH options", async () => {
    await call("ssh_connect", { host: "fixture", sshOptions: ["-oStrictHostKeyChecking=no"] }, true);
    for (const args of [{ query: "fixture" }, { limit: 1 }, { cursor: "unused" }]) {
      await call("ssh_discover", args, true);
    }
    for (const args of [{ connection_id: dev }, { check_alive: true }, { limit: 1 }, { cursor: "unused" }]) {
      await call("ssh_sessions", args, true);
    }
    for (const options of [{ on_busy: "cancel" }, { timeout_seconds: 1 }]) {
      await call("ssh_close", { connection_id: dev, ...options }, true);
    }
  });

  test("direct connections accept unlisted addresses and preserve explicit account/port overrides", async () => {
    const id = connectionId(await call("ssh_connect", { host: "127.0.0.1", user: "direct-user", port: fixture.port }));
    expect(id).not.toBe(dev);
    expect((await call("ssh_sessions")).split("\n")).toContain(`${id}  direct-user@127.0.0.1:${fixture.port}`);
    expect(await call("ssh_bash", { connection_id: id, command: "pwd" })).toBe(fixture.workspace + "\n");
    expect(await call("ssh_close", { connection_id: id })).toBe(`Closed ${id} (remote cleanup confirmed).`);
  });

  test("one caller timing out does not abort another caller's shared worker startup", async () => {
    const before = fixture.authentications;
    const short = call("ssh_connect", { host: "slow", timeout_seconds: 1 }, true);
    const longer = call("ssh_connect", { host: "slow", timeout_seconds: 5 });
    expect(await short).toStartWith("Error: CONNECT_TIMEOUT\n");
    const id = connectionId(await longer);
    try {
      expect(fixture.authentications - before).toBe(1);
      expect((await call("ssh_sessions")).split("\n")).toContain(`${id}  slow@slow:${fixture.port}`);
    } finally { await call("ssh_close", { connection_id: id }); }
  }, 8000);

  test("connects with the user's IgnoreUnknown and overrides interactive session settings", async () => {
    const sshConfig = join(fixture.root, "interactive_ssh_config");
    await writeFile(sshConfig, [
      "IgnoreUnknown FixtureOnly,SessionType,ForkAfterAuthentication,StdinNull",
      "FixtureOnly yes",
      "RequestTTY force",
      "RemoteCommand echo interactive",
      "SessionType subsystem",
      "ForkAfterAuthentication yes",
      "StdinNull yes",
      `Include "${fixture.config.sshConfig}"`,
    ].join("\n") + "\n");
    const runtime = new Runtime({ ...fixture.config, sshConfig });
    try {
      const connection = await runtime.ssh.connect({ host: "fixture" });
      const id = String(connection.connection_id);
      const result = await runtime.tasks.execute(id, "printf connected", undefined, 5000);
      expect(result.exit_code).toBe(0);
      expect(result.preview).toEqual([{ stream: "stdout", text: "connected" }]);
      await runtime.ssh.sftp(id, ["pwd"], undefined, 5000);
      expect(await runtime.ssh.closeConnection(id)).toMatchObject({ remote_cleanup: "confirmed" });
    } finally { await runtime.close(); }
  });

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
    expect(result).toBe(`${dev}  fixture@fixture:${fixture.port}`);
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
    expect(value).toBe(`File created successfully at: ${path}`);
    const read = await call("ssh_read_file", { connection_id: dev, file_path: path, limit: 1 });
    expect(read).toBe("     1\thello\nPARTIAL view: showing lines 1-1 of 2. Use offset=2 to continue.");
    expect(await call("ssh_read_file", { connection_id: dev, file_path: path, offset: 2 })).toBe("     2\t世界");
    expect(await readFile(path, "utf8")).toBe("hello\r\n世界\r\n");
    expect(await readdir(fixture.workspace)).not.toContain("SHOULD_NOT_EXIST");
  });

  test("applies exact edits atomically and requires a fresh read for stale or ambiguous edits", async () => {
    const created = await call("ssh_write_file", { connection_id: dev, file_path: "edit.txt", content: "one\r\ntwo two\r\n" });
    expect(created).toBe(`File created successfully at: ${join(fixture.workspace, "edit.txt")}`);
    await chmod(join(fixture.workspace, "edit.txt"), 0o751);

    const ambiguous = await call("ssh_edit_file", {
      connection_id: dev, file_path: "edit.txt", old_string: "two", new_string: "second",
    }, true);
    expect(ambiguous).toStartWith("Error: REMOTE_OPERATION_FAILED\n");
    expect(ambiguous).toContain("exactly one occurrence");
    expect(await readFile(join(fixture.workspace, "edit.txt"), "utf8")).toBe("one\r\ntwo two\r\n");

    const first = await call("ssh_edit_file", {
      connection_id: dev, file_path: "edit.txt", old_string: "one", new_string: "first",
    });
    expect(first).toBe(`The file ${join(fixture.workspace, "edit.txt")} has been updated successfully.\n     1\tfirst\n     2\ttwo two`);
    expect(await readFile(join(fixture.workspace, "edit.txt"), "utf8")).toBe("first\r\ntwo two\r\n");
    const second = await call("ssh_edit_file", {
      connection_id: dev, file_path: "edit.txt", old_string: "two", new_string: "second", replace_all: true,
    });
    expect(second).toContain("Replaced 2 occurrences. Showing the first changed region.\n     1\tfirst\n     2\tsecond second");
    expect((await lstat(join(fixture.workspace, "edit.txt"))).mode & 0o777).toBe(0o751);
    expect(await readFile(join(fixture.workspace, "edit.txt"), "utf8")).toBe("first\r\nsecond second\r\n");

    await writeFile(join(fixture.workspace, "edit.txt"), "changed\r\n");
    const stale = await call("ssh_edit_file", {
      connection_id: dev, file_path: "edit.txt", old_string: "changed", new_string: "again",
    }, true);
    expect(stale).toContain("conflict");
    expect(await readFile(join(fixture.workspace, "edit.txt"), "utf8")).toBe("changed\r\n");

    await call("ssh_bash", { connection_id: dev, command: "printf 'outside\\n' > outside.txt" });
    const unread = await call("ssh_edit_file", {
      connection_id: dev, file_path: "outside.txt", old_string: "outside", new_string: "inside",
    }, true);
    expect(unread).toBe("Error: FILE_NOT_READ\nRead the entire current file with ssh_read_file before editing it. Follow any paging hints.");
    await call("ssh_read_file", { connection_id: dev, file_path: "outside.txt" });
    await call("ssh_edit_file", { connection_id: dev, file_path: "outside.txt", old_string: "outside", new_string: "inside" });
    expect(await readFile(join(fixture.workspace, "outside.txt"), "utf8")).toBe("inside\n");

    await call("ssh_bash", { connection_id: dev, command: "printf 'guard\\n' > guard.txt" });
    const unreadWrite = await call("ssh_write_file", { connection_id: dev, file_path: "guard.txt", content: "replaced" }, true);
    expect(unreadWrite).toContain("read it with ssh_read_file first");
    expect(await readFile(join(fixture.workspace, "guard.txt"), "utf8")).toBe("guard\n");
    await call("ssh_read_file", { connection_id: dev, file_path: "guard.txt" });
    await call("ssh_write_file", { connection_id: dev, file_path: "guard.txt", content: "replaced" });
    expect(await readFile(join(fixture.workspace, "guard.txt"), "utf8")).toBe("replaced");
  });

  test("declines no-op edits without replacing the inode, changing mtime, or refreshing a stale read", async () => {
    const file_path = join(fixture.workspace, "noop.txt");
    const args = { connection_id: dev, file_path };
    await call("ssh_write_file", { ...args, content: "first" });
    const before = await stat(file_path, { bigint: true });
    expect(await call("ssh_edit_file", { ...args, old_string: "first", new_string: "first" }, true)).toContain("No changes to make");
    const after = await stat(file_path, { bigint: true });
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
    await writeFile(file_path, "external");
    await call("ssh_edit_file", { ...args, old_string: "external", new_string: "external" }, true);
    expect(await call("ssh_edit_file", { ...args, old_string: "external", new_string: "new" }, true)).toContain("conflict");
  });

  test("read pages and edit previews number CR, CRLF and Unicode line boundaries consistently", async () => {
    const args = { connection_id: connectionId(await call("ssh_connect", { host: "fixture" })), file_path: "line-breaks.txt" };
    const content = "one\rtwo\r\nthree\u0085four\u2028five\u2029six\u000bseven\u000ceight\u001cnine\u001dten\u001eeleven\n";
    await writeFile(join(fixture.workspace, args.file_path), content);
    const first = await call("ssh_read_file", { ...args, limit: 4 });
    expect(first).toBe("     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour\nPARTIAL view: showing lines 1-4 of 11. Use offset=5 to continue.");
    expect(await call("ssh_read_file", { ...args, offset: 5 })).toContain("    11\televen");
    const edited = await call("ssh_edit_file", { ...args, old_string: "seven", new_string: "SEVEN" });
    expect(edited).toContain("     5\tfive\n     6\tsix\n     7\tSEVEN\n     8\teight\n     9\tnine");
    expect(await readFile(join(fixture.workspace, args.file_path), "utf8")).toBe(content.replace("seven", "SEVEN"));
  });

  test("only full page coverage of the same revision unlocks edits and overwrites", async () => {
    const file_path = join(fixture.workspace, "paged-guard.txt");
    const args = { connection_id: dev, file_path };
    await writeFile(file_path, "one\ntwo\nthree\n");
    await call("ssh_read_file", { ...args, limit: 1 });
    await call("ssh_read_file", { ...args, offset: 3 });
    expect(await call("ssh_edit_file", { ...args, old_string: "one", new_string: "ONE" }, true)).toContain("FILE_NOT_READ");
    expect(await call("ssh_write_file", { ...args, content: "oops" }, true)).toContain("read it with ssh_read_file first");
    await writeFile(file_path, "one\ntwo\nexternal\n");
    expect(await call("ssh_read_file", { ...args, offset: 2 })).toContain("modified since it was last read");
    await call("ssh_write_file", { ...args, content: "oops" }, true);
    await call("ssh_read_file", { ...args, limit: 1 });
    expect(await call("ssh_read_file", { ...args, offset: 2 })).not.toContain("modified since");
    expect(await call("ssh_edit_file", { ...args, old_string: "two", new_string: "TWO" })).toContain("     2\tTWO");
  });

  test("only a delivered single-file Bash view records the revision under the command's cwd", async () => {
    const directory = join(fixture.workspace, "viewing");
    const cwd = join(fixture.workspace, "viewing-alias");
    await mkdir(directory);
    await symlink(directory, cwd);
    const name = "two words.txt";
    const args = { connection_id: dev, file_path: "~/viewing-alias/" + name };
    await writeFile(join(cwd, name), "one\ntwo\n");
    for (const command of ["cat 'two words.txt' | head -1", "cat 'two words.txt' >/dev/null", "cat 'two words.txt' 'two words.txt'"]) {
      await call("ssh_bash", { connection_id: dev, command, cwd });
      expect(await call("ssh_edit_file", { ...args, old_string: "one", new_string: "ONE" }, true)).toContain("FILE_NOT_READ");
    }
    await call("ssh_bash", { connection_id: dev, command: "sed -n '1,2p' 'two words.txt'", cwd });
    await call("ssh_edit_file", { ...args, old_string: "one", new_string: "ONE" });
    const background = await call("ssh_bash", { connection_id: dev, command: "cat 'two words.txt'", cwd, run_in_background: true });
    await call("ssh_task_output", { ...taskScope(background), wait_seconds: 3 });
    await call("ssh_write_file", { ...args, content: "last" });
    await call("ssh_task_output", taskScope(background));
    await call("ssh_edit_file", { ...args, old_string: "last", new_string: "latest" });
    expect(await readFile(join(cwd, name), "utf8")).toBe("latest");

    // A retained log may be delivered for the first time after a newer read or write.
    const delayed = taskScope(await call("ssh_bash", { connection_id: dev, command: "cat 'two words.txt'", cwd, run_in_background: true }));
    const completed = delayed.task_id + "  completed";
    const deadline = Date.now() + 3000;
    while (!(await call("ssh_task_list", { connection_id: dev })).includes(completed)) {
      if (Date.now() > deadline) throw new Error("Background view did not finish");
      await delay(10);
    }
    await call("ssh_write_file", { ...args, content: "new version" });
    expect(await call("ssh_task_output", delayed)).toContain("latest");
    await call("ssh_edit_file", { ...args, old_string: "new version", new_string: "edited new version" });

    const homeFile = "home source#1.txt";
    await writeFile(join(fixture.workspace, homeFile), "home\n");
    expect(await call("ssh_bash", { connection_id: dev, command: "cat ~/'home source#1.txt'\n", cwd })).toBe("home\n");
    await call("ssh_edit_file", { connection_id: dev, file_path: "~/" + homeFile, old_string: "home", new_string: "edited" });
    await mkdir(join(cwd, "~"));
    const literal = join(cwd, "~", homeFile);
    await writeFile(literal, "local\n");
    expect(await call("ssh_bash", { connection_id: dev, command: "cat '~/home source#1.txt'", cwd })).toBe("local\n");
    await call("ssh_edit_file", { connection_id: dev, file_path: literal, old_string: "local", new_string: "edited local" });
  });

  test("empty Bash views keep edit and overwrite guards until the caller receives file content or reads the empty file", async () => {
    const connection_id = connectionId(await call("ssh_connect", { host: "fixture" }));
    const file_path = "empty-bash-view.txt";
    const edit = { connection_id, file_path, old_string: "content", new_string: "replacement" };
    await writeFile(join(fixture.workspace, file_path), "\ncontent\n");
    // BSD head rejects zero counts. On Linux these commands succeed with no output.
    const commands = ["sed -n '999,1000p'", ...(process.platform === "linux" ? ["head -n 0", "head -c 0"] : [])];
    for (const command of commands) {
      expect(await call("ssh_bash", { connection_id, command: `${command} ${file_path}` })).toBe("");
      expect(await call("ssh_edit_file", edit, true)).toContain("FILE_NOT_READ");
    }
    expect(await call("ssh_bash", { connection_id, command: `head -n 1 ${file_path}` })).toBe("\n");
    expect(await call("ssh_edit_file", edit)).toContain("replacement");

    const empty = { connection_id, file_path: "empty-cat-view.txt" };
    await writeFile(join(fixture.workspace, empty.file_path), "");
    expect(await call("ssh_bash", { connection_id, command: `cat ${empty.file_path}` })).toBe("");
    const write = { ...empty, content: "filled" };
    expect(await call("ssh_write_file", write, true)).toContain("read it with ssh_read_file first");
    const background = await call("ssh_bash", { connection_id, command: `cat ${empty.file_path}`, run_in_background: true });
    const query = { ...taskScope(background), wait_seconds: 3 };
    const complete = await call("ssh_task_output", query);
    expect(complete).toContain("Exit code: 0");
    expect(await call("ssh_task_output", query)).toBe(complete);
    expect(await call("ssh_write_file", write, true)).toContain("read it with ssh_read_file first");
    expect(await call("ssh_read_file", empty)).toBe("File exists but is empty.");
    await call("ssh_write_file", write);
    expect(await readFile(join(fixture.workspace, empty.file_path), "utf8")).toBe("filled");
  });

  test("a single-file search establishes a revision only after matching text reaches the client", async () => {
    const connection_id = connectionId(await call("ssh_connect", { host: "fixture" }));
    const file_path = "search-revision.txt";
    const edit = { connection_id, file_path, old_string: "first", new_string: "edited" };
    await writeFile(join(fixture.workspace, file_path), "first\n" + "matching line\n".repeat(8000));
    const miss = await call("ssh_bash", { connection_id, command: `grep absent ${file_path}` });
    expect(miss).toContain("Exit code: 1");
    await call("ssh_task_output", taskScope(miss));
    expect(await call("ssh_edit_file", edit, true)).toContain("FILE_NOT_READ");
    expect(await call("ssh_bash", { connection_id, command: `grep -l matching ${file_path}` })).toContain(file_path);
    expect(await call("ssh_edit_file", edit, true)).toContain("FILE_NOT_READ");
    if (Bun.which("rg")) {
      const lineNumbers = await call("ssh_bash", { connection_id, command: `rg -m2 -no '^' ${file_path}` });
      expect(lineNumbers).toBe("1:\n2:\n");
      expect(await call("ssh_edit_file", edit, true)).toContain("FILE_NOT_READ");
      const offsets = await call("ssh_bash", { connection_id, command: `rg -m1 -Unbo 'a{0}' ${file_path}` });
      expect(offsets).toMatch(/^(?:1:\d+:\n)+$/);
      expect(await call("ssh_edit_file", edit, true)).toContain("FILE_NOT_READ");
    }

    const matches = await call("ssh_bash", { connection_id, command: `grep matching ${file_path}` });
    expect(matches).toContain("read selectively");
    expect(matches).toContain("matching line");
    expect(await call("ssh_edit_file", edit)).toContain("edited");
  });

  test("reads non-UTF-8 text and permits clean rewrites while guarding exact edits and replacement characters", async () => {
    const file_path = join(fixture.workspace, "sjis.txt");
    const args = { connection_id: dev, file_path };
    const original = Buffer.from([0x82, 0xa0, 0x0a]);
    await writeFile(file_path, original);
    expect(await call("ssh_read_file", args)).toContain("�");
    expect(await call("ssh_edit_file", { ...args, old_string: "�", new_string: "あ" }, true)).toContain("Cannot edit non-UTF-8");
    expect(await call("ssh_write_file", { ...args, content: "�" }, true)).toContain("U+FFFD");
    expect(await readFile(file_path)).toEqual(original);
    await call("ssh_write_file", { ...args, content: "あ\n" });
    expect(await readFile(file_path, "utf8")).toBe("あ\n");
    await call("ssh_write_file", { ...args, content: "literal � in valid UTF-8" });

    await writeFile(file_path, Buffer.from("\uFEFFhello", "utf16le"));
    expect(await call("ssh_read_file", args)).toContain("hello");
    expect(await call("ssh_edit_file", { ...args, old_string: "hello", new_string: "world" }, true)).toContain("Cannot edit UTF-16");
    await call("ssh_write_file", { ...args, content: "world" });
    expect(await readFile(file_path, "utf8")).toBe("world");
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

  test("reading a symlink shares its revision with the target and other aliases", async () => {
    const id = connectionId(await call("ssh_connect", { host: "fixture" }));
    const target = join(fixture.workspace, "canonical-revision.txt");
    const alias = join(fixture.workspace, "revision-link.txt");
    const otherAlias = join(fixture.workspace, "other-revision-link.txt");
    await writeFile(target, "original");
    await symlink(target, alias);
    await symlink(target, otherAlias);
    await call("ssh_read_file", { connection_id: id, file_path: alias });
    await call("ssh_edit_file", { connection_id: id, file_path: target, old_string: "original", new_string: "first edit" });

    await writeFile(target, "external update");
    await call("ssh_read_file", { connection_id: id, file_path: otherAlias });
    await call("ssh_edit_file", { connection_id: id, file_path: alias, old_string: "external update", new_string: "final edit" });
    expect(await readFile(target, "utf8")).toBe("final edit");
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });

  test("large file responses cross worker protocol chunks", async () => {
    const content = "x".repeat(200000);
    const written = await call("ssh_write_file", { connection_id: dev, file_path: "large.txt", content });
    const path = join(fixture.workspace, "large.txt");
    expect(written).toBe(`File created successfully at: ${path}`);
    expect((await stat(path)).size).toBe(200000);
    const read = await call("ssh_read_file", { connection_id: dev, file_path: "large.txt", limit: 2000 });
    expect(read).toBe(`     1\t${content}`);
    const localPath = join(fixture.transfers, "large.txt");
    const downloaded = await call("ssh_download", {
      connection_id: dev, remotePath: "large.txt", localPath,
    });
    const sha256 = createHash("sha256").update(content).digest("hex");
    expect(downloaded).toBe(`Downloaded ${path} to ${localPath} (200000 bytes).\nSHA-256: ${sha256}`);
    expect(await readFile(localPath, "utf8")).toBe(content);
  });

  test("requires explicit pages for large text and refuses known binary extensions", async () => {
    const connection_id = connectionId(await call("ssh_connect", { host: "fixture" }));
    const file_path = "long-source.txt";
    await writeFile(join(fixture.workspace, file_path), "a".repeat(99).concat("\n").repeat(3000));
    for (const paging of [{}, { offset: 1 }, { offset: 1, limit: 3000 }, { offset: 2, limit: 2999 }]) {
      expect(await call("ssh_read_file", { connection_id, file_path, ...paging }, true)).toContain("Whole-file read exceeds 256 KiB");
    }
    const overBudget = await call("ssh_read_file", { connection_id, file_path, offset: 2, limit: 2700 }, true);
    expect(overBudget).toContain("rg through ssh_bash");
    expect(overBudget).not.toContain("PARTIAL");
    expect(await call("ssh_read_file", { connection_id, file_path, offset: 3000 })).toBe("  3000\t" + "a".repeat(99));
    const page = await call("ssh_read_file", { connection_id, file_path, limit: 2 });
    expect(page).toContain("PARTIAL view: showing lines 1-2 of 3000.");
    for (const ext of ["xlsx", "PARQUET", "heic", "zip", "PDF"]) {
      const binary = "binary-data." + ext;
      await writeFile(join(fixture.workspace, binary), "pk");
      expect(await call("ssh_read_file", { connection_id, file_path: binary }, true)).toContain("ssh_bash");
    }
    await symlink(file_path, join(fixture.workspace, "snapshot.xlsx"));
    expect(await call("ssh_read_file", { connection_id, file_path: "snapshot.xlsx" }, true)).toContain("Binary file (.xlsx)");
  });

  test("refuses PDF content and the removed page selector without granting a file revision", async () => {
    const file_path = "unlabelled-document";
    const args = { connection_id: dev, file_path };
    await writeFile(join(fixture.workspace, file_path), "%PDF-1.4\n1 0 obj\n");
    expect(await call("ssh_read_file", { ...args, pages: "1" }, true)).toContain("pages");
    expect(await call("ssh_read_file", args, true)).toContain("Binary file (.pdf)");
    expect(await call("ssh_edit_file", { ...args, old_string: "obj", new_string: "changed" }, true))
      .toContain("FILE_NOT_READ");
  });

  test("renders notebook sources, streams and visualizations in cell order", async () => {
    const connection_id = connectionId(await call("ssh_connect", { host: "fixture" }));
    const file_path = "example.ipynb";
    const image = paddedPng(300 * 1024).toString("base64");
    await symlink("notebook-snapshot", join(fixture.workspace, file_path));
    await writeFile(join(fixture.workspace, "notebook-snapshot"), JSON.stringify({ nbformat: 4, cells: [
      { cell_type: "markdown", source: ["Plot\n", "example"] },
      { cell_type: "code", source: "display(figure)", outputs: [
        { output_type: "stream", name: "stdout", text: ["done\n"] },
        { output_type: "display_data", data: { "image/png": image, "text/plain": "<Figure>" } },
        { output_type: "execute_result", data: { "text/plain": ["42"] } },
      ] },
    ] }));
    const result = await client.callTool({ name: "ssh_read_file", arguments: { connection_id, file_path } });
    expect(Boolean(result.isError)).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "Cell 1 (markdown)\nPlot\nexample" },
      { type: "text", text: "Cell 2 (code)\ndisplay(figure)" },
      { type: "text", text: "stdout:\ndone\n" },
      { type: "image", mimeType: "image/png", data: image },
      { type: "text", text: "42" },
    ]);
  });

  test("reads remote image bytes as native MCP content and remembers their file revision", async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const path = join(fixture.workspace, "read-image.bin");
    await writeFile(path, Buffer.from(base64, "base64"));
    const response = await client.callTool({ name: "ssh_read_file", arguments: {
      connection_id: dev, file_path: path, offset: 99, limit: 1,
    } });
    expect(Boolean(response.isError)).toBe(false);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toEqual([{ type: "image", data: base64, mimeType: "image/png" }]);
    expect(await call("ssh_write_file", { connection_id: dev, file_path: path, content: "image was read\n" }))
      .toBe(`The file ${path} has been updated successfully.`);
    expect(await readFile(path, "utf8")).toBe("image was read\n");
  });

  test("image response budget keeps default stdio clients usable and failed reads unremembered", async () => {
    const configPath = join(fixture.root, "image-budget-config.json");
    await writeFile(configPath, JSON.stringify({ ...fixture.config, maxFileBytes: 8 * 1024 * 1024 }));
    const peer = new Client({ name: "image-budget-test", version: "1" });
    const wire = new StdioClientTransport({
      command: process.execPath,
      args: ["run", resolve(process.env.NEVERSSH_TEST_ENTRYPOINT ?? "src/index.ts"), "--config", configPath],
      env: { ...process.env } as Record<string, string>, stderr: "pipe",
    });
    try {
      await peer.connect(wire);
      const connected = await peer.callTool({ name: "ssh_connect", arguments: { host: "fixture" } });
      const text = connected.content[0];
      const connection_id = connectionId(text?.type === "text" ? text.text : "");
      const smallPath = join(fixture.workspace, "image-budget-accepted.bin");
      const small = paddedPng(6 * 1024 * 1024);
      await writeFile(smallPath, small);
      const accepted = await peer.callTool({ name: "ssh_read_file", arguments: { connection_id, file_path: smallPath } });
      expect(Boolean(accepted.isError)).toBe(false);
      expect(accepted.structuredContent).toBeUndefined();
      expect(accepted.content).toEqual([{ type: "image", data: small.toString("base64"), mimeType: "image/png" }]);

      const largePath = join(fixture.workspace, "image-budget-rejected.bin");
      const large = paddedPng(8 * 1024 * 1024);
      await writeFile(largePath, large);
      const rejected = await peer.callTool({ name: "ssh_read_file", arguments: { connection_id, file_path: largePath } });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toBeUndefined();
      expect(rejected.content).toEqual([{ type: "text", text: expect.stringContaining("9 MiB MCP response budget") }]);
      const overwrite = await peer.callTool({ name: "ssh_write_file", arguments: {
        connection_id, file_path: largePath, content: "must remain unread\n",
      } });
      expect(overwrite.isError).toBe(true);
      expect(overwrite.content).toEqual([{ type: "text", text: expect.stringContaining("read it with ssh_read_file first") }]);
      expect(await readFile(largePath)).toEqual(large);
      const sessions = await peer.callTool({ name: "ssh_sessions", arguments: {} });
      expect(Boolean(sessions.isError)).toBe(false);
      expect(sessions.content).toEqual([{ type: "text", text: expect.stringContaining(connection_id) }]);
    } finally { await peer.close(); }
  }, 20000);

  test("preserves symlinks and rejects binary and oversized text reads", async () => {
    await symlink("edit.txt", join(fixture.workspace, "link.txt"));
    expect(await call("ssh_bash", { connection_id: dev, command: "test -L link.txt && printf symlink" })).toBe("symlink");
    await call("ssh_read_file", { connection_id: dev, file_path: "link.txt" });
    await call("ssh_write_file", { connection_id: dev, file_path: "link.txt", content: "via link" });
    expect((await lstat(join(fixture.workspace, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(fixture.workspace, "edit.txt"), "utf8")).toBe("via link");
    await writeFile(join(fixture.workspace, "binary"), Buffer.from([0, 1, 255]));
    expect(await call("ssh_read_file", { connection_id: dev, file_path: "binary" }, true)).toContain("Binary");
    await writeFile(join(fixture.workspace, "huge.txt"), Buffer.alloc(fixture.config.maxFileBytes + 1, 65));
    expect(await call("ssh_read_file", { connection_id: dev, file_path: "huge.txt" }, true)).toContain("maxFileBytes");
    expect(await call("ssh_read_file", {
      connection_id: dev, file_path: join(fixture.workspace, "nested", "edit.txt"),
    }, true)).toContain("FileNotFoundError");
  });
});

describe("binary transfer boundary", () => {
  test("omitted transfer roots allow absolute local paths through the public MCP tools", async () => {
    const configPath = join(fixture.root, "unrestricted.config.json");
    const sshConfig = fixture.config.sshConfig;
    if (!sshConfig) throw new Error("Missing fixture SSH configuration");
    await writeFile(configPath, JSON.stringify({ sshConfig }));
    const local = join(fixture.root, "unrestricted-source.bin");
    const destination = join(fixture.root, "unrestricted-download", "nested", "received.bin");
    const remote = join(fixture.workspace, "unrestricted", "payload.bin");
    const data = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
    const sha256 = createHash("sha256").update(data).digest("hex");
    await writeFile(local, data);
    const peer = new Client({ name: "neverssh-unrestricted-transfers-test", version: "1" });
    const isolated = new StdioClientTransport({
      command: process.execPath,
      args: ["run", resolve(process.env.NEVERSSH_TEST_ENTRYPOINT ?? "src/index.ts"), "--config", configPath],
      env: { ...process.env } as Record<string, string>, stderr: "pipe",
    });
    let diagnostic = "";
    isolated.stderr?.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
    const invoke = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const response = await peer.callTool({ name, arguments: args });
      expect(Boolean(response.isError), JSON.stringify(response.content)).toBe(false);
      expect(response.structuredContent).toBeUndefined();
      expect(response.content.every((item) => item.type === "text")).toBe(true);
      return response.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    };
    try {
      await peer.connect(isolated);
      const connection_id = connectionId(await invoke("ssh_connect", { host: "fixture" }));
      expect(await invoke("ssh_upload", { connection_id, localPath: local, remotePath: remote }))
        .toBe(`Uploaded ${local} to ${remote} (256 bytes).\nSHA-256: ${sha256}`);
      expect(await readFile(remote)).toEqual(data);
      expect(await invoke("ssh_download", { connection_id, remotePath: remote, localPath: destination }))
        .toBe(`Downloaded ${remote} to ${destination} (256 bytes).\nSHA-256: ${sha256}`);
      expect(await readFile(destination)).toEqual(data);
    } finally { await peer.close(); }
    expect(diagnostic).not.toContain("SyntaxError");
    expect(diagnostic).not.toContain("Unhandled");
  }, 15000);

  test("round-trips binary bytes, verifies SHA-256, and refuses implicit overwrite", async () => {
    const data = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
    const localPath = join(fixture.transfers, "source.bin");
    await writeFile(localPath, data);
    const uploaded = await call("ssh_upload", { connection_id: dev, localPath, remotePath: "transfer/data.bin" });
    const remotePath = join(fixture.workspace, "transfer", "data.bin");
    const destination = join(fixture.transfers, "nested", "download.bin");
    const sha256 = createHash("sha256").update(data).digest("hex");
    expect(uploaded).toBe(`Uploaded ${localPath} to ${remotePath} (256 bytes).\nSHA-256: ${sha256}`);
    expect(await readFile(remotePath)).toEqual(data);
    const downloaded = await call("ssh_download", { connection_id: dev, remotePath: "transfer/data.bin", localPath: destination });
    expect(downloaded).toBe(`Downloaded ${remotePath} to ${destination} (256 bytes).\nSHA-256: ${sha256}`);
    expect(await readFile(destination)).toEqual(data);
    await call("ssh_upload", { connection_id: dev, localPath, remotePath: "transfer/data.bin" }, true);
    await call("ssh_download", { connection_id: dev, remotePath: "binary", localPath: destination }, true);
    expect(await readFile(destination)).toEqual(data);
  });

  test("SFTP transfers paths containing spaces and glob characters", async () => {
    const data = Buffer.from(Array.from({ length: 128 }, (_, value) => value));
    const local = join(fixture.transfers, "space file [1].bin");
    await writeFile(local, data);
    const remote = "transfer/space file [1].bin";
    const uploaded = await call("ssh_upload", { connection_id: dev, localPath: local, remotePath: remote });
    const destination = join(fixture.transfers, "space out [1].bin");
    const downloaded = await call("ssh_download", {
      connection_id: dev, remotePath: remote, localPath: destination,
    });
    const sha256 = createHash("sha256").update(data).digest("hex");
    expect(uploaded).toBe(`Uploaded ${local} to ${join(fixture.workspace, remote)} (128 bytes).\nSHA-256: ${sha256}`);
    expect(downloaded).toBe(`Downloaded ${join(fixture.workspace, remote)} to ${destination} (128 bytes).\nSHA-256: ${sha256}`);
    expect(await readFile(destination)).toEqual(data);
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
    const text = await call("ssh_bash", { connection_id: dev, command, wait_seconds: 600 });
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
    const text = await call("ssh_bash", { connection_id: dev, command });
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
    const text = await call("ssh_bash", {
      connection_id: dev, command: "printf begin; sleep 0.3; printf done", wait_seconds: 0.05,
    });
    expect(text).toContain("(running in background)");
    expect(text).toContain("still growing");
    expect(await call("ssh_task_list")).toContain(taskScope(text).task_id);
    const complete = await call("ssh_task_output", { ...taskScope(text), wait_seconds: 300 });
    expect(complete).toContain("(completed)");
    expect(complete).toContain("stdout:\nbegindone");
    expect(await call("ssh_task_output", { ...taskScope(text), wait_seconds: 0 })).toBe(complete);
    const fractional = await call("ssh_bash", {
      connection_id: dev, command: "sleep 0.1; printf completed", wait_seconds: 0.5,
    });
    expect(fractional).toBe("completed");
  });

  test("a wait of -1 returns the final result even when another query is cancelled", async () => {
    const background = await call("ssh_bash", {
      connection_id: dev, run_in_background: true,
      command: "while [ ! -f release-blocking-query ]; do sleep 0.01; done; printf finished",
    });
    const task = taskScope(background);
    const args = { ...task, wait_seconds: -1 };
    const pending = call("ssh_task_output", args);
    const controller = new AbortController();
    const other = client.callTool({ name: "ssh_task_output", arguments: args }, { signal: controller.signal });
    try {
      expect(await call("ssh_task_output", { ...task, wait_seconds: 0 })).toContain("(running in background)");
      controller.abort(new Error("Query cancelled by test"));
      await expect(other).rejects.toThrow("Query cancelled by test");
    } finally {
      await writeFile(join(fixture.workspace, "release-blocking-query"), "");
    }
    const final = await pending;
    expect(final).toContain("(completed)");
    expect(final).toContain("stdout:\nfinished");
  });

  test("expected exit 1 is accepted on the initial call while queries report the process exit", async () => {
    for (const command of ["test -f missing-build-marker", "grep 'not found' /dev/null"]) {
      const benign = await call("ssh_bash", { connection_id: dev, command });
      expect(benign).toContain("(completed)");
      expect(benign).toContain("Exit code: 1");
      const task = taskScope(benign);
      expect(await call("ssh_task_list")).not.toContain(task.task_id);
      const query = await call("ssh_task_output", { ...task, wait_seconds: 0 });
      expect(query).toContain("(failed)");
      expect(query).toContain("Exit code: 1");
    }
    expect(await call("ssh_bash", { connection_id: dev, command: "false" }, true)).toContain("Exit code: 1");
  });

  test("explicit background returns after startup even when a long foreground wait was supplied", async () => {
    const text = await call("ssh_bash", {
      connection_id: dev, command: "sleep 20", run_in_background: true, wait_seconds: 300,
    });
    expect(text).toContain("(running in background)");
    expect(await call("ssh_task_stop", taskScope(text))).toContain("(stopped)");
  });

  test("uses real Bash, EOF stdin, independent cwd, and independent environment", async () => {
    await mkdir(join(fixture.workspace, "nested"));
    const first = await call("ssh_bash", {
      connection_id: dev, cwd: join(fixture.workspace, "nested"),
      command: 'values=(one two); [[ ${values[1]} == two ]] || exit 7; export NEVERSSH_VALUE=first; printf "%s:%s\\n" "$PWD" "$NEVERSSH_VALUE"; cd /',
    });
    expect(first).toContain(join(fixture.workspace, "nested") + ":first\n");
    const second = await call("ssh_bash", {
      connection_id: dev, command: 'read value || printf EOF; printf ":%s:%s" "$PWD" "${NEVERSSH_VALUE-unset}"',
    });
    expect(second).toContain("EOF:" + fixture.workspace + ":unset");
  });

  test("validates task handles and reports operational failures as text", async () => {
    const absentQuery = await call("ssh_task_output", { task_id: "task_00000000", wait_seconds: 0 }, true);
    expect(absentQuery).toContain("Error: TASK_NOT_FOUND");
    const absentStop = await call("ssh_task_stop", { task_id: "task_00000000" }, true);
    expect(absentStop).toContain("Error: TASK_NOT_FOUND");
    await call("ssh_task_stop", { task_id: dev }, true);
    const badCwd = await call("ssh_bash", {
      connection_id: dev, cwd: join(fixture.workspace, "absent-directory"), command: "true",
    }, true);
    expect(badCwd).toContain("Error:");
    expect(badCwd).toContain("No such file");
    const failed = await call("ssh_bash", { connection_id: dev, command: "printf failed >&2; exit 7" }, true);
    expect(failed).toContain("Exit code: 7");
    expect(failed).toEndWith("stderr:\nfailed");
    const task = taskScope(failed);
    expect(await call("ssh_task_list")).not.toContain(task.task_id);
    const replay = await call("ssh_task_output", { ...task, wait_seconds: 0 });
    expect(replay).toContain("Exit code: 7");
    expect(replay).toEndWith("stderr:\nfailed");
    const archive = await call("ssh_read_file", { connection_id: dev, file_path: logPath(failed) });
    expect(archive).toEndWith("\tfailed");
  });

  test("lists active and retained tasks, active first", async () => {
    const running = await call("ssh_bash", {
      connection_id: dev, command: "sleep 20", run_in_background: true,
    });
    const id = taskScope(running).task_id;
    const active = await call("ssh_task_list", { connection_id: dev });
    expect(active).toMatch(new RegExp(`^${id}  running  ${dev}  `, "m"));
    await call("ssh_task_stop", { task_id: id });
    const stopped = await call("ssh_task_list", { connection_id: dev });
    expect(stopped).toMatch(new RegExp(`^${id}  stopped  ${dev}  `, "m"));
    expect(await call("ssh_task_list", {})).toContain(id);
    await call("ssh_task_output", { task_id: id, wait_seconds: 0 });
    expect(await call("ssh_task_list", { connection_id: dev })).not.toContain(id);
    expect(await call("ssh_task_list", { connection_id: "00000000" })).toBe("No tasks.");
  });

  test("missing Bash is a clear startup error instead of a silent shell fallback", async () => {
    const id = connectionId(await call("ssh_connect", { host: "fixture", user: "missing-bash" }));
    try {
      expect(await call("ssh_bash", { connection_id: id, command: "true" }, true))
        .toContain("Error: BASH_UNAVAILABLE");
    } finally { await call("ssh_close", { connection_id: id }); }
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
    const split = await call("ssh_bash", {
      connection_id: dev, command: "python3 -c 'import os,time; os.write(1, bytes([228])); time.sleep(.1); os.write(1, bytes([184,150,231,149,140]))'",
    });
    expect(split).toBe("世界");
    const splitPath = await newestLog(dev);
    const splitMetadata = JSON.parse(await readFile(splitPath.replace(".log", ".meta.json"), "utf8"));
    expect((await readFile(splitPath)).subarray(splitMetadata.output_offset).toString()).toBe("世界");
    const largeCommand = 'python3 -c \'import sys; sys.stdout.write("x" * 2097152)\'';
    const large = await call("ssh_bash", { connection_id: dev, command: largeCommand });
    const logBytes = 2097152 + Buffer.byteLength(`Command:\n${largeCommand}\n\nOutput:\n`);
    expect(large).toContain(`${logBytes} bytes`);
    expect(large).toContain("read selectively");
    expect(large.length).toBeLessThan(70000);
    expect(await call("ssh_task_list")).toContain(taskScope(large).task_id);
    expect((await lstat(logPath(large))).size).toBe(logBytes);
    expect((await lstat(logPath(large))).mode & 0o777).toBe(0o600);
    const readTail = await call("ssh_bash", { connection_id: dev, command: "tail -c 16 '" + logPath(large) + "'" });
    expect(readTail).toBe("x".repeat(16));
    const failed = await call("ssh_bash", { connection_id: dev, command: "printf '%70000s' error >&2; exit 2" }, true);
    expect(failed).toContain("read selectively");
    expect(await call("ssh_task_list")).toContain(taskScope(failed).task_id);
  }, 15000);

  test("concurrent queries show a running command's latest tail and its final archive stays complete", async () => {
    const body = "first line\n" + "repeated log line\n".repeat(10000) + "last stdout line\n";
    const warning = "警告：阶段一结束\n";
    const release = join(fixture.workspace, "release-tail-test");
    await writeFile(join(fixture.workspace, "tail-test-input"), body);
    const command = "cat tail-test-input; while [ ! -f emit-tail-warning ]; do sleep 0.05; done; " +
      "printf '警告：阶段一结束\\n' >&2; " +
      "while [ ! -f release-tail-test ]; do sleep 0.05; done; printf 'final line\\n'";
    const initial = await call("ssh_bash", { connection_id: dev, command, run_in_background: true });
    const scope = taskScope(initial);
    try {
      const path = logPath(initial);
      const waitForArchive = async (bytes: number) => {
        const deadline = Date.now() + 5000;
        while ((await stat(path)).size < bytes) {
          if (Date.now() > deadline) throw new Error(`Command archive did not reach ${bytes} bytes`);
          await delay(10);
        }
      };
      // stdout and stderr use separate pipes. Drain stdout before emitting the warning
      // so it actually belongs to the retained tail on systems with larger pipe buffers.
      const stdoutEnd = Buffer.byteLength(`Command:\n${command}\n\nOutput:\n` + body);
      await waitForArchive(stdoutEnd);
      await writeFile(join(fixture.workspace, "emit-tail-warning"), "");
      await waitForArchive(stdoutEnd + Buffer.byteLength(warning));
      const query = () => call("ssh_task_output", { ...scope, wait_seconds: 0 });
      const [first, second] = await Promise.all([query(), query()]);
      expect(second).toBe(first);
      expect(first).toContain("last stdout line");
      expect(first).toContain("stderr:\n" + warning);
      expect(first).not.toContain("first line\n");
      expect(await call("ssh_task_list", { connection_id: dev })).not.toContain(scope.task_id);
    } finally {
      await writeFile(join(fixture.workspace, "emit-tail-warning"), "");
      await writeFile(release, "");
    }
    const done = await call("ssh_task_output", { ...scope, wait_seconds: 5 });
    expect(done).toContain("final line");
    expect(done).toContain("Exit code: 0");
    const archive = await logOutput(done);
    // Readiness across stdout and stderr can interleave. Both streams must be kept in full.
    expect(archive.replace(warning, "")).toBe(body + "final line\n");
    expect(archive).toContain(warning);
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
    const running = await call("ssh_bash", {
      connection_id: dev, command: "trap '' TERM; (sleep 3; touch cancel-leak) & printf ready; wait", wait_seconds: 0.25,
    });
    expect(running).toContain("ready");
    const stopped = await call("ssh_task_stop", taskScope(running));
    expect(stopped).toContain("(stopped)");
    expect(stopped).toContain("Reason: cancelled");
    expect(await call("ssh_task_stop", taskScope(running))).toBe(stopped);
    await delay(1100);
    expect(await readdir(fixture.workspace)).not.toContain("cancel-leak");
    expect(await logOutput(stopped)).toBe("ready");
  }, 10000);

  test("network loss retains known output without inventing an exit code or replaying the command", async () => {
    const running = await call("ssh_bash", {
      connection_id: dev, command: "printf x >> attempts; printf before; (sleep 2; touch disconnect-leak) & wait", wait_seconds: 0.1,
    });
    fixture.dropConnections();
    const lost = await call("ssh_task_output", { ...taskScope(running), wait_seconds: 3 });
    expect(lost).toContain("Reason: connection_lost");
    expect(lost).toContain("Exit code: unknown");
    expect(lost).toContain("Last confirmed output size:");
    expect(await readFile(join(fixture.workspace, "attempts"), "utf8")).toBe("x");
    expect(await call("ssh_read_file", { connection_id: dev, file_path: "attempts" }, true)).toStartWith("Error: CONNECTION_LOST\n");
    const previous = dev;
    await call("ssh_close", { connection_id: previous });
    dev = connectionId(await call("ssh_connect", { host: "fixture" }));
    expect(dev).not.toBe(previous);
    await delay(2100);
    expect(await readdir(fixture.workspace)).not.toContain("disconnect-leak");
    expect(await logOutput(running)).toBe("before");
  });

  test("force close cleans up children, retains logs, and a new connection can read old paths", async () => {
    const running = await call("ssh_bash", {
      connection_id: dev, command: "trap '' TERM; (sleep 3; touch close-leak) & printf ready; wait", wait_seconds: 0.25,
    });
    const closed = await call("ssh_close", { connection_id: dev });
    expect(closed).toBe(`Closed ${dev} (remote cleanup confirmed).`);
    expect(await call("ssh_close", { connection_id: dev })).toEqual(closed);
    const stopped = await call("ssh_task_output", { ...taskScope(running), wait_seconds: 0 });
    expect(stopped).toContain("Reason: connection_closed");
    expect(await logOutput(running)).toBe("ready");
    const previous = dev;
    dev = connectionId(await call("ssh_connect", { host: "fixture" }));
    expect(dev).not.toBe(previous);
    const oldLog = await call("ssh_read_file", { connection_id: dev, file_path: logPath(running) });
    expect(oldLog).toStartWith("     1\tCommand:\n     2\ttrap '' TERM;");
    expect(oldLog).toEndWith("     3\t\n     4\tOutput:\n     5\tready");
    await delay(1100);
    expect(await readdir(fixture.workspace)).not.toContain("close-leak");
  }, 10000);

  test("four active tasks leave file operations available and concurrent close shares cleanup", async () => {
    const running = await Promise.all(Array.from({ length: 4 }, () => call("ssh_bash", {
      connection_id: dev, command: "sleep 20", run_in_background: true,
    })));
    const full = await call("ssh_bash", { connection_id: dev, command: "true" }, true);
    expect(full).toContain("Error: TASK_LIMIT_REACHED");
    expect(await call("ssh_read_file", { connection_id: dev, file_path: "edit.txt" })).toBe("     1\tvia link");
    const [first, second] = await Promise.all([call("ssh_close", { connection_id: dev }), call("ssh_close", { connection_id: dev })]);
    expect(first).toBe(`Closed ${dev} (remote cleanup confirmed).`);
    expect(second).toEqual(first);
    for (const text of running) {
      expect(await call("ssh_task_output", { ...taskScope(text), wait_seconds: 0 })).toContain("Reason: connection_closed");
    }
    dev = connectionId(await call("ssh_connect", { host: "fixture" }));
  });

  test("sequential Bash tasks reuse a helper and get fresh shells", async () => {
    const ids = async () => (await call("ssh_bash", {
      connection_id: dev, command: 'printf "%s %s" "$PPID" "$$"',
    })).trim().split(" ");
    const [helper, shell] = await ids();
    const [nextHelper, nextShell] = await ids();
    expect(helper).toMatch(/^\d+$/);
    expect(nextHelper).toBe(helper);
    expect(nextShell).not.toBe(shell);
  });

  test("installs and reuses the versioned remote build cache", async () => {
    const build = join(fixture.workspace, ".neverssh", "builds", BUILD_ID);
    const manifest = JSON.parse(await readFile(join(build, "manifest.json"), "utf8"));
    expect(manifest.build_id).toBe(BUILD_ID);
    expect(manifest.protocol).toBe(PROTOCOL_VERSION);
    expect(manifest.server_version).toBe(SERVER_VERSION);
    for (const name of ["worker.py", "file_ops.py", "helper.py", "helper_pool.py", "archive.py", "build_cache.py", "workspace.py", "read_formats.py"]) {
      expect((await lstat(join(build, name))).isFile()).toBe(true);
    }
    const before = (await lstat(join(build, "worker.py"))).mtimeMs;
    const runtime = new Runtime(fixture.config);
    try {
      expect((await runtime.ssh.connect({ host: "fixture" })).connection_id).toBeDefined();
    } finally { await runtime.close(); }
    expect((await lstat(join(build, "worker.py"))).mtimeMs).toBe(before);
  });

  test("ssh_connect repairs a missing cached startup module and runs Bash on that connection", async () => {
    await call("ssh_close", { connection_id: dev });
    await unlink(join(fixture.workspace, ".neverssh", "builds", BUILD_ID, "worker.py"));
    const before = fixture.authentications;
    dev = connectionId(await call("ssh_connect", { host: "fixture" }));
    expect(fixture.authentications - before).toBe(1);
    expect(await call("ssh_bash", { connection_id: dev, command: "printf repaired" })).toBe("repaired");
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
    const workers = captureWorkers(fixture);
    const running = await call("ssh_bash", {
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
    expect(metadata, JSON.stringify({ metadata, stderr, ...workers() })).toHaveProperty("finished_at");
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
      expect(connection.structuredContent).toBeUndefined();
      expect(connection.content.every((item) => item.type === "text")).toBe(true);
      expect(connectionId(connection.content.map((item) => item.type === "text" ? item.text : "").join("\n")))
        .toMatch(/^[a-f0-9]{8}$/);
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
        expect(connection.result.structuredContent).toBeUndefined();
        const id = connectionId(connection.result.content.map((item: { type: string; text?: string }) =>
          item.type === "text" ? item.text : "").join("\n"));
        const workers = captureWorkers(epipeFixture);
        const started = await rpc("tools/call", {
          name: "ssh_bash", arguments: {
            connection_id: id,
            command: "printf retained; (sleep 3; touch epipe-leak) & wait", run_in_background: true,
          },
        });
        expect(started.result.isError).toBeFalsy();
        expect(started.result.structuredContent).toBeUndefined();
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
        expect(metadata, JSON.stringify({ metadata, diagnostic, ...workers() })).toHaveProperty("finished_at");
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

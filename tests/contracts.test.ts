/** Keep public schemas, executable documentation examples, and generated field tables aligned. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client, InMemoryTransport, type Tool } from "@modelcontextprotocol/client";
import { z } from "zod";
import { configSchema } from "../src/config";
import { commandContracts, connectionContracts, toolContracts } from "../src/contracts";
import { errorText, ToolError } from "../src/errors";
import * as format from "../src/operation-text";
import { createServer, Runtime } from "../src/server";

const runtime = new Runtime(configSchema.parse({}));
const client = new Client({ name: "neverssh-contract-test", version: "1.0.0" });
let tools: Tool[];

beforeAll(async () => {
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await createServer(runtime).connect(remote);
  await client.connect(local);
  tools = (await client.listTools()).tools;
});

afterAll(async () => {
  await client.close();
  await runtime.close();
});

test("documentation field tables are generated from the registered MCP contracts", () => {
  const result = Bun.spawnSync([process.execPath, "run", "scripts/sync-interface-docs.ts", "--check"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("interface document covers every registered tool", async () => {
  const source = await Bun.file(new URL("../docs/interfaces.md", import.meta.url)).text();
  const headings = source.split(/^## /m).slice(1).map((section) => section.slice(0, section.indexOf("\n")));
  for (const { name, outputSchema } of tools) {
    expect(headings.filter((heading) => heading === name), name).toHaveLength(1);
    expect(outputSchema, name).toBeUndefined();
  }
});

test("all documented requests validate against registered inputs and results use readable text", async () => {
  const source = await Bun.file(new URL("../docs/interfaces.md", import.meta.url)).text();
  expect(source.match(/^# /gm)).toHaveLength(1);
  expect(source).not.toMatch(/<!-{2}/);
  const sections = source.split(/^## /m).slice(1);
  for (const { name, inputSchema } of tools) {
    // The server publishes generated JSON Schemas; the SDK types nested values more broadly than Zod.
    const input = z.fromJSONSchema(inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    const contract = toolContracts[name as keyof typeof toolContracts];
    const matches = sections.filter((section) => section.startsWith(`${name}\n`));
    expect(matches, name).toHaveLength(1);
    const examples = matches[0]!.split(/^#### /m).slice(1);
    let inputs = 0;
    let outputs = 0;
    for (const example of examples) {
      const heading = example.slice(0, example.indexOf("\n"));
      if (heading.startsWith("请求")) {
        const json = /^\x60\x60\x60json\n([\s\S]*?)\x60\x60\x60/m.exec(example);
        expect(json, name).not.toBeNull();
        const args = JSON.parse(json![1]!);
        expect(input.safeParse(args).success, name).toBe(true);
        if (contract) expect(contract.input.safeParse(args).success, name).toBe(true);
        inputs++;
      } else if (heading.startsWith("返回")) {
        expect(example, name).not.toMatch(/^\x60\x60\x60json$/m);
        const text = /^\x60\x60\x60text\n([\s\S]*?)\x60\x60\x60/m.exec(example)?.[1];
        expect(text, name).toBeDefined();
        expect(text!.trim().length, name).toBeGreaterThan(0);
        if (name === "ssh_task_list") {
          expect(text).toMatch(/^task_[a-f0-9]{8}  /m);
        } else if (name.startsWith("ssh_task_") || name === "ssh_bash") {
          if (text!.includes("Task:")) expect(text).toMatch(/^Task: task_[a-f0-9]{8}/m);
          if (name !== "ssh_bash") expect(text).toMatch(/^Exit code: /m);
        }
        outputs++;
      }
    }
    expect(inputs, name).toBeGreaterThan(0);
    expect(outputs, name).toBeGreaterThan(0);
  }
  const errors = sections.find((section) => section.startsWith("错误返回\n"))!;
  expect(errors).not.toMatch(/^\x60\x60\x60json$/m);
  const text = /^\x60\x60\x60text\n([\s\S]*?)\x60\x60\x60/m.exec(errors)?.[1];
  expect(text?.trimEnd()).toBe(errorText(new ToolError("TASK_NOT_FOUND", "Task does not exist in this MCP instance")));
});

test("connection, file, and transfer return examples match their text formatters", async () => {
  const source = await Bun.file(new URL("../docs/interfaces.md", import.meta.url)).text();
  const sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const examples = {
    ssh_discover: format.discoverText({ servers: [{ host: "dev-server" }, { host: "build-server" }] }),
    ssh_connect: format.connectText({ connection_id: "7a2c9d4f" }),
    ssh_sessions: format.sessionsText({ sessions: [{ connection_id: "7a2c9d4f", host: "dev-server", user: "developer", port: 2222 }] }),
    ssh_close: format.closeText({ connection_id: "7a2c9d4f", remote_cleanup: "confirmed" }),
    ssh_read_file: format.readText({ content: 'import { createServer } from "node:http";\n\n', startLine: 1, totalLines: 2 }),
    ssh_write_file: format.writeText({ path: "/srv/app/notes.txt", created: true }),
    ssh_edit_file: format.editText({ path: "/srv/app/notes.txt" }),
    ssh_upload: format.uploadText({ path: "/srv/app/assets/logo.png", localPath: "/Users/me/transfer/logo.png", bytesWritten: 2048, sha256 }),
    ssh_download: format.downloadText({ path: "/srv/app/build/app.tar.gz", localPath: "/Users/me/transfer/app.tar.gz", size: 4096, sha256 }),
  };
  for (const [name, expected] of Object.entries(examples)) {
    const section = source.split(/^## /m).find((section) => section.startsWith(`${name}\n`))!;
    const output = section.split(/^#### 返回[^\n]*\n/m)[1]!;
    const text = /^\x60\x60\x60text\n([\s\S]*?)\x60\x60\x60/m.exec(output)?.[1];
    expect(text, name).toBe(expected + "\n");
  }
});

test("Bash contracts expose only the execution controls and typed task handles", () => {
  const bashScope = { connection_id: "1234abcd" };
  const taskScope = { task_id: "task_abcd1234" };
  const bash = commandContracts.ssh_bash.input;
  const defaults = bash.parse({ connection_id: bashScope.connection_id, command: "make test" });
  expect(defaults).toEqual({ connection_id: bashScope.connection_id, command: "make test", run_in_background: false, wait_seconds: 120 });
  for (const option of [
    { timeout_seconds: 600 }, { timeout_ms: 1000 }, { wait_ms: 0 }, { env: { CI: "1" } },
    { shell: "/bin/bash" }, { host: "other" }, { description: "run tests" },
  ]) expect(bash.safeParse({ ...defaults, ...option }).success).toBe(false);
  expect(commandContracts.ssh_task_output.input.parse(taskScope)).toEqual({ ...taskScope, wait_seconds: 30 });
  expect(commandContracts.ssh_task_stop.input.parse(taskScope)).toEqual(taskScope);
  expect(commandContracts.ssh_task_list.input.parse({})).toEqual({});
  expect(commandContracts.ssh_task_list.input.parse({ connection_id: "1234abcd" })).toEqual({ connection_id: "1234abcd" });
  expect(commandContracts.ssh_task_list.input.safeParse({ task_id: "task_abcd1234" }).success).toBe(false);
  expect(commandContracts.ssh_task_list.input.safeParse({ include_finished: true }).success).toBe(false);
  for (const task_id of ["abcd1234", "1234abcd", crypto.randomUUID(), "task_ABCD1234"]) {
    expect(commandContracts.ssh_task_stop.input.safeParse({ task_id }).success).toBe(false);
  }
  expect(commandContracts.ssh_task_stop.input.safeParse({ ...taskScope, connection_id: "1234abcd" }).success).toBe(false);
  expect(commandContracts.ssh_task_output.input.safeParse({ ...taskScope, cursor: 0 }).success).toBe(false);
  expect(commandContracts.ssh_task_stop.input.safeParse({ ...taskScope, signal: "SIGKILL" }).success).toBe(false);
});

test("connection inputs reject host overrides on follow-up calls and invalid combinations", () => {
  const contracts = connectionContracts;
  expect(contracts.ssh_discover.input.parse({})).toEqual({});
  for (const args of [{ query: "dev" }, { limit: 1 }, { cursor: "unused" }]) {
    expect(contracts.ssh_discover.input.safeParse(args).success).toBe(false);
  }
  expect(contracts.ssh_connect.input.parse({ host: "dev" }).timeout_seconds).toBe(60);
  expect(contracts.ssh_connect.input.safeParse({ host: "::1" }).success).toBe(true);
  expect(contracts.ssh_sessions.input.parse({})).toEqual({});
  for (const args of [{ connection_id: "1234abcd" }, { check_alive: true }, { limit: 1 }, { cursor: "unused" }]) {
    expect(contracts.ssh_sessions.input.safeParse(args).success).toBe(false);
  }
  expect(contracts.ssh_close.input.parse({ connection_id: "1234abcd" })).toEqual({ connection_id: "1234abcd" });
  expect(contracts.ssh_close.input.safeParse({}).success).toBe(false);
  for (const options of [{ host: "other" }, { on_busy: "cancel" }, { on_busy: "error" }, { timeout_seconds: 10 }]) {
    expect(contracts.ssh_close.input.safeParse({ connection_id: "1234abcd", ...options }).success).toBe(false);
  }
});

test("waits use fractional seconds up to five minutes without a command timeout", () => {
  const cases = [
    { schema: commandContracts.ssh_bash.input, args: { connection_id: "1234abcd", command: "true" } },
    { schema: commandContracts.ssh_task_output.input, args: { task_id: "task_abcd1234" } },
  ];
  for (const { schema, args } of cases) {
    for (const wait_seconds of [0, 0.5, 120, 300]) {
      expect(schema.safeParse({ ...args, wait_seconds }).success).toBe(true);
    }
    for (const wait_seconds of [-0.1, 300.1, Infinity, NaN]) {
      expect(schema.safeParse({ ...args, wait_seconds }).success).toBe(false);
    }
    expect(schema.safeParse({ ...args, wait_ms: 1000 }).success).toBe(false);
  }
  expect(connectionContracts.ssh_connect.input.safeParse({ host: "dev", timeout_seconds: 1.5 }).success).toBe(true);
  expect(connectionContracts.ssh_connect.input.safeParse({ host: "dev", timeout_ms: 60000 }).success).toBe(false);
});

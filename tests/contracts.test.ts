/** Keep public schemas, executable documentation examples, and generated field tables aligned. */
import { expect, test } from "bun:test";
import { commandContracts, connectionContracts, toolContracts } from "../src/contracts";

test("documentation field tables are generated from the registered MCP contracts", () => {
  const result = Bun.spawnSync([process.execPath, "run", "scripts/sync-interface-docs.ts", "--check"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("interface document covers every registered tool", async () => {
  const source = await Bun.file(new URL("../docs/interfaces.md", import.meta.url)).text();
  const headings = source.split(/^## /m).slice(1).map((section) => section.slice(0, section.indexOf("\n")));
  const tools = [
    ...Object.keys(toolContracts),
    "ssh_read_file", "ssh_write_file", "ssh_edit_file",
    "ssh_upload", "ssh_download",
  ];
  for (const name of tools) expect(headings.filter((heading) => heading === name), name).toHaveLength(1);
});

test("documented examples validate against schemas or use readable task text", async () => {
  const source = await Bun.file(new URL("../docs/interfaces.md", import.meta.url)).text();
  expect(source.match(/^# /gm)).toHaveLength(1);
  expect(source).not.toMatch(/<!-{2}/);
  const sections = source.split(/^## /m).slice(1);
  for (const [name, contract] of Object.entries(toolContracts)) {
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
        expect(contract.input.safeParse(JSON.parse(json![1]!)).success, name).toBe(true);
        inputs++;
      } else if (heading.startsWith("返回")) {
        if ("output" in contract) {
          const json = /^\x60\x60\x60json\n([\s\S]*?)\x60\x60\x60/m.exec(example);
          if (json) {
            expect(contract.output.safeParse(JSON.parse(json[1]!)).success, name).toBe(true);
          } else {
            const text = /^\x60\x60\x60text\n([\s\S]*?)\x60\x60\x60/m.exec(example)?.[1];
            expect(text, name).toBeDefined();
            expect(text!.trim().length, name).toBeGreaterThan(0);
          }
        } else {
          const text = /^\x60\x60\x60text\n([\s\S]*?)\x60\x60\x60/m.exec(example)?.[1];
          expect(text, name).toBeDefined();
          expect(text!.trim().length, name).toBeGreaterThan(0);
          if (name === "ssh_task_list") {
            expect(text).toMatch(/^task_[a-f0-9]{8}  /m);
          } else {
            if (text!.includes("Task:")) expect(text).toMatch(/^Task: task_[a-f0-9]{8}/m);
            if (name !== "ssh_bash") expect(text).toMatch(/^Exit code: /m);
          }
        }
        outputs++;
      }
    }
    expect(inputs, name).toBeGreaterThan(0);
    expect(outputs, name).toBeGreaterThan(0);
  }
  const errors = sections.find((section) => section.startsWith("错误返回\n"))!;
  const json = /^\x60\x60\x60json\n([\s\S]*?)\x60\x60\x60/m.exec(errors)!;
  for (const contract of Object.values(connectionContracts)) {
    expect(contract.output.safeParse(JSON.parse(json[1]!)).success).toBe(true);
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
  expect(contracts.ssh_discover.output.safeParse({ servers: [] }).success).toBe(true);
  expect(contracts.ssh_discover.output.safeParse({ servers: [], next_cursor: null }).success).toBe(false);
  expect(contracts.ssh_connect.input.parse({ host: "dev" }).timeout_seconds).toBe(60);
  expect(contracts.ssh_connect.input.safeParse({ host: "::1" }).success).toBe(true);
  expect(contracts.ssh_sessions.input.parse({})).toEqual({});
  for (const args of [{ connection_id: "1234abcd" }, { check_alive: true }, { limit: 1 }, { cursor: "unused" }]) {
    expect(contracts.ssh_sessions.input.safeParse(args).success).toBe(false);
  }
  expect(contracts.ssh_sessions.output.safeParse({ sessions: [] }).success).toBe(true);
  expect(contracts.ssh_sessions.output.safeParse({ sessions: [], next_cursor: null }).success).toBe(false);
  const session = { connection_id: "1234abcd", host: "dev", user: "developer", port: 22 };
  expect(contracts.ssh_sessions.output.safeParse({ sessions: [session] }).success).toBe(true);
  expect(contracts.ssh_sessions.output.safeParse({ sessions: [{ ...session, state: "ready" }] }).success).toBe(false);
  expect(contracts.ssh_close.input.parse({ connection_id: "1234abcd" })).toEqual({ connection_id: "1234abcd" });
  expect(contracts.ssh_close.input.safeParse({}).success).toBe(false);
  for (const options of [{ host: "other" }, { on_busy: "cancel" }, { on_busy: "error" }, { timeout_seconds: 10 }]) {
    expect(contracts.ssh_close.input.safeParse({ connection_id: "1234abcd", ...options }).success).toBe(false);
  }
  expect(contracts.ssh_connect.output.safeParse({ connection_id: "1234abcd", host: "dev" }).success).toBe(false);
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

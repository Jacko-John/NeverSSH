/** Exercise remote project development through MCP content and an isolated real SSH fixture. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { ToolError } from "../src/errors";
import { createServer } from "../src/mcp/server";
import * as operationText from "../src/mcp/operation-text";
import { Runtime } from "../src/runtime";
import type { RemoteResult } from "../src/ssh/request-channel";
import { WorkspaceManager } from "../src/workspaces/manager";
import { contextText } from "../src/workspaces/text";
import type { Instruction } from "../src/workspaces/types";
import { SshFixture } from "./fixture";

const fixture = new SshFixture();
let client: Client;
let connectionId = "";
let stderr = "";
let projectNumber = 0;

/** Assert the actual public response without rebuilding the removed structured result contract. */
async function textCall(peer: Client, name: string, args: Record<string, unknown>, error = false): Promise<string> {
  const response = await peer.callTool({ name, arguments: args });
  expect(Boolean(response.isError), name).toBe(error);
  expect(response.structuredContent, name).toBeUndefined();
  expect(response.content.length, name).toBeGreaterThan(0);
  expect(response.content.every((item) => item.type === "text"), name).toBe(true);
  return response.content.map((item) => item.type === "text" ? item.text : "").join("\n");
}

async function call(name: string, args: Record<string, unknown>, error = false): Promise<string> {
  return textCall(client, name, args, error);
}

/** Extract only the advertised opaque handle needed for the next call. */
function workspaceId(text: string): string {
  const match = /^Workspace: (ws_[a-f0-9]{8})$/m.exec(text);
  expect(match, text.slice(0, 2048)).not.toBeNull();
  return match![1]!;
}

function selectedSkill(text: string, description: string): string {
  const line = text.split("\n").find((line) => line.includes(`: ${description}`));
  const match = /^- (.+?): /.exec(line ?? "");
  expect(match, text.slice(0, 2048)).not.toBeNull();
  return match![1]!;
}

/** Each project owns its files; no test touches a user's repository or SSH configuration. */
async function project(files: Record<string, string>): Promise<string> {
  const root = join(fixture.workspace, `project-${++projectNumber}`);
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function open(root: string): Promise<{ id: string; text: string }> {
  const text = await call("ssh_workspace_open", { connection_id: connectionId, path: root });
  return { id: workspaceId(text), text };
}

/** Fixture commits use per-command identity and signing options, never persistent user settings. */
async function git(root: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-c", "user.name=NeverSSH Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stderr).text();
  expect(await child.exited, output).toBe(0);
}

beforeAll(async () => {
  await fixture.start();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", resolve(process.env.NEVERSSH_TEST_ENTRYPOINT ?? "src/index.ts"), "--config", fixture.configPath],
    env: { ...process.env } as Record<string, string>, stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  client = new Client({ name: "neverssh-workspace-test", version: "1.0.0" });
  await client.connect(transport);
  const connected = await call("ssh_connect", { host: "fixture" });
  expect(connected).toMatch(/^Connection: [a-f0-9]{8}$/);
  connectionId = connected.slice("Connection: ".length);
}, 20000);

afterAll(async () => {
  await client?.close();
  await fixture.close();
  if (stderr.includes("SyntaxError") || stderr.includes("Unhandled")) throw new Error(stderr);
}, 15000);

describe("workspace context and instruction delivery", () => {
  test("opens a canonical root with complete guidance and lazy skill metadata", async () => {
    const root = await project({
      "AGENTS.md": "Keep changes focused. Run the project checks.\n", "README.md": "Project instructions.\n",
      "package.json": '{"scripts":{"test":"bun test"}}\n', "backend/AGENTS.md": "Backend-only guidance.\n",
      ".agents/skills/check-project/SKILL.md": "---\nname: check-project\ndescription: >-\n  Check this project\n  before delivery.\n---\n\nLAZY_SKILL_BODY_MARKER\nRead references/check.md and run scripts/check.sh.\n",
      ".agents/skills/check-project/references/check.md": "Inspect the diff before delivery.\n",
      ".agents/skills/check-project/scripts/check.sh": "printf 'skill check passed\\n'\n",
    });
    const alias = root + "-alias";
    await symlink(root, alias);
    const opened = await open(alias);
    expect(opened.text).toContain(`Remote root: ${root}`);
    expect(opened.text).toContain(`Project instructions: ${root}/AGENTS.md\nScope: ${root}\nKeep changes focused.`);
    expect(opened.text).not.toContain("Revision:");
    expect(opened.text).not.toContain("Use workspace_id for project operations.");
    expect(opened.text).toContain("Keep changes focused. Run the project checks.\n");
    expect(opened.text).not.toContain("Backend-only guidance.");
    expect(opened.text).toContain(root + "/README.md");
    expect(opened.text).toContain(root + "/package.json");
    expect(opened.text).toContain("check-project: Check this project before delivery.");
    expect(opened.text).not.toContain("LAZY_SKILL_BODY_MARKER");
    const skill = selectedSkill(opened.text, "Check this project before delivery.");
    expect(skill).toBe("check-project");
    expect(opened.text).toContain("\nSkills:\n- check-project: Check this project before delivery.");
    expect(opened.text).not.toMatch(/skill_[a-f0-9]{16}/);
    const loaded = await call("ssh_skill_read", { workspace_id: opened.id, skill_name: skill });
    expect(loaded).toContain(`Skill: ${skill}`);
    expect(loaded).not.toContain("Revision:");
    expect(loaded).toContain(`Remote skill directory: ${root}/.agents/skills/check-project`);
    expect(loaded).toContain("LAZY_SKILL_BODY_MARKER");
    expect(loaded).toContain("references/check.md");
    expect(loaded).toContain("scripts/check.sh");
    const reference = await call("ssh_skill_read", { workspace_id: opened.id, skill_name: skill, resource: "references/check.md" });
    expect(reference).toContain(`Remote source: ${root}/.agents/skills/check-project/references/check.md`);
    expect(reference).toContain("Inspect the diff before delivery.\n");
    expect(await call("ssh_bash", { workspace_id: opened.id, command: "sh .agents/skills/check-project/scripts/check.sh" })).toBe("skill check passed\n");
  });

  test("opening shows the first 50 Git status entries and the exact remainder", async () => {
    const files = Object.fromEntries(Array.from({ length: 137 }, (_, i) => [`change-${String(i).padStart(3, "0")}`, "dirty"]));
    const root = await project(files);
    await git(root, ["init", "--quiet"]);
    const opened = await open(root);
    expect(opened.text.match(/^\?\? change-/gm)).toHaveLength(50);
    expect(opened.text).toContain("?? change-049");
    expect(opened.text).not.toContain("change-050");
    expect(opened.text).toContain("87 Git status entries omitted");
    expect(opened.text).toContain("git status --short -- .");
  });

  test("creating a new file first returns newly applicable root-to-leaf instructions", async () => {
    const root = await project({ "AGENTS.md": "Root rule.\n", "backend/AGENTS.md": "Backend rule.\n",
      "backend/api/AGENTS.md": "API rule.\n", "frontend/AGENTS.md": "Frontend-only rule.\n" });
    const { id } = await open(root);
    const file_path = "backend/api/new/deep/file.txt";
    const response = await client.callTool({ name: "ssh_write_file", arguments: { workspace_id: id, file_path, content: "new file\n" } });
    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(2);
    const [result, guidance] = response.content;
    expect(result?.type === "text" ? result.text : "").toStartWith("Error: WORKSPACE_RULES_CHANGED\n");
    const written = guidance?.type === "text" ? guidance.text : "";
    expect(written).toContain("Backend rule.\n");
    expect(written.indexOf("Backend rule.")).toBeLessThan(written.indexOf("API rule."));
    expect(written).not.toContain("Root rule.\n");
    expect(written).not.toContain("Frontend-only rule.");
    expect(await stat(join(root, "backend/api/new")).catch(() => null)).toBeNull();
    const repeated = await call("ssh_write_file", { workspace_id: id, file_path, content: "new file\n" });
    expect(repeated).not.toContain("Backend rule.");
    expect(repeated).not.toContain("API rule.");
    expect(await readFile(join(root, file_path), "utf8")).toBe("new file\n");
  });

  test("successful reads deliver nested rules and reopening resets their delivery", async () => {
    const root = await project({ "AGENTS.md": "Root rule.\n", "src/AGENTS.md": "Nested rule.\n", "src/value.txt": "before\n" });
    const original = await open(root);
    const read = await call("ssh_read_file", { workspace_id: original.id, file_path: "src/value.txt" });
    expect(read).toContain("Nested rule.\n");
    expect(read).not.toContain("Root rule.\n");
    expect(read).toStartWith("     1\tbefore");
    expect(await call("ssh_read_file", { workspace_id: original.id, file_path: "src/value.txt" })).toBe("     1\tbefore");
    await call("ssh_edit_file", { workspace_id: original.id, file_path: "src/value.txt", old_string: "before", new_string: "after" });
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("after\n");
    const reopened = await open(root);
    expect(reopened.id).toBe(original.id);
    expect(reopened.text).not.toContain("Nested rule.");
    const write = { workspace_id: reopened.id, file_path: "src/new.txt", content: "new\n" };
    expect(await call("ssh_write_file", write, true)).toContain("Nested rule.\n");
    expect(await stat(join(root, "src/new.txt")).catch(() => null)).toBeNull();
    await call("ssh_write_file", { workspace_id: reopened.id, file_path: "root.txt", content: "root guidance delivered\n" });
    expect(await call("ssh_write_file", write)).not.toContain("Nested rule.");
    expect(await readFile(join(root, "src/new.txt"), "utf8")).toBe("new\n");
  });

  test("image reads return the image before new guidance and do not repeat delivered rules", async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const root = await project({ "AGENTS.md": "Root image rule.\n", "src/AGENTS.md": "Source image rule.\n" });
    await writeFile(join(root, "src/preview.bin"), Buffer.from(base64, "base64"));
    const { id } = await open(root);
    const args = { workspace_id: id, file_path: "src/preview.bin" };
    const first = await client.callTool({ name: "ssh_read_file", arguments: args });
    expect(Boolean(first.isError)).toBe(false);
    expect(first.structuredContent).toBeUndefined();
    expect(first.content).toHaveLength(2);
    expect(first.content[0]).toEqual({ type: "image", data: base64, mimeType: "image/png" });
    const guidance = first.content[1];
    expect(guidance?.type).toBe("text");
    const text = guidance?.type === "text" ? guidance.text : "";
    expect(text).toContain(`Project instructions: ${root}/src/AGENTS.md\nScope: ${root}/src\nSource image rule.\n`);
    expect(text).not.toContain("Root image rule.");
    expect(text).not.toContain(base64);
    const second = await client.callTool({ name: "ssh_read_file", arguments: args });
    expect(Boolean(second.isError)).toBe(false);
    expect(second.structuredContent).toBeUndefined();
    expect(second.content).toEqual([{ type: "image", data: base64, mimeType: "image/png" }]);
  });

  test("ordinary reads omit catalogs and report only changed or removed rules", async () => {
    const root = await project({ "AGENTS.md": "Root rule.\n", "src/AGENTS.md": "Nested rule.\n", "src/value.txt": "before\n",
      ".agents/skills/check/SKILL.md": "---\nname: check\ndescription: Catalog must not repeat on reads.\n---\nBody.\n" });
    const opened = await open(root);
    expect(opened.text).toContain("Catalog must not repeat on reads.");
    const first = await call("ssh_read_file", { workspace_id: opened.id, file_path: "src/value.txt" });
    expect(first).toContain("Nested rule.\n");
    expect(first).not.toContain("Revision:");
    expect(first).not.toContain("Catalog must not repeat on reads.");
    const reopened = await open(root);
    expect(reopened.id).toBe(opened.id);
    expect(reopened.text).toContain("Root rule.\n");
    expect(reopened.text).not.toContain("Nested rule.\n");
    expect(reopened.text).toContain("Catalog must not repeat on reads.");
    const recovered = await call("ssh_read_file", { workspace_id: reopened.id, file_path: "src/value.txt" });
    expect(recovered).toContain("Nested rule.\n");
    expect(recovered).not.toContain("Root rule.\n");
    expect(recovered).not.toContain("Catalog must not repeat on reads.");

    await writeFile(join(root, "src/AGENTS.md"), "Changed nested rule.\n");
    const changed = await call("ssh_read_file", { workspace_id: opened.id, file_path: "src/value.txt" });
    expect(changed).toContain("Changed nested rule.\n");
    expect(changed).not.toContain("Root rule.\n");
    expect(changed).not.toContain("Nested rule.\n");

    await unlink(join(root, "src/AGENTS.md"));
    const removed = await call("ssh_read_file", { workspace_id: opened.id, file_path: "src/value.txt" });
    expect(removed).toContain(`Project instructions removed: ${root}/src/AGENTS.md\nScope: ${root}/src`);
    expect(removed).not.toContain("Changed nested rule.\n");
    await call("ssh_edit_file", { workspace_id: opened.id, file_path: "src/value.txt", old_string: "before", new_string: "after" });
  });

  test("a failed missing or binary read does not deliver the prepared nested guidance", async () => {
    for (const file of ["missing.txt", "binary.txt"]) {
      const root = await project({ "src/AGENTS.md": "Guidance that must reach the response.\n", "src/binary.txt": "\0binary" });
      const { id } = await open(root);
      const failed = await call("ssh_read_file", { workspace_id: id, file_path: "src/" + file }, true);
      expect(failed).not.toContain("Guidance that must reach the response.");
      const args = { workspace_id: id, file_path: "src/new.txt", content: "written" };
      const written = await call("ssh_write_file", args, true);
      expect(written).toContain("Guidance that must reach the response.\n");
      await call("ssh_write_file", args);
      expect(await readFile(join(root, "src/new.txt"), "utf8")).toBe("written");
      expect(await call("ssh_read_file", { workspace_id: id, file_path: "src/new.txt" })).not.toContain("Guidance that must reach the response.");
    }
  });

  test("a late read preserves the version recorded by a concurrent write", async () => {
    const root = await project({ "value": "original" });
    const runtime = new Runtime(fixture.config);
    const peer = new Client({ name: "concurrent-read-test", version: "1" });
    try {
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await createServer(runtime).connect(remote);
      await peer.connect(local);
      const connected = await textCall(peer, "ssh_connect", { host: "fixture" });
      const scope = { connection_id: connected.slice("Connection: ".length), file_path: join(root, "value") };
      await textCall(peer, "ssh_read_file", scope);
      const run = runtime.ssh.run.bind(runtime.ssh);
      let captured!: () => void;
      let resume!: () => void;
      const snapshotReady = new Promise<void>((resolve) => { captured = resolve; });
      const responseAllowed = new Promise<void>((resolve) => { resume = resolve; });
      const hook = spyOn(runtime.ssh, "run").mockImplementation(async (...request) => {
        const result = await run(...request);
        if (request[1] === "read") {
          captured();
          await responseAllowed;
        }
        return result;
      });
      try {
        const old = textCall(peer, "ssh_read_file", scope);
        await snapshotReady;
        await textCall(peer, "ssh_write_file", { ...scope, content: "current" });
        resume();
        const delayed = await old;
        expect(delayed).toContain("     1\toriginal");
        expect(delayed).toContain("A later observation recorded different contents");
        expect(delayed).not.toContain("modified since it was last read");
        await textCall(peer, "ssh_edit_file", { ...scope, old_string: "current", new_string: "latest" });
        expect(await readFile(join(root, "value"), "utf8")).toBe("latest");
      } finally { resume(); hook.mockRestore(); }
    } finally {
      await peer.close();
      await runtime.close();
    }
  }, 15000);

  test("a failed read formatter does not deliver guidance after the remote read succeeded", async () => {
    const root = await project({ "src/AGENTS.md": "Formatter delivery rule.\n", "src/value.txt": "before\n" });
    const runtime = new Runtime(fixture.config);
    const peer = new Client({ name: "formatter-delivery-test", version: "1" });
    try {
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await createServer(runtime).connect(remote);
      await peer.connect(local);
      const connected = await textCall(peer, "ssh_connect", { host: "fixture" });
      const context = await textCall(peer, "ssh_workspace_open", { connection_id: connected.slice("Connection: ".length), path: root });
      const id = workspaceId(context);
      const hook = spyOn(operationText, "readText").mockImplementation(() => { throw new Error("formatter fixture failure"); });
      try {
        expect(await textCall(peer, "ssh_read_file", { workspace_id: id, file_path: "src/value.txt" }, true)).toContain("formatter fixture failure");
      } finally { hook.mockRestore(); }
      const args = { workspace_id: id, file_path: "src/new.txt", content: "written" };
      const written = await textCall(peer, "ssh_write_file", args, true);
      expect(written).toContain("Formatter delivery rule.\n");
      await textCall(peer, "ssh_write_file", args);
      expect(await readFile(join(root, "src/new.txt"), "utf8")).toBe("written");
    } finally {
      await peer.close();
      await runtime.close();
    }
  }, 15000);

  test("image response budget includes guidance and leaves failed delivery pending", async () => {
    const root = await project({ "src/AGENTS.md": "图片规则仍需交付。\n", "src/value.txt": "before\n" });
    const runtime = new Runtime(fixture.config);
    const peer = new Client({ name: "image-guidance-budget-test", version: "1" });
    try {
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await createServer(runtime).connect(remote);
      await peer.connect(local);
      const connected = await textCall(peer, "ssh_connect", { host: "fixture" });
      const opened = await textCall(peer, "ssh_workspace_open", { connection_id: connected.slice("Connection: ".length), path: root });
      const args = { workspace_id: workspaceId(opened), file_path: "src/value.txt" };
      const image = { type: "image" as const, mimeType: "image/png", data: "" };
      const emptyBytes = Buffer.byteLength(JSON.stringify({ content: [image] }), "utf8");
      image.data = "A".repeat(Math.floor((9 * 1024 * 1024 - emptyBytes) / 4) * 4);
      expect(Buffer.byteLength(JSON.stringify({ content: [image] }), "utf8")).toBeLessThanOrEqual(9 * 1024 * 1024);
      const originalRun = runtime.ssh.run.bind(runtime.ssh);
      const hook = spyOn(runtime.ssh, "run").mockImplementation(async (...request) => {
        if (request[1] !== "read") return originalRun(...request);
        return { kind: "image", base64: image.data, mimeType: image.mimeType, path: join(root, "src/value.txt"),
          size: image.data.length / 4 * 3, sha256: "a".repeat(64) };
      });
      try {
        const rejected = await textCall(peer, "ssh_read_file", args, true);
        expect(rejected).toStartWith("Error: OPERATION_FAILED\n");
        expect(rejected).toContain("9 MiB MCP response budget");
        expect(rejected).not.toContain("图片规则仍需交付。");
      } finally { hook.mockRestore(); }
      expect(await textCall(peer, "ssh_read_file", args)).toContain("图片规则仍需交付。\n");
      expect(await textCall(peer, "ssh_read_file", args)).toBe("     1\tbefore");
    } finally {
      await peer.close();
      await runtime.close();
    }
  }, 15000);

  test("changed guidance pauses an edit and Bash still delivers guidance with its results", async () => {
    const root = await project({ "AGENTS.md": "Original root rule.\n", "src/value.txt": "before\n" });
    const { id } = await open(root);
    await call("ssh_read_file", { workspace_id: id, file_path: "src/value.txt" });
    await writeFile(join(root, "AGENTS.md"), "Changed root rule.\n");
    const edit = { workspace_id: id, file_path: "src/value.txt", old_string: "before", new_string: "after" };
    expect(await call("ssh_edit_file", edit, true)).toContain("Changed root rule.\n");
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("before\n");
    const edited = await call("ssh_edit_file", edit);
    expect(edited).toContain(`The file ${root}/src/value.txt has been updated successfully.`);
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("after\n");
    expect(await call("ssh_bash", { workspace_id: id, command: "pwd" })).toBe(root + "\n");
    await writeFile(join(root, "AGENTS.md"), "Changed command rule.\n");
    const changed = await call("ssh_bash", { workspace_id: id, command: "printf side-effect > root-effect" });
    expect(changed).toContain("Changed command rule.\n");
    expect(await readFile(join(root, "root-effect"), "utf8")).toBe("side-effect");
    expect(await call("ssh_bash", { workspace_id: id, command: "pwd" })).toBe(root + "\n");
    await writeFile(join(root, "src/AGENTS.md"), "New nested rule.\n");
    const bash = { workspace_id: id, cwd: "src", command: "printf side-effect >> nested-effects" };
    const added = await call("ssh_bash", bash);
    expect(added).toContain("New nested rule.\n");
    expect(added).not.toContain("Changed command rule.");
    expect(await readFile(join(root, "src/nested-effects"), "utf8")).toBe("side-effect");
    await unlink(join(root, "src/AGENTS.md"));
    const removed = await call("ssh_bash", bash);
    expect(removed).toContain(`Project instructions removed: ${root}/src/AGENTS.md\nScope: ${root}/src`);
    expect(await readFile(join(root, "src/nested-effects"), "utf8")).toBe("side-effectside-effect");
    expect(await call("ssh_bash", { workspace_id: id, cwd: "src", command: "pwd" })).toBe(join(root, "src") + "\n");
  });

  test("a nonzero command retains its task failure and returns guidance without rerunning its effects", async () => {
    const root = await project({ "src/AGENTS.md": "Failed commands must still show this rule.\n" });
    const { id } = await open(root);
    const response = await client.callTool({ name: "ssh_bash", arguments: {
      workspace_id: id, cwd: "src", command: "printf once >> attempts; printf 'command ran\\n'; exit 7",
    } });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(response.content).toHaveLength(2);
    const [result, guidance] = response.content;
    expect(result?.type).toBe("text");
    expect(guidance?.type).toBe("text");
    const failed = result?.type === "text" ? result.text : "";
    const instructions = guidance?.type === "text" ? guidance.text : "";
    expect(instructions).toContain("Failed commands must still show this rule.\n");
    expect(failed).toMatch(/^Task: task_[a-f0-9]{8} \(failed\)/);
    expect(failed).toContain("Exit code: 7");
    expect(failed).toContain("command ran\n");
    expect(failed).not.toContain("Failed commands must still show this rule.");
    expect(failed).not.toContain("WORKSPACE_REOPEN_REQUIRED");
    expect(failed).not.toContain("Nothing was executed.");
    expect(await readFile(join(root, "src/attempts"), "utf8")).toBe("once");
    expect(await call("ssh_bash", { workspace_id: id, cwd: "src", command: "cat attempts" })).toBe("once");
  });

  test("background commands deliver guidance at startup and keep their original task handle", async () => {
    const root = await project({ "src/AGENTS.md": "Background work uses this source rule.\n" });
    const { id } = await open(root);
    const release = join(root, "src/release-background");
    try {
      const response = await client.callTool({ name: "ssh_bash", arguments: {
        workspace_id: id, cwd: "src", command: "while [ ! -f release-background ]; do sleep 0.01; done; printf once >> runs", run_in_background: true,
      } });
      expect(Boolean(response.isError)).toBe(false);
      expect(response.content).toHaveLength(2);
      const [result, guidance] = response.content;
      const task = result?.type === "text" ? result.text : "";
      const taskId = /^Task: (task_[a-f0-9]{8}) /m.exec(task)?.[1];
      expect(taskId).toBeDefined();
      expect(guidance?.type === "text" ? guidance.text : "").toContain("Background work uses this source rule.\n");
      await writeFile(release, "ready\n");
      const finished = await call("ssh_task_output", { task_id: taskId!, wait_seconds: 10 });
      expect(finished).toContain(`Task: ${taskId} (completed)`);
      expect(finished).toContain("Exit code: 0");
      expect(await call("ssh_bash", { workspace_id: id, cwd: "src", command: "cat runs" })).toBe("once");
    } finally {
      await writeFile(release, "ready\n");
    }
  });

  test("receiving mutation guidance leaves the read-before-edit requirement in force", async () => {
    const root = await project({ "src/AGENTS.md": "Read code before replacing it.\n", "src/value.txt": "before\n" });
    const { id } = await open(root);
    const edit = { workspace_id: id, file_path: "src/value.txt", old_string: "before", new_string: "after" };
    const review = await call("ssh_edit_file", edit, true);
    expect(review).toStartWith("Error: WORKSPACE_RULES_CHANGED\n");
    expect(review).toContain("Read code before replacing it.\n");
    const failed = await call("ssh_edit_file", edit, true);
    expect(failed).toStartWith("Error: FILE_NOT_READ\n");
    expect(failed).not.toContain("Read code before replacing it.");
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("before\n");
    const read = await call("ssh_read_file", { workspace_id: id, file_path: "src/value.txt" });
    expect(read).not.toContain("Read code before replacing it.\n");
    expect(await call("ssh_edit_file", { workspace_id: id, file_path: "src/value.txt", old_string: "before", new_string: "after" })).not.toContain("Read code before replacing it.");
  });

  test("linked instructions keep their directory scope and edits through aliases report rule deletion", async () => {
    const root = await project({ "instructions/source.md": "Scoped source guidance.\n", "src/value.txt": "before\n" });
    await symlink(join(root, "instructions/source.md"), join(root, "src/AGENTS.md"));
    await symlink(join(root, "src"), join(root, "alias"));
    const { id } = await open(root);
    const read = await call("ssh_read_file", { workspace_id: id, file_path: "alias/value.txt" });
    expect(read).toContain(`Project instructions: ${root}/src/AGENTS.md\nScope: ${root}/src\n`);
    await unlink(join(root, "src/AGENTS.md"));
    const edit = { workspace_id: id, file_path: "alias/value.txt", old_string: "before", new_string: "after" };
    expect(await call("ssh_edit_file", edit, true)).toContain(`Project instructions removed: ${root}/src/AGENTS.md\nScope: ${root}/src`);
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("before\n");
    await call("ssh_edit_file", edit);
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("after\n");
    await writeFile(join(root, "src/value.txt"), "outside update\n");
    await call("ssh_read_file", { workspace_id: id, file_path: join(root, "src/value.txt") });
    await call("ssh_edit_file", { workspace_id: id, file_path: "alias/value.txt", old_string: "outside update", new_string: "latest revision" });
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("latest revision\n");
  });

  test("nested directory links deliver removal of rules in the intermediate directory", async () => {
    const root = await project({ "middle/AGENTS.md": "Review intermediate files.\n", "final/value": "first" });
    await symlink(join(root, "middle"), join(root, "alias"));
    await symlink(join(root, "final"), join(root, "middle/next"));
    const { id } = await open(root);
    const scope = { workspace_id: id };
    const file_path = "alias/next/value";
    expect(await call("ssh_read_file", { ...scope, file_path })).toContain("Review intermediate files.");
    await unlink(join(root, "middle/AGENTS.md"));
    // Direct access to the same file does not traverse the intermediate directory.
    expect(await call("ssh_read_file", { ...scope, file_path: "final/value" })).not.toContain("instructions removed");
    const edit = { ...scope, file_path, old_string: "first", new_string: "second" };
    const paused = await call("ssh_edit_file", edit, true);
    expect(paused).toContain(`Project instructions removed: ${root}/middle/AGENTS.md`);
    expect(await readFile(join(root, "final/value"), "utf8")).toBe("first");
    expect(await call("ssh_edit_file", edit)).not.toContain("instructions removed");
    expect(await readFile(join(root, "final/value"), "utf8")).toBe("second");
  });
});

describe("workspace skills and operation boundaries", () => {
  test("keeps projects and connection-mode defaults independent on a shared connection", async () => {
    const firstRoot = await project({ "AGENTS.md": "First project.\n", "src/AGENTS.md": "First source rules.\n", "src/value.txt": "first\n" });
    const secondRoot = await project({ "AGENTS.md": "Second project.\n", "src/AGENTS.md": "Second source rules.\n", "src/value.txt": "second\n" });
    const first = await open(firstRoot);
    const second = await open(secondRoot);
    expect(second.id).not.toBe(first.id);
    await call("ssh_read_file", { workspace_id: first.id, file_path: "src/value.txt" });
    const secondArgs = { workspace_id: second.id, file_path: "src/new.txt", content: "second only" };
    const secondWrite = await call("ssh_write_file", secondArgs, true);
    expect(secondWrite).toContain("Second source rules.\n");
    expect(secondWrite).not.toContain("First source rules.");
    await call("ssh_write_file", secondArgs);
    expect(await call("ssh_write_file", { workspace_id: first.id, file_path: "src/new.txt", content: "first only" })).not.toContain("First source rules.");
    expect(await readFile(join(firstRoot, "src/new.txt"), "utf8")).toBe("first only");
    expect(await readFile(join(secondRoot, "src/new.txt"), "utf8")).toBe("second only");
    expect(await call("ssh_bash", { workspace_id: first.id, command: "pwd" })).toBe(firstRoot + "\n");
    expect(await call("ssh_bash", { workspace_id: second.id, command: "pwd" })).toBe(secondRoot + "\n");
    expect(await call("ssh_bash", { connection_id: connectionId, command: "pwd" })).toBe(fixture.workspace + "\n");
    expect(await call("ssh_read_file", { connection_id: connectionId, file_path: join(secondRoot, "src/value.txt") })).toBe("     1\tsecond");
  });

  test("requires exactly one scope on files, commands, and transfers", async () => {
    const root = await project({ "value.txt": "scope\n" });
    const { id } = await open(root);
    for (const [name, args] of [
      ["ssh_read_file", { file_path: "value.txt" }], ["ssh_write_file", { file_path: "new.txt", content: "invalid" }],
      ["ssh_edit_file", { file_path: "value.txt", old_string: "scope", new_string: "invalid" }], ["ssh_bash", { command: "true" }],
      ["ssh_upload", { localPath: join(fixture.transfers, "scope.txt"), remotePath: "uploaded.txt" }],
      ["ssh_download", { localPath: join(fixture.transfers, "scope-download.txt"), remotePath: "value.txt" }],
    ] as const) {
      for (const scope of [{}, { connection_id: connectionId, workspace_id: id }]) await call(name, { ...args, ...scope }, true);
    }
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("scope\n");
    expect(await stat(join(root, "new.txt")).catch(() => null)).toBeNull();
  });

  test("rejects lexical and symlink escapes, including absent mutation paths", async () => {
    const root = await project({ "value.txt": "inside\n" });
    const outside = await project({ "secret.txt": "outside\n" });
    await symlink(outside, join(root, "escape"));
    const { id } = await open(root);
    expect(await call("ssh_read_file", { workspace_id: id, file_path: join(root, "value.txt") })).toEndWith("     1\tinside");
    for (const file_path of [join(outside, "secret.txt"), "../" + outside.split("/").at(-1) + "/secret.txt", "escape/secret.txt"]) {
      await call("ssh_read_file", { workspace_id: id, file_path }, true);
    }
    for (const file_path of [join(outside, "new.txt"), "escape/new.txt"]) await call("ssh_write_file", { workspace_id: id, file_path, content: "must not write" }, true);
    expect(await stat(join(outside, "new.txt")).catch(() => null)).toBeNull();
    await call("ssh_bash", { workspace_id: id, cwd: "escape", command: "pwd" }, true);
  });

  for (const operation of ["read", "write"] as const) {
    test(`a prepared ${operation} keeps its checked target when a directory alias changes`, async () => {
      const root = await project({ "inside/value.txt": "inside\n" });
      const outside = await project({ "value.txt": "outside\n" });
      const alias = join(root, "alias");
      await symlink(join(root, "inside"), alias);
      const runtime = new Runtime(fixture.config);
      const peer = new Client({ name: `prepared-${operation}-test`, version: "1" });
      try {
        const [local, remote] = InMemoryTransport.createLinkedPair();
        await createServer(runtime).connect(remote);
        await peer.connect(local);
        const connected = await textCall(peer, "ssh_connect", { host: "fixture" });
        const opened = await textCall(peer, "ssh_workspace_open", { connection_id: connected.slice("Connection: ".length), path: root });
        const originalPrepare = runtime.workspaces.prepare.bind(runtime.workspaces);
        const hook = spyOn(runtime.workspaces, "prepare").mockImplementation(async (...args) => {
          const prepared = await originalPrepare(...args);
          await unlink(alias);
          await symlink(outside, alias);
          return prepared;
        });
        try {
          const workspace_id = workspaceId(opened);
          if (operation === "read") {
            expect(await textCall(peer, "ssh_read_file", { workspace_id, file_path: "alias/value.txt" })).toBe("     1\tinside");
          } else {
            await textCall(peer, "ssh_write_file", { workspace_id, file_path: "alias/new.txt", content: "new inside\n" });
            expect(await readFile(join(root, "inside/new.txt"), "utf8")).toBe("new inside\n");
            expect(await stat(join(outside, "new.txt")).catch(() => null)).toBeNull();
          }
          expect(await readFile(join(outside, "value.txt"), "utf8")).toBe("outside\n");
        } finally { hook.mockRestore(); }
      } finally {
        await peer.close();
        await runtime.close();
      }
    }, 15000);
  }

  test("uploads pause before transfer and downloads deliver changed guidance with the file", async () => {
    const root = await project({ "AGENTS.md": "Transfer root rule.\n", "assets/AGENTS.md": "Review new assets.\n" });
    const { id } = await open(root);
    const localPath = join(fixture.transfers, "workspace-upload.bin");
    const args = { workspace_id: id, localPath, remotePath: "assets/data.bin" };
    const paused = await call("ssh_upload", args, true);
    expect(paused).toStartWith("Error: WORKSPACE_RULES_CHANGED\n");
    expect(paused).toContain("Review new assets.");
    expect(await stat(join(root, "assets/data.bin")).catch(() => null)).toBeNull();
    const failed = await call("ssh_upload", args, true);
    expect(failed).not.toContain("Review new assets.");
    const bytes = Buffer.from([0, 1, 2, 128, 255]);
    await writeFile(localPath, bytes);
    const uploaded = await call("ssh_upload", args);
    expect(uploaded).toContain(`to ${root}/assets/data.bin (5 bytes).`);
    expect(uploaded).not.toContain("Review new assets.");
    expect(uploaded).not.toContain("Transfer root rule.");
    expect(await readFile(join(root, "assets/data.bin"))).toEqual(bytes);
    const downloaded = join(fixture.transfers, "workspace-download.bin");
    const download = await call("ssh_download", { workspace_id: id, localPath: downloaded, remotePath: "data.bin", cwd: "assets" });
    expect(download).not.toContain("Review new assets.");
    expect(download).toContain(`Downloaded ${root}/assets/data.bin to ${downloaded}`);
    expect(await readFile(downloaded)).toEqual(bytes);
    await writeFile(join(root, "assets/AGENTS.md"), "Download revised assets carefully.\n");
    const refreshed = await call("ssh_download", { workspace_id: id, localPath: downloaded, remotePath: "data.bin", cwd: "assets", overwrite: true });
    expect(refreshed).toContain("Download revised assets carefully.\n");
    expect(await call("ssh_bash", { workspace_id: id, cwd: "assets", command: "pwd" })).toBe(join(root, "assets") + "\n");
    const escaped = join(fixture.workspace, "escaped-upload.bin");
    await call("ssh_upload", { ...args, remotePath: escaped }, true);
    expect(await stat(escaped).catch(() => null)).toBeNull();
  });

  test("discovers only root and explicitly shared skills while retaining scoped AGENTS instructions", async () => {
    const root = await project({
      ".agents/skills/check/SKILL.md": "---\nname: check\ndescription: Root checks.\n---\nRoot body.\n",
      ".claude/skills/check/SKILL.md": "---\nname: check\ndescription: Alternate root checks.\n---\nAlternate root body.\n",
      "src/.agents/skills/check/SKILL.md": "---\nname: check\ndescription: Source checks.\n---\nSource body.\n",
      "src/.claude/skills/nested/SKILL.md": "---\nname: nested\ndescription: Nested Claude checks.\n---\nNested Claude body.\n",
      "src/AGENTS.md": "Source AGENTS guidance still applies.\n",
      ".agents/skills/invalid/SKILL.md": "---\nname: incomplete\n---\nMissing description.\n",
    });
    const shared = await project({ "check/SKILL.md": "---\nname: check\ndescription: Shared checks.\n---\nShared body.\n" });
    const opened = await call("ssh_workspace_open", { connection_id: connectionId, path: root, skill_directories: [".agents/skills", ".claude/skills", shared] });
    const id = workspaceId(opened);
    expect(opened).toContain("Root checks.");
    expect(opened).toContain("Alternate root checks.");
    expect(opened).toContain("Shared checks.");
    expect(opened).not.toContain("Source checks.");
    expect(opened).not.toContain("Nested Claude checks.");
    expect(opened).toContain("Warning: Skill metadata is invalid or missing name/description:");
    const rootSkill = selectedSkill(opened, "Root checks.");
    const alternateSkill = selectedSkill(opened, "Alternate root checks.");
    const sharedSkill = selectedSkill(opened, "Shared checks.");
    expect(new Set([rootSkill, alternateSkill, sharedSkill]).size).toBe(3);
    expect(rootSkill).toBe("project@check");
    expect(alternateSkill).toBe("project@check-2");
    expect(sharedSkill).toBe("shared@check");
    const source = await call("ssh_bash", { workspace_id: id, cwd: "src", command: "pwd" });
    expect(source).toContain("Source AGENTS guidance still applies.\n");
    expect(source).not.toContain("Root checks.");
    expect(source).not.toContain("Source checks.");
    expect(source).not.toContain("Nested Claude checks.");
    expect(source).not.toContain("src@check");
    expect(await call("ssh_skill_read", { workspace_id: id, skill_name: "nested" }, true)).toStartWith("Error: SKILL_NOT_FOUND\n");
    expect(await call("ssh_skill_read", { workspace_id: id, skill_name: "check" }, true)).toStartWith("Error: SKILL_AMBIGUOUS\n");
    expect(await call("ssh_skill_read", { workspace_id: id, skill_name: rootSkill })).toContain("Root body.");
    expect(await call("ssh_skill_read", { workspace_id: id, skill_name: alternateSkill })).toContain("Alternate root body.");
    expect(await call("ssh_skill_read", { workspace_id: id, skill_name: sharedSkill })).toContain("Shared body.");
    await unlink(join(root, ".agents/skills/check/SKILL.md"));
    await writeFile(join(root, ".claude/skills/check/SKILL.md"), "---\nname: missing-description\n---\nInvalid now.\n");
    const rebuilt = await call("ssh_workspace_open", { connection_id: connectionId, path: root, skill_directories: [".agents/skills", ".claude/skills", shared] });
    expect(workspaceId(rebuilt)).toBe(id);
    expect(rebuilt).not.toContain("Root checks.");
    expect(rebuilt).not.toContain("Alternate root checks.");
    for (const skill_name of [rootSkill, alternateSkill]) expect(await call("ssh_skill_read", { workspace_id: id, skill_name }, true)).toStartWith("Error: SKILL_NOT_FOUND\n");
    const remaining = selectedSkill(rebuilt, "Shared checks.");
    expect(remaining).toBe("check");
    expect(await call("ssh_skill_read", { workspace_id: id, skill_name: remaining })).toContain("Shared body.");
  });

  test("ordinary operations keep the opened catalog and reopening rebuilds names from the current sources", async () => {
    const root = await project({
      ".agents/skills/check/SKILL.md": "---\nname: check\ndescription: Original checks.\n---\nOriginal body.\n",
    });
    const opened = await open(root);
    const name = selectedSkill(opened.text, "Original checks.");
    expect(name).toBe("check");
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: name })).toContain("Original body.");
    const replacement = join(root, ".claude/skills/check/SKILL.md");
    await mkdir(dirname(replacement), { recursive: true });
    await writeFile(replacement, "---\nname: check\ndescription: Replacement checks.\n---\nReplacement body.\n");
    expect(await call("ssh_bash", { workspace_id: opened.id, command: "pwd" })).toBe(root + "\n");
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: "project@check" }, true)).toStartWith("Error: SKILL_NOT_FOUND\n");
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: name })).toContain("Original body.");
    const added = await open(root);
    expect(added.id).toBe(opened.id);
    const original = selectedSkill(added.text, "Original checks.");
    const replacementName = selectedSkill(added.text, "Replacement checks.");
    expect(original).toBe("project@check");
    expect(replacementName).toBe("project@check-2");
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: original })).toContain("Original body.");
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: replacementName })).toContain("Replacement body.");
    await unlink(join(root, ".agents/skills/check/SKILL.md"));
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: original }, true)).not.toContain("Replacement body.");
    const reopened = await open(root);
    expect(reopened.id).toBe(opened.id);
    expect(selectedSkill(reopened.text, "Replacement checks.")).toBe("check");
    expect(await call("ssh_skill_read", { workspace_id: reopened.id, skill_name: "check" })).toContain("Replacement body.");
  });

  test("encoded names and source qualifiers remain distinct and cannot select arbitrary paths", async () => {
    const root = await project({
      ".agents/skills/first @%/SKILL.md": "---\nname: check@source\ndescription: First checks.\n---\nFirst body.\n",
    });
    const opened = await open(root);
    const name = selectedSkill(opened.text, "First checks.");
    expect(name).toBe("check%40source");
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: name })).toContain("First body.");
    const secondPath = join(root, ".claude/skills/second/SKILL.md");
    await mkdir(dirname(secondPath), { recursive: true });
    await writeFile(secondPath, "---\nname: check@source\ndescription: Second checks.\n---\nSecond body.\n");
    const reopened = await open(root);
    expect(reopened.id).toBe(opened.id);
    const first = selectedSkill(reopened.text, "First checks.");
    const second = selectedSkill(reopened.text, "Second checks.");
    expect(first).toBe("project@check%40source");
    expect(second).toBe("project@check%40source-2");
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: first })).toContain("First body.");
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: second })).toContain("Second body.");
    for (const selected of ["check@source", "/etc/check", "../../outside/check"]) {
      expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name: selected }, true)).toStartWith("Error: SKILL_NOT_FOUND\n");
    }
  });

  test("contains skill resources and rejects manifest or directory redirection", async () => {
    const root = await project({ ".agents/skills/check/SKILL.md": "---\nname: check\ndescription: Check project files.\n---\nRun scripts/check.sh.\n",
      ".agents/skills/check/scripts/check.sh": "printf 'check passed\\n'\n", "private.txt": "not a skill resource\n" });
    const skillRoot = join(root, ".agents/skills/check");
    await symlink(join(root, "private.txt"), join(skillRoot, "escape.txt"));
    const opened = await open(root);
    const skill_name = selectedSkill(opened.text, "Check project files.");
    for (const resource of ["../../../private.txt", "escape.txt", join(root, "private.txt")]) await call("ssh_skill_read", { workspace_id: opened.id, skill_name, resource }, true);
    expect(await call("ssh_skill_read", { workspace_id: opened.id, skill_name, resource: "scripts/check.sh" })).toContain("printf 'check passed\\n'\n");
    expect(await call("ssh_bash", { workspace_id: opened.id, command: "bash .agents/skills/check/scripts/check.sh" })).toBe("check passed\n");
    for (const swap of ["manifest", "directory"]) {
      const target = await project({ ".agents/skills/check/SKILL.md": "---\nname: check\ndescription: Original skill.\n---\nOriginal body.\n" });
      const outside = await project({ "SKILL.md": "Outside content must not become the selected skill.\n" });
      const context = await open(target);
      const selected = selectedSkill(context.text, "Original skill.");
      const directory = join(target, ".agents/skills/check");
      if (swap === "manifest") {
        await unlink(join(directory, "SKILL.md"));
        await symlink(join(outside, "SKILL.md"), join(directory, "SKILL.md"));
      } else {
        await rename(directory, directory + "-original");
        await symlink(outside, directory);
      }
      expect(await call("ssh_skill_read", { workspace_id: context.id, skill_name: selected }, true)).not.toContain("Outside content must not become the selected skill.");
    }
  });
});

describe("remote development lifecycle", () => {
  test("paged reads stay usable when the skill catalog outgrows the response budget", async () => {
    const root = await project({ "AGENTS.md": "Root rule.\n", "src/AGENTS.md": "Source rule.\n", "src/value.txt": "first\nsecond\n",
      ".agents/skills/check/SKILL.md": "---\nname: check\ndescription: Original catalog entry.\n---\nOriginal skill body.\n" });
    const runtime = new Runtime({ ...fixture.config, maxFileBytes: 1024 });
    const peer = new Client({ name: "read-guidance-budget-test", version: "1" });
    try {
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await createServer(runtime).connect(remote);
      await peer.connect(local);
      const connected = await textCall(peer, "ssh_connect", { host: "fixture" });
      const opened = await textCall(peer, "ssh_workspace_open", { connection_id: connected.slice("Connection: ".length), path: root });
      const id = workspaceId(opened);
      const selected = selectedSkill(opened, "Original catalog entry.");
      for (let index = 0; index < 127; index++) {
        const directory = join(root, `.agents/skills/extra-${index}`);
        await mkdir(directory);
        await writeFile(join(directory, "SKILL.md"), `---\nname: extra-${index}\ndescription: ${"a".repeat(950)}\n---\n`);
      }
      expect(await textCall(peer, "ssh_workspace_open", { connection_id: connected.slice("Connection: ".length), path: root }, true)).toContain("transport byte budget");
      const first = await textCall(peer, "ssh_read_file", { workspace_id: id, file_path: "src/value.txt", limit: 1 });
      expect(first).toContain("Source rule.\n");
      expect(first).toContain("Use offset=2 to continue.");
      expect(first).not.toContain("Root rule.\n");
      const second = await textCall(peer, "ssh_read_file", { workspace_id: id, file_path: "src/value.txt", offset: 2, limit: 1 });
      expect(second).toBe("     2\tsecond");
      expect(await textCall(peer, "ssh_skill_read", { workspace_id: id, skill_name: selected })).toContain("Original skill body.");
    } finally {
      await peer.close();
      await runtime.close();
    }
  }, 15000);

  test("a complete bounded catalog uses the active response budget and oversize discovery fails explicitly", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 128; index++) {
      files[`.agents/skills/check-${index}/SKILL.md`] = `---\nname: check-${index}\ndescription: ${"a".repeat(950)}\n---\n` + (index === 0 ? "body ".repeat(30) : "");
    }
    const root = await project(files);
    const runtime = new Runtime(fixture.config);
    const limited = new Runtime({ ...fixture.config, maxFileBytes: 1024 });
    try {
      const connection = await runtime.ssh.connect({ host: "fixture" });
      const id = connection.connection_id;
      expect(typeof id).toBe("string");
      if (typeof id !== "string") throw new Error("Missing fixture connection handle");
      const opened = await runtime.workspaces.open(id, root, [".agents/skills"]);
      const text = contextText(opened);
      runtime.workspaces.delivered(opened);
      expect(opened.skills).toHaveLength(128);
      expect(opened.warnings).toEqual([]);
      expect(text).not.toContain("body body body");
      const smallConnection = await limited.ssh.connect({ host: "fixture" });
      if (typeof smallConnection.connection_id !== "string") throw new Error("Missing fixture connection handle");
      await expect(limited.workspaces.open(smallConnection.connection_id, root, [".agents/skills"]))
        .rejects.toThrow("Workspace response exceeds the transport byte budget");
      const reduced = await limited.workspaces.open(smallConnection.connection_id, root, []);
      expect(reduced.skills).toEqual([]);
      expect(reduced.root).toBe(root);
    } finally {
      await runtime.close();
      await limited.close();
    }
  }, 15000);

  test("lazy metadata reads do not bypass the configured limit for full skill content", async () => {
    const root = await project({
      ".agents/skills/large/SKILL.md": "---\nname: large\ndescription: Large body check.\n---\n" + "body ".repeat(250),
      ".agents/skills/small/SKILL.md": "---\nname: small\ndescription: Small body check.\n---\nSmall body.\n",
    });
    const runtime = new Runtime({ ...fixture.config, maxFileBytes: 1024 });
    try {
      const connection = await runtime.ssh.connect({ host: "fixture" });
      if (typeof connection.connection_id !== "string") throw new Error("Missing fixture connection handle");
      const opened = await runtime.workspaces.open(connection.connection_id, root, [".agents/skills"]);
      const text = contextText(opened);
      runtime.workspaces.delivered(opened);
      expect(opened.skills).toHaveLength(2);
      expect(text).not.toContain("body body body");
      const oversized = opened.skills.find((skill) => skill.name === "large")!;
      await expect(runtime.workspaces.skill(opened.workspace_id, oversized.callName, "SKILL.md")).rejects.toThrow("maxFileBytes");
      const ordinary = opened.skills.find((skill) => skill.name === "small")!;
      expect((await runtime.workspaces.skill(opened.workspace_id, ordinary.callName, "SKILL.md")).content).toEndWith("Small body.\n");
    } finally { await runtime.close(); }
  }, 15000);

  test("completes read, edit, test, and diff while preserving pre-existing user changes", async () => {
    const root = await project({ "AGENTS.md": "Run bash scripts/check.sh after changing the message.\n", "src/AGENTS.md": "Keep the message on one line.\n",
      "src/message.txt": "before\n", "user-notes.txt": "committed notes\n",
      "scripts/check.sh": "test \"$(cat src/message.txt)\" = after || exit 1\nprintf 'checks passed\\n'\n" });
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Fixture baseline"]);
    await writeFile(join(root, "user-notes.txt"), "user's unfinished notes\n");
    const opened = await open(root);
    expect(opened.text).toContain(`Git root: ${root}; branch: main`);
    expect(opened.text).toContain("user-notes.txt");
    expect(await call("ssh_read_file", { workspace_id: opened.id, file_path: "src/message.txt" })).toStartWith("     1\tbefore");
    await call("ssh_edit_file", { workspace_id: opened.id, file_path: "src/message.txt", old_string: "before", new_string: "after" });
    expect(await call("ssh_bash", { workspace_id: opened.id, command: "bash scripts/check.sh" })).toBe("checks passed\n");
    const diff = await call("ssh_bash", { workspace_id: opened.id, command: "git diff --check && git diff -- src/message.txt" });
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
    expect(await readFile(join(root, "user-notes.txt"), "utf8")).toBe("user's unfinished notes\n");
    const reopened = await open(root);
    expect(reopened.id).toBe(opened.id);
    expect(reopened.text).toContain("src/message.txt");
    expect(reopened.text).toContain("user-notes.txt");
  }, 15000);

  test("retired connections invalidate handles across a fresh connection", async () => {
    const root = await project({ "value.txt": "reconnect\n" });
    const { id } = await open(root);
    await call("ssh_close", { connection_id: connectionId });
    const oldConnection = connectionId;
    connectionId = (await call("ssh_connect", { host: "fixture" })).slice("Connection: ".length);
    expect(connectionId).not.toBe(oldConnection);
    await call("ssh_read_file", { workspace_id: id, file_path: "value.txt" }, true);
    await call("ssh_bash", { workspace_id: id, command: "pwd" }, true);
    const reopened = await open(root);
    expect(reopened.id).not.toBe(id);
    expect(await call("ssh_read_file", { workspace_id: reopened.id, file_path: "value.txt" })).toEndWith("     1\treconnect");
  }, 15000);
});

/** Model protocol responses without coupling state tests to SSH's private connection representation. */
class ContextTransport {
  readonly available = new Set(["00000001"]);
  readonly requests: string[] = [];
  rules: Instruction[] = [];
  skillFiles: { path: string; scope: string; content: string }[] = [];
  malformed = false;

  get(id: string): void {
    if (!this.available.has(id)) throw new ToolError("CONNECTION_NOT_FOUND", "Fixture connection was evicted");
  }

  sessions() { return { sessions: [...this.available].map((connection_id) => ({ connection_id })) }; }
  cwd(): string { return "/home/fixture"; }

  async run(_connectionId: string, operation: string, args: RemoteResult = {}): Promise<RemoteResult> {
    this.requests.push(operation);
    if (this.malformed) return { root: null };
    if (operation === "workspace_skill_read" && typeof args.path === "string") {
      const content = `Selected ${args.path}`;
      return { path: args.path, directory: posix.dirname(args.path), content,
        sha256: createHash("sha256").update(content).digest("hex"), resources: [], warnings: [] };
    }
    const root = typeof args.path === "string" && operation === "workspace_open" ? args.path : typeof args.root === "string" ? args.root : "/project";
    const paths = operation === "workspace_open" ? [root] : Array.isArray(args.paths)
      ? args.paths.filter((path): path is string => typeof path === "string").map((path) => posix.resolve(root, path)) : [root];
    const scopes = new Set([root]);
    for (const path of paths) {
      for (let scope = path; scope !== root && scope !== "/"; scope = posix.dirname(scope)) scopes.add(scope);
    }
    return { root, paths, rule_scope_leaves: paths, instructions: this.rules.filter((rule) => scopes.has(rule.scope)),
      skill_files: operation === "workspace_open" ? this.skillFiles : [], project_files: [], git: null, warnings: [] };
  }
}

function rule(scope: string, content: string): Instruction {
  return { path: scope + "/AGENTS.md", scope, content, sha256: createHash("sha256").update(content).digest("hex") };
}

describe("bounded workspace state", () => {
  test("a mutation started before another response delivered its rules still needs a retry", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    transport.rules = [rule("/project/src", "Check generated files")];
    const scope = { workspace_id: opened.workspace_id };
    const reading = await manager.prepare(scope, "src/read");
    const writing = manager.prepare(scope, "src/write", undefined, "mutate");
    manager.delivered(reading.context!);
    const prepared = await writing;
    expect(manager.mutationNeedsReview(prepared)).toBe(true);
    expect(manager.guidance(prepared.context!)).toEqual({ updated: [], removed: [] });
    const retry = await manager.prepare(scope, "src/write", undefined, "mutate");
    expect(manager.mutationNeedsReview(retry)).toBe(false);
    await manager.open("00000001", "/project", []);
    expect(() => manager.mutationNeedsReview(retry)).toThrow("Reopen with ssh_workspace_open");
  });

  test("overlapping reads report guidance once and compare against intervening operation responses", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const scope = { workspace_id: opened.workspace_id };
    const original = rule("/project/src", "Original source rule");
    transport.rules = [original];
    const first = await manager.prepare(scope, "/project/src/file");
    const second = await manager.prepare(scope, "/project/src/file");
    expect(manager.guidance(first.context!).updated).toEqual([original]);
    manager.delivered(first.context!);
    expect(manager.guidance(second.context!)).toEqual({ updated: [], removed: [] });

    transport.rules = [rule("/project/src", "Refreshed source rule")];
    const refreshed = await manager.prepare(scope, "/project/src/file");
    manager.delivered(refreshed.context!);
    expect(manager.guidance(second.context!).updated).toEqual([original]);
    manager.delivered(second.context!);
    const next = await manager.prepare(scope, "/project/src/file");
    expect(manager.guidance(next.context!).updated).toEqual(transport.rules);
  });

  test("only successful delivery suppresses repeated guidance and old responses cannot update a reopened handle", async () => {
    const transport = new ContextTransport();
    transport.rules = [rule("/project", "Root rule")];
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    const scope = { workspace_id: opened.workspace_id };
    const first = await manager.prepare(scope, "/project/file");
    expect(manager.guidance(first.context!).updated).toEqual(transport.rules);
    manager.delivered(opened);
    expect(manager.guidance(first.context!)).toEqual({ updated: [], removed: [] });
    transport.rules.push(rule("/project/src", "Source rule"));
    const read = await manager.prepare(scope, "/project/src/file");
    const refreshed = await manager.open("00000001", "/project", []);
    manager.delivered(refreshed);
    manager.delivered(read.context!);
    const next = await manager.prepare(scope, "/project/src/file");
    expect(manager.guidance(next.context!).updated).toEqual([transport.rules[1]!]);
    const prepared = await manager.prepare(scope, "/project/src/file");
    expect(manager.guidance(next.context!).updated).toEqual([transport.rules[1]!]);
    manager.delivered(prepared.context!);
    expect(manager.guidance(next.context!)).toEqual({ updated: [], removed: [] });
    await expect(manager.prepare(scope, "/project/src/file")).resolves.toMatchObject({ path: "/project/src/file" });
  });

  test("reopening during preparation invalidates the operation before it can execute", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const originalRun = transport.run.bind(transport);
    let resume: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const hook = spyOn(transport, "run").mockImplementation(async (connectionId, operation, args) => {
      if (operation === "workspace_context") await waiting;
      return originalRun(connectionId, operation, args);
    });
    try {
      const pending = manager.prepare({ workspace_id: opened.workspace_id }, "/project/file");
      manager.delivered(await manager.open("00000001", "/project", []));
      resume();
      await expect(pending).rejects.toMatchObject({ code: "WORKSPACE_REOPEN_REQUIRED" });
    } finally {
      resume();
      hook.mockRestore();
    }
  });

  test("completed operations do not return stale guidance after reopening or disconnecting", async () => {
    for (const change of ["reopen", "disconnect"]) {
      const transport = new ContextTransport();
      transport.rules = [rule("/project", "Original root rule")];
      const manager = new WorkspaceManager(transport);
      const opened = await manager.open("00000001", "/project", []);
      manager.delivered(opened);
      transport.rules.push(rule("/project/src", "Original source rule"));
      const prepared = await manager.prepare({ workspace_id: opened.workspace_id }, "/project/src/file");
      if (change === "reopen") {
        transport.rules = [rule("/project", "Replacement root rule")];
        manager.delivered(await manager.open("00000001", "/project", []));
      } else {
        transport.available.clear();
      }
      expect(manager.guidance(prepared.context!)).toEqual({ updated: [], removed: [] });
      manager.delivered(prepared.context!);
    }
  });

  test("preparation cannot succeed after a concurrent reopen has completed", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const originalRun = transport.run.bind(transport);
    const completed: string[] = [];
    let reopened: Promise<void> | undefined;
    const hook = spyOn(transport, "run").mockImplementation(async (connectionId, operation, args) => {
      const response = await originalRun(connectionId, operation, args);
      if (operation === "workspace_context") {
        reopened = manager.open("00000001", "/project", []).then(() => { completed.push("reopened"); });
      }
      return response;
    });
    try {
      await manager.prepare({ workspace_id: opened.workspace_id }, "/project/file").then(
        () => { completed.push("prepared"); },
        (error: unknown) => {
          expect(error).toMatchObject({ code: "WORKSPACE_REOPEN_REQUIRED" });
          completed.push("rejected");
        },
      );
      await reopened;
      expect(completed).not.toEqual(["reopened", "prepared"]);
    } finally { hook.mockRestore(); }
  });

  test("a skill read cannot return an old source after its workspace is reopened", async () => {
    const transport = new ContextTransport();
    transport.skillFiles = [{ path: "/project/.agents/skills/first/SKILL.md", scope: "/project", content: "name: check\ndescription: First checks.\n" }];
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const originalRun = transport.run.bind(transport);
    let resume: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const hook = spyOn(transport, "run").mockImplementation(async (connectionId, operation, args) => {
      const response = await originalRun(connectionId, operation, args);
      if (operation === "workspace_skill_read") await waiting;
      return response;
    });
    try {
      const pending = manager.skill(opened.workspace_id, "check", "SKILL.md");
      transport.skillFiles = [{ path: "/project/.claude/skills/second/SKILL.md", scope: "/project", content: "name: check\ndescription: Second checks.\n" }];
      manager.delivered(await manager.open("00000001", "/project", []));
      resume();
      await expect(pending).rejects.toMatchObject({ code: "WORKSPACE_REOPEN_REQUIRED" });
    } finally {
      resume();
      hook.mockRestore();
    }
  });

  test("a rejected reopen preserves previously delivered guidance and the skill catalog", async () => {
    const transport = new ContextTransport();
    transport.rules = [rule("/project", "Original root rule")];
    transport.skillFiles = [{ path: "/project/.agents/skills/check/SKILL.md", scope: "/project", content: "name: check\ndescription: Original checks.\n" }];
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const originalRun = transport.run.bind(transport);
    const hook = spyOn(transport, "run").mockImplementation(async (connectionId, operation, args) => {
      const response = await originalRun(connectionId, operation, args);
      return operation === "workspace_open" ? { ...response, paths: ["/outside/file"] } : response;
    });
    try {
      await expect(manager.open("00000001", "/project", [])).rejects.toMatchObject({ code: "WORKSPACE_PATH_CHANGED" });
    } finally { hook.mockRestore(); }
    const prepared = await manager.prepare({ workspace_id: opened.workspace_id }, "/project/file");
    expect(manager.guidance(prepared.context!)).toEqual({ updated: [], removed: [] });
    await expect(manager.skill(opened.workspace_id, "check", "SKILL.md")).resolves.toMatchObject({
      path: "/project/.agents/skills/check/SKILL.md",
    });
  });

  test("rejects ambiguous scopes and malformed wire results without publishing state", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    for (const scope of [{}, { connection_id: "00000001", workspace_id: "ws_00000001" }]) {
      await expect(manager.prepare(scope, ".")).rejects.toMatchObject({ code: "INVALID_SCOPE" });
      expect(() => manager.path(scope, ".")).toThrow(expect.objectContaining({ code: "INVALID_SCOPE" }));
    }
    expect(transport.requests).toEqual([]);
    transport.malformed = true;
    await expect(manager.open("00000001", "/project", [])).rejects.toThrow();
    transport.malformed = false;
    expect((await manager.open("00000001", "/project", [])).root).toBe("/project");
  });

  test("retired transport records do not prevent opening a new workspace", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    transport.available.delete("00000001");
    transport.available.add("00000002");
    await expect(manager.prepare({ workspace_id: opened.workspace_id }, "/project/file")).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    const reopened = await manager.open("00000002", "/project", []);
    expect(reopened.workspace_id).not.toBe(opened.workspace_id);
    await expect(manager.prepare({ workspace_id: opened.workspace_id }, "/project/file")).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  test("the workspace budget permits reuse and retires disconnected entries before admission", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const first = await manager.open("00000001", "/project-0", []);
    for (let index = 1; index < 128; index++) await manager.open("00000001", `/project-${index}`, []);
    expect((await manager.open("00000001", "/project-0", [])).workspace_id).toBe(first.workspace_id);
    await expect(manager.open("00000001", "/overflow", [])).rejects.toMatchObject({ code: "WORKSPACE_LIMIT" });
    transport.available.clear();
    transport.available.add("00000002");
    expect((await manager.open("00000002", "/overflow", [])).connection_id).toBe("00000002");
  });

  test("opening registers skills only after delivery and ordinary operations leave the catalog unchanged", async () => {
    const transport = new ContextTransport();
    transport.skillFiles = [{ path: "/project/.agents/skills/original/SKILL.md", scope: "/project", content: "name: original\ndescription: Original checks.\n" }];
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    const requests = transport.requests.length;
    await expect(manager.skill(opened.workspace_id, "original", "SKILL.md")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    expect(transport.requests).toHaveLength(requests);
    manager.delivered(opened);
    await expect(manager.skill(opened.workspace_id, "original", "SKILL.md")).resolves.toMatchObject({
      path: "/project/.agents/skills/original/SKILL.md",
    });

    transport.skillFiles = [{ path: "/project/.claude/skills/replacement/SKILL.md", scope: "/project", content: "name: replacement\ndescription: Replacement checks.\n" }];
    const prepared = await manager.prepare({ workspace_id: opened.workspace_id }, "/project/file");
    expect(prepared.context!.skills).toEqual([]);
    manager.delivered(prepared.context!);
    await expect(manager.skill(opened.workspace_id, "original", "SKILL.md")).resolves.toMatchObject({
      path: "/project/.agents/skills/original/SKILL.md",
    });
    await expect(manager.skill(opened.workspace_id, "replacement", "SKILL.md")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });

    const reopened = await manager.open("00000001", "/project", []);
    expect(reopened.workspace_id).toBe(opened.workspace_id);
    await expect(manager.skill(opened.workspace_id, "replacement", "SKILL.md")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    manager.delivered(reopened);
    expect(reopened.skills.map((skill) => skill.callName)).toEqual(["replacement"]);
    await expect(manager.skill(opened.workspace_id, "original", "SKILL.md")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    await expect(manager.skill(opened.workspace_id, "replacement", "SKILL.md")).resolves.toMatchObject({
      path: "/project/.claude/skills/replacement/SKILL.md",
    });
  });

  test("an older open response cannot replace a reopened project's skill catalog", async () => {
    const transport = new ContextTransport();
    transport.skillFiles = [{ path: "/project/.agents/skills/first/SKILL.md", scope: "/project", content: "name: check\ndescription: First checks.\n" }];
    const manager = new WorkspaceManager(transport);
    const first = await manager.open("00000001", "/project", []);
    transport.skillFiles = [{ path: "/project/.claude/skills/second/SKILL.md", scope: "/project", content: "name: check\ndescription: Second checks.\n" }];
    const second = await manager.open("00000001", "/project", []);
    expect(second.workspace_id).toBe(first.workspace_id);
    expect(first.skills[0]!.callName).toBe("check");
    expect(second.skills[0]!.callName).toBe("check");
    manager.delivered(second);
    manager.delivered(first);
    await expect(manager.skill(second.workspace_id, "check", "SKILL.md")).resolves.toMatchObject({
      path: "/project/.claude/skills/second/SKILL.md",
    });
  });

  test("open catalogs disambiguate colliding source prefixes without exposing storage paths", async () => {
    const transport = new ContextTransport();
    transport.skillFiles = [
      { path: "/project/.agents/skills/check/SKILL.md", scope: "/project", content: "name: check\ndescription: Project checks.\n" },
      { path: "/shared-a/skills/check/SKILL.md", scope: "/project", content: "name: check\ndescription: First shared checks.\n" },
      { path: "/shared-b/skills/check/SKILL.md", scope: "/project", content: "name: check\ndescription: Second shared checks.\n" },
    ];
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const names = opened.skills.map((skill) => skill.callName);
    expect(names).toEqual(["project@check", "shared@check", "shared@check-2"]);
    expect(contextText(opened)).not.toContain("/shared-a");
    for (const [index, name] of names.entries()) {
      await expect(manager.skill(opened.workspace_id, name, "SKILL.md")).resolves.toMatchObject({ path: transport.skillFiles[index]!.path });
    }
    transport.skillFiles = [{ path: "/shared-c/skills/check/SKILL.md", scope: "/project", content: "name: check\ndescription: Third shared checks.\n" }];
    const reopened = await manager.open("00000001", "/project", []);
    expect(reopened.workspace_id).toBe(opened.workspace_id);
    expect(reopened.skills.map((skill) => skill.callName)).toEqual(["check"]);
    manager.delivered(reopened);
    for (const name of names) await expect(manager.skill(opened.workspace_id, name, "SKILL.md")).rejects.toMatchObject({ code: "SKILL_NOT_FOUND" });
    await expect(manager.skill(opened.workspace_id, "check", "SKILL.md")).resolves.toMatchObject({ path: "/shared-c/skills/check/SKILL.md" });
  });

  test("instruction history exhaustion requires reopening instead of silently dropping rule state", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    transport.rules = Array.from({ length: 2048 }, (_, index) => ({ ...rule("/project/a", `Rule ${index}`), path: `/project/a/rule-${index}/AGENTS.md` }));
    const filled = await manager.prepare({ workspace_id: opened.workspace_id }, "/project/a/file");
    manager.delivered(filled.context!);
    transport.rules = [];
    const originalRun = transport.run.bind(transport);
    let resume: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const hook = spyOn(transport, "run").mockImplementation(async (connectionId, operation, args) => {
      const response = await originalRun(connectionId, operation, args);
      if (operation === "workspace_context" && (args?.paths as string[])?.includes("/project/a/file")) await waiting;
      return response;
    });
    try {
      const pending = manager.prepare({ workspace_id: opened.workspace_id }, "/project/a/file");
      transport.rules = [rule("/project/b", "Another scope")];
      const overflowing = await manager.prepare({ workspace_id: opened.workspace_id }, "/project/b/file");
      manager.delivered(overflowing.context!);
      resume();
      await expect(pending).rejects.toMatchObject({
        code: "WORKSPACE_REOPEN_REQUIRED", message: expect.stringContaining("Instruction delivery history is full"),
      });
    } finally {
      resume();
      hook.mockRestore();
    }
    transport.rules = [];
    const reopened = await manager.open("00000001", "/project", []);
    manager.delivered(reopened);
    await expect(manager.prepare({ workspace_id: reopened.workspace_id }, "/project/a/file")).resolves.toMatchObject({ path: "/project/a/file" });
  });
});

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
import { WaitBudget } from "../src/ssh/wait-queue";
import { WorkspaceManager } from "../src/workspaces/manager";
import { MAX_KNOWN_RULES } from "../src/workspaces/rules";
import { contextText } from "../src/workspaces/text";
import type { Instruction, RuleAcknowledgment } from "../src/workspaces/types";
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

/** Read the acknowledgement from the review the client actually received. */
function acknowledgement(review: string): { workspace_rules_ack: RuleAcknowledgment } {
  const array = /^"workspace_rules_ack": (\[.*\])$/m.exec(review);
  if (array) {
    const tokens: unknown = JSON.parse(array[1]!);
    if (!Array.isArray(tokens) || !tokens.length || !tokens.every(token => typeof token === "string" && /^[a-f0-9]{64}$/.test(token))) {
      throw new Error("Expected an array of rule receipts");
    }
    return { workspace_rules_ack: tokens };
  }
  const single = /^workspace_rules_ack: ([a-f0-9]{64})$/m.exec(review);
  expect(single, review.slice(0, 2048)).not.toBeNull();
  return { workspace_rules_ack: single![1]! };
}

async function pausedAccess(peer: Client, name: "ssh_read_file" | "ssh_download", args: Record<string, unknown>, guidance: string): Promise<string> {
  const response = await textCall(peer, name, args, true);
  expect(response).toStartWith("Error: WORKSPACE_RULES_CHANGED\n");
  expect(response).toContain(name === "ssh_read_file" ? "The file was not read." : "The file was not downloaded.");
  expect(response).toMatch(/retry/i);
  expect(response).toContain(guidance);
  return response;
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

async function open(root: string, reset = false): Promise<{ id: string; text: string }> {
  const text = await call("ssh_workspace_open", { connection_id: connectionId, path: root, ...(reset && { reread_rules: true }) });
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

  test("a single-code client reviews root-to-leaf rules and creates its file on the first retry", async () => {
    const root = await project({ "AGENTS.md": "Root rule.\n", "README.md": "readme", "backend/AGENTS.md": "Backend rule.\n",
      "backend/api/AGENTS.md": "API rule.\n", "frontend/AGENTS.md": "Frontend-only rule.\n" });
    const { id, text } = await open(root);
    const file_path = "backend/api/new/deep/file.txt";
    const response = await client.callTool({ name: "ssh_write_file", arguments: { workspace_id: id, file_path, content: "new file\n" } });
    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(2);
    const [result, guidance] = response.content;
    expect(result?.type === "text" ? result.text : "").toStartWith("Error: WORKSPACE_RULES_CHANGED\n");
    const written = guidance?.type === "text" ? guidance.text : "";
    expect(written).toContain("Backend rule.\n");
    expect(written.indexOf("Backend rule.")).toBeLessThan(written.indexOf("API rule."));
    expect(written).toContain("Root rule.\n");
    expect(written.indexOf("Root rule.")).toBeLessThan(written.indexOf("Backend rule."));
    expect(written).not.toContain("Frontend-only rule.");
    expect(await stat(join(root, "backend/api/new")).catch(() => null)).toBeNull();
    // A v0.7.0 client reads one 64-character value from the first response block.
    const firstBlock = result?.type === "text" ? result.text : "";
    const legacy = /^workspace_rules_ack: ([a-f0-9]{64})$/m.exec(firstBlock);
    expect(legacy).not.toBeNull();
    const prefix = "workspace_rules_ack: ";
    const firstField = firstBlock.split("\n").find(line => line.startsWith(prefix));
    expect(firstField?.slice(prefix.length)).toBe(legacy![1]!);
    expect(await call("ssh_read_file", { workspace_id: id, file_path: "README.md", ...acknowledgement(text) })).toEndWith("\treadme");
    const repeated = await call("ssh_write_file", { workspace_id: id, file_path, content: "new file\n",
      workspace_rules_ack: legacy![1]! });
    expect(repeated).not.toContain("Backend rule.");
    expect(repeated).not.toContain("API rule.");
    expect(await readFile(join(root, file_path), "utf8")).toBe("new file\n");
    await writeFile(join(root, "backend/api/AGENTS.md"), "Revised API rule.\n");
    await pausedAccess(client, "ssh_read_file", { workspace_id: id, file_path, workspace_rules_ack: legacy![1]! }, "Revised API rule.");
  });

  test("new nested rules pause reads before recording a revision and explicit recovery resets confirmations", async () => {
    const root = await project({ "AGENTS.md": "Root rule.\n", "src/AGENTS.md": "Nested rule.\n", "src/value.txt": "before\n" });
    const original = await open(root);
    const args = { workspace_id: original.id, file_path: "src/value.txt" };
    const paused = await pausedAccess(client, "ssh_read_file", args, "Nested rule.\n");
    expect(paused).toContain("Root rule.\n");
    expect(paused).not.toContain("     1\tbefore");
    const edit = { ...args, old_string: "before", new_string: "after" };
    expect(await call("ssh_edit_file", edit, true)).toContain("WORKSPACE_RULES_CHANGED");
    const retry = await pausedAccess(client, "ssh_read_file", args, "Nested rule.\n");
    expect(retry).not.toContain("     1\tbefore");
    const malformed = await call("ssh_read_file", { ...args, workspace_rules_ack: "invalid" }, true);
    expect(malformed).not.toContain("     1\tbefore");
    const wrongToken = await pausedAccess(client, "ssh_read_file", { ...args, workspace_rules_ack: "0".repeat(64) }, "Nested rule.\n");
    expect(wrongToken).not.toContain("     1\tbefore");
    expect(await call("ssh_read_file", { ...args, ...acknowledgement(retry) })).toBe("     1\tbefore");
    await call("ssh_edit_file", edit);
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("after\n");
    const reopened = await open(root, true);
    expect(reopened.id).toBe(original.id);
    expect(reopened.text).not.toContain("Nested rule.");
    const write = { workspace_id: reopened.id, file_path: "src/new.txt", content: "new\n" };
    const afterReopen = await call("ssh_write_file", { ...write, ...acknowledgement(retry) }, true);
    expect(afterReopen).toContain("Nested rule.\n");
    expect(afterReopen).toContain("Root rule.\n");
    expect(acknowledgement(afterReopen)).not.toEqual(acknowledgement(retry));
    expect(await stat(join(root, "src/new.txt")).catch(() => null)).toBeNull();
    expect(await call("ssh_write_file", { ...write, ...acknowledgement(afterReopen) })).not.toContain("Nested rule.");
    await call("ssh_write_file", { workspace_id: reopened.id, file_path: "root.txt", content: "root guidance confirmed\n" });
    expect(await readFile(join(root, "src/new.txt"), "utf8")).toBe("new\n");
  });

  test("image reads return only the scoped guidance until the caller retries", async () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const root = await project({ "AGENTS.md": "Root image rule.\n", "src/AGENTS.md": "Source image rule.\n" });
    await writeFile(join(root, "src/preview.bin"), Buffer.from(base64, "base64"));
    const { id } = await open(root);
    const args = { workspace_id: id, file_path: "src/preview.bin" };
    const text = await pausedAccess(client, "ssh_read_file", args,
      `Project instructions: ${root}/src/AGENTS.md\nScope: ${root}/src\nSource image rule.\n`);
    expect(text).toContain("Root image rule.");
    expect(text).not.toContain(base64);
    const second = await client.callTool({ name: "ssh_read_file", arguments: { ...args, ...acknowledgement(text) } });
    expect(Boolean(second.isError)).toBe(false);
    expect(second.structuredContent).toBeUndefined();
    expect(second.content).toEqual([{ type: "image", data: base64, mimeType: "image/png" }]);
  });

  test("one open receipt covers parallel reads and a partially covered scope asks only for its extra rules", async () => {
    const root = await project({ "AGENTS.md": "Root guidance.\n", "a": "a", "b": "b", "c": "c",
      "docs/AGENTS.md": "Docs guidance.\n", "docs/page": "page" });
    const opened = await open(root);
    const ack = acknowledgement(opened.text);
    const read = (file_path: string) => ({ workspace_id: opened.id, file_path });
    // Discarding open's guidance still prevents a bare request from accessing the file.
    const bare = await pausedAccess(client, "ssh_read_file", read("a"), "Root guidance.");
    expect(bare).toContain("initial confirmation");
    expect(acknowledgement(bare)).toEqual(ack);
    const extra = await pausedAccess(client, "ssh_read_file", { ...read("docs/page"), ...ack }, "Docs guidance.");
    expect(extra).not.toContain("Root guidance.");
    expect(await call("ssh_read_file", { ...read("docs/page"), ...acknowledgement(extra) })).toEndWith("\tpage");
    const recovered = await open(root, true);
    const results = await Promise.all(["a", "b", "c"].map((path) =>
      call("ssh_read_file", { ...read(path), ...acknowledgement(recovered.text) })));
    expect(results).toEqual(["     1\ta", "     1\tb", "     1\tc"]);
  });

  test("a conditional read cannot reuse a confirmation after a rule changes back to its old text", async () => {
    const root = await project({ "AGENTS.md": "Version A\n", "data.txt": "contents\n" });
    const opened = await open(root);
    const args = { workspace_id: opened.id, file_path: "data.txt" };
    const a = acknowledgement(opened.text);
    expect(await call("ssh_read_file", { ...args, ...a })).toContain("contents");
    expect(await call("ssh_read_file", args)).toContain("contents");
    await writeFile(join(root, "AGENTS.md"), "Version B\n");
    await pausedAccess(client, "ssh_read_file", args, "Version B");
    await writeFile(join(root, "AGENTS.md"), "Version A\n");
    const review = await pausedAccess(client, "ssh_read_file", { ...args, ...a }, "Version A");
    expect(acknowledgement(review)).not.toEqual(a);
    expect(await call("ssh_read_file", { ...args, ...acknowledgement(review) })).toContain("contents");
  });

  test("workspace inspections and worker admission share the connection's 64 waiting slots", async () => {
    const root = await project({ value: "one file" });
    const runtime = new Runtime(fixture.config);
    const existing = new Set(fixture.commands);
    const workers = new AbortController();
    const inspections = new AbortController();
    try {
      const id = (await runtime.ssh.connect({ host: "fixture" })).connection_id as string;
      const remote = [...fixture.commands].find(worker => !existing.has(worker))!;
      const opened = await runtime.workspaces.open(id, root, []);
      const scope = { workspace_id: opened.workspace_id };
      const path = join(root, "value");
      const read = { args: { requestedPath: path }, observe: () => 1 };
      expect(runtime.workspaces.reviewGuidance(await runtime.workspaces.prepare(scope, path, undefined, read))).toBeUndefined();

      // Hold real worker replies while a conditional read and seven ordinary reads occupy all slots.
      remote.stdout.pause();
      try {
        const hot = runtime.workspaces.prepare(scope, path, undefined, read);
        await Promise.all(Array.from({ length: 7 }, () => runtime.ssh.open(id, "stat", { path })));
        const queuedWorkers = Promise.allSettled(Array.from({ length: 32 }, () =>
          runtime.ssh.open(id, "stat", { path }, undefined, workers.signal)));
        const queuedInspections = Promise.allSettled(Array.from({ length: 32 }, () =>
          runtime.workspaces.prepare(scope, path, inspections.signal)));
        await expect(runtime.ssh.open(id, "stat", { path })).rejects.toMatchObject({ code: "CONNECTION_BUSY" });
        await expect(runtime.workspaces.prepare(scope, path)).rejects.toMatchObject({ code: "CONNECTION_BUSY" });
        workers.abort();
        expect((await queuedWorkers).every(outcome => outcome.status === "rejected" && outcome.reason.code === "OPERATION_CANCELLED")).toBe(true);
        const moved = Promise.allSettled(Array.from({ length: 32 }, () =>
          runtime.workspaces.prepare(scope, path, inspections.signal)));
        await expect(runtime.ssh.open(id, "stat", { path })).rejects.toMatchObject({ code: "CONNECTION_BUSY" });
        inspections.abort();
        expect([...(await moved), ...(await queuedInspections)].every(outcome =>
          outcome.status === "rejected" && outcome.reason.code === "OPERATION_CANCELLED")).toBe(true);
        remote.stdout.resume();
        expect((await hot).file?.value.content).toBe("one file");
      } finally { remote.stdout.resume(); }
    } finally {
      workers.abort();
      inspections.abort();
      await runtime.close();
    }
  }, 10000);

  test("open and Bash receipts can be combined and never confirm a rule omitted from those responses", async () => {
    const root = await project({ "AGENTS.md": "Root guidance.\n", "docs/AGENTS.md": "Docs guidance.\n", "docs/page": "page" });
    const first = await open(root);
    const read = { workspace_id: first.id, file_path: "docs/page" };
    const bash = { workspace_id: first.id, cwd: "docs", command: "printf ok" };
    const docs = await call("ssh_bash", bash);
    expect(docs).toContain("Docs guidance.");
    expect(docs).not.toContain("Root guidance.");
    const missing = await pausedAccess(client, "ssh_read_file", { ...read, ...acknowledgement(docs) }, "Root guidance.");
    expect(missing).not.toContain("Docs guidance.");
    const reset = await open(root, true);
    const current = await call("ssh_bash", bash);
    const receipts = [reset.text, current].flatMap(text => acknowledgement(text).workspace_rules_ack);
    expect(await call("ssh_read_file", { ...read, workspace_rules_ack: receipts })).toBe("     1\tpage");
  });

  test("a multi-rule response can confirm a root file and later confirm its subdirectory", async () => {
    const root = await project({ "AGENTS.md": "Project rule.\n", "README.md": "readme",
      "docs/AGENTS.md": "Docs rule.\n", "docs/guide.md": "guide" });
    const opened = await open(root);
    const read = (file_path: string) => ({ workspace_id: opened.id, file_path });
    const guide = read("docs/guide.md");
    const first = await pausedAccess(client, "ssh_read_file", guide, "Docs rule.");
    const ack = acknowledgement(first);
    expect(Array.isArray(ack.workspace_rules_ack)).toBe(true);
    expect(ack.workspace_rules_ack).toHaveLength(2);
    expect(ack.workspace_rules_ack).toEqual(expect.arrayContaining([acknowledgement(opened.text).workspace_rules_ack]));
    expect(await call("ssh_read_file", { ...read("README.md"), ...ack })).toEndWith("\treadme");
    const outstanding = await pausedAccess(client, "ssh_read_file", guide, "Docs rule.");
    expect(outstanding).not.toContain("Project rule.");
    expect(await call("ssh_read_file", { ...guide, ...ack })).toEndWith("\tguide");
  });

  test("a late command keeps its output without redisplaying superseded instructions", async () => {
    const root = await project({ "docs/AGENTS.md": "Use title case.\n", "docs/page": "page" });
    const { id } = await open(root);
    const bash = { workspace_id: id, cwd: "docs" };
    const started = join(root, "docs/started");
    const release = join(root, "docs/release");
    const slow = call("ssh_bash", { ...bash,
      command: "touch started; while [ ! -f release ]; do sleep 0.01; done; printf finished" });
    try {
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(started).exists()) && Date.now() < deadline) await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      await writeFile(join(root, "docs/AGENTS.md"), "Use sentence case.\n");
      const read = { workspace_id: id, file_path: "docs/page" };
      const updated = await pausedAccess(client, "ssh_read_file", read, "Use sentence case.");
      expect(await call("ssh_read_file", { ...read, ...acknowledgement(updated) })).toEndWith("\tpage");
    } finally {
      await writeFile(release, "ready");
    }
    expect(await slow).toBe("finished");
    expect(await call("ssh_bash", { ...bash, command: "printf done" })).toBe("done");
  }, 15000);

  test("line ending changes retain the receipt, and clearing an active rule reports its removal once", async () => {
    const root = await project({ "AGENTS.md": "Root guidance.\n", "docs/AGENTS.md": "   \n", "docs/page": "page" });
    const opened = await open(root);
    const read = { workspace_id: opened.id, file_path: "docs/page" };
    await writeFile(join(root, "AGENTS.md"), "Root guidance.\r\n");
    expect(await call("ssh_read_file", { ...read, ...acknowledgement(opened.text) })).toEndWith("\tpage");
    await writeFile(join(root, "AGENTS.md"), "\r\n");
    const removed = await open(root);
    expect(removed.text).toContain("Project instructions removed:");
    expect(await call("ssh_read_file", { ...read, ...acknowledgement(removed.text) })).toEndWith("\tpage");
    expect(await call("ssh_read_file", read)).toEndWith("\tpage");
  });

  test("a receipt from one file confirms the same rule on a sibling download", async () => {
    const root = await project({ "src/AGENTS.md": "Review the source directory.\n", "src/one": "first", "src/two": "second" });
    const { id } = await open(root);
    const one = { workspace_id: id, file_path: "src/one" };
    const two = { workspace_id: id, file_path: "src/two" };
    const first = await pausedAccess(client, "ssh_read_file", one, "Review the source directory.");
    const localPath = join(fixture.transfers, "sibling-acknowledged.txt");
    await call("ssh_download", { workspace_id: id, remotePath: two.file_path, localPath, ...acknowledgement(first) });
    expect(await readFile(localPath, "utf8")).toBe("second");
    expect(await call("ssh_read_file", one)).toBe("     1\tfirst");
  });

  test("ordinary reads omit catalogs and report only changed or removed rules", async () => {
    const root = await project({ "AGENTS.md": "Root rule.\n", "src/AGENTS.md": "Nested rule.\n", "src/value.txt": "before\n",
      ".agents/skills/check/SKILL.md": "---\nname: check\ndescription: Catalog must not repeat on reads.\n---\nBody.\n" });
    const opened = await open(root);
    expect(opened.text).toContain("Catalog must not repeat on reads.");
    const args = { workspace_id: opened.id, file_path: "src/value.txt" };
    const first = await pausedAccess(client, "ssh_read_file", args, "Nested rule.\n");
    expect(first).not.toContain("Revision:");
    expect(first).not.toContain("Catalog must not repeat on reads.");
    const reopened = await open(root);
    expect(reopened.id).toBe(opened.id);
    expect(reopened.text).toContain("Root rule.\n");
    expect(reopened.text).not.toContain("Nested rule.\n");
    expect(reopened.text).toContain("Catalog must not repeat on reads.");
    expect(await call("ssh_read_file", { ...args, ...acknowledgement(first) })).toBe("     1\tbefore");
    const refreshed = await open(root);
    expect(refreshed.text).not.toContain("Root rule.\n");
    expect(refreshed.text).not.toContain("workspace_rules_ack:");
    expect(await call("ssh_read_file", args)).toBe("     1\tbefore");

    await writeFile(join(root, "src/AGENTS.md"), "Changed nested rule.\n");
    const changed = await pausedAccess(client, "ssh_read_file", { ...args, ...acknowledgement(first) }, "Changed nested rule.\n");
    expect(changed).toContain("Previously shown guidance changed.");
    expect(changed).not.toContain("Root rule.\n");
    expect(changed).not.toContain("Nested rule.\n");

    await unlink(join(root, "src/AGENTS.md"));
    const removed = await pausedAccess(client, "ssh_read_file", { ...args, ...acknowledgement(changed) },
      `Project instructions removed: ${root}/src/AGENTS.md\nScope: ${root}/src`);
    expect(removed).not.toContain("Changed nested rule.\n");
    expect(await call("ssh_read_file", { ...args, ...acknowledgement(removed) })).toBe("     1\tbefore");
    await call("ssh_edit_file", { workspace_id: opened.id, file_path: "src/value.txt", old_string: "before", new_string: "after" });
  });

  test("a missing or binary file reports its read error only after guidance is delivered", async () => {
    for (const file of ["missing.txt", "binary.txt"]) {
      const root = await project({ "src/AGENTS.md": "Guidance that must reach the response.\n", "src/binary.txt": "\0binary" });
      const { id } = await open(root);
      const target = { workspace_id: id, file_path: "src/" + file };
      const review = await pausedAccess(client, "ssh_read_file", target, "Guidance that must reach the response.\n");
      const failed = await call("ssh_read_file", { ...target, ...acknowledgement(review) }, true);
      expect(failed).toMatch(file === "missing.txt" ? /no such file/i : /binary/i);
      expect(failed).not.toContain("Guidance that must reach the response.");
      const args = { workspace_id: id, file_path: "src/new.txt", content: "written" };
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

  test("a paused read skips formatting and a failed retry leaves the file unread", async () => {
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
      const args = { workspace_id: id, file_path: "src/value.txt" };
      try {
        const review = await pausedAccess(peer, "ssh_read_file", args, "Formatter delivery rule.\n");
        expect(hook).not.toHaveBeenCalled();
        const failed = await textCall(peer, "ssh_read_file", { ...args, ...acknowledgement(review) }, true);
        expect(failed).toContain("formatter fixture failure");
        expect(failed).not.toContain("Formatter delivery rule.");
        expect(hook).toHaveBeenCalledTimes(1);
      } finally { hook.mockRestore(); }
      expect(await textCall(peer, "ssh_edit_file", { ...args, old_string: "before", new_string: "after" }, true)).toContain("FILE_NOT_READ");
    } finally {
      await peer.close();
      await runtime.close();
    }
  }, 15000);

  test("workspace revisions follow the dispatch of the file read on both the cold and conditional paths", async () => {
    const root = await project({ value: "first" });
    const runtime = new Runtime(fixture.config);
    const peer = new Client({ name: "workspace-observation-order", version: "1" });
    try {
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await createServer(runtime).connect(remote);
      await peer.connect(local);
      const connected = await textCall(peer, "ssh_connect", { host: "fixture" });
      const connection_id = connected.slice("Connection: ".length);
      const opened = await textCall(peer, "ssh_workspace_open", { connection_id, path: root });
      const scoped = { workspace_id: workspaceId(opened), file_path: "value" };
      const direct = { connection_id, file_path: join(root, "value") };
      const run = runtime.ssh.run.bind(runtime.ssh);
      for (const hot of [false, true]) {
        const captured = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const hook = spyOn(runtime.ssh, "run").mockImplementation(async (...request) => {
          const result = await run(...request);
          if (request[1] === "workspace_read") {
            expect(Boolean(request[2]?.condition)).toBe(hot);
            captured.resolve();
            await resume.promise;
          }
          return result;
        });
        try {
          const delayed = textCall(peer, "ssh_read_file", scoped);
          await captured.promise;
          if (hot) await textCall(peer, "ssh_write_file", { ...direct, content: "third" });
          else {
            await textCall(peer, "ssh_read_file", direct);
            await writeFile(direct.file_path, "second");
          }
          resume.resolve();
          const result = await delayed;
          expect(result).toContain("1\tsecond");
          expect(result.includes("A later observation recorded different contents")).toBe(hot);
        } finally { resume.resolve(); hook.mockRestore(); }
      }
      await textCall(peer, "ssh_edit_file", { ...direct, old_string: "third", new_string: "verified" });
    } finally { await peer.close(); await runtime.close(); }
  }, 15000);

  test("image reads check guidance before fetching bytes and give the retried image its full response budget", async () => {
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
      let revision = "a".repeat(64);
      const hook = spyOn(runtime.ssh, "run").mockImplementation(async (...request) => {
        if (request[1] !== "read" && !(request[1] === "workspace_read" && request[2]?.condition)) return originalRun(...request);
        return { kind: "image", base64: image.data, mimeType: image.mimeType, path: join(root, "src/value.txt"),
          size: image.data.length / 4 * 3, sha256: revision };
      });
      try {
        const review = await pausedAccess(peer, "ssh_read_file", args, "图片规则仍需交付。\n");
        expect(hook.mock.calls.some((request) => request[1] === "read")).toBe(false);
        const fits = await peer.callTool({ name: "ssh_read_file", arguments: { ...args, ...acknowledgement(review) } });
        expect(Boolean(fits.isError)).toBe(false);
        expect(fits.content).toHaveLength(1);
        const returned = fits.content[0];
        expect(returned?.type).toBe("image");
        expect(returned?.type === "image" ? returned.data.length : 0).toBe(image.data.length);
        image.data += "AAAA";
        revision = "b".repeat(64);
        hook.mockClear();
        const rejected = await textCall(peer, "ssh_read_file", args, true);
        expect(rejected).toStartWith("Error: OPERATION_FAILED\n");
        expect(rejected).toContain("9 MiB MCP response budget");
        expect(rejected).not.toContain("图片规则仍需交付。");
        expect(hook.mock.calls.map(([, op]) => op)).toEqual(["workspace_read"]);
        expect(runtime.files.get(connected.slice("Connection: ".length), join(root, "src/value.txt"))?.sha256).toBe("a".repeat(64));
      } finally { hook.mockRestore(); }
    } finally {
      await peer.close();
      await runtime.close();
    }
  }, 15000);

  test("changed guidance pauses an edit and Bash still delivers guidance with its results", async () => {
    const root = await project({ "AGENTS.md": "Original root rule.\n", "src/value.txt": "before\n" });
    const { id } = await open(root);
    const read = { workspace_id: id, file_path: "src/value.txt" };
    const original = await pausedAccess(client, "ssh_read_file", read, "Original root rule.\n");
    await call("ssh_read_file", { ...read, ...acknowledgement(original) });
    await writeFile(join(root, "AGENTS.md"), "Changed root rule.\n");
    const edit = { workspace_id: id, file_path: "src/value.txt", old_string: "before", new_string: "after" };
    const review = await call("ssh_edit_file", edit, true);
    expect(review).toContain("Changed root rule.\n");
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("before\n");
    const edited = await call("ssh_edit_file", { ...edit, ...acknowledgement(review) });
    expect(edited).toContain(`The file ${root}/src/value.txt has been updated successfully.`);
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("after\n");
    expect(await call("ssh_bash", { workspace_id: id, command: "pwd" })).toBe(root + "\n");
    await writeFile(join(root, "AGENTS.md"), "Changed command rule.\n");
    const changed = await call("ssh_bash", { workspace_id: id, command: "printf side-effect > root-effect" });
    expect(changed).toContain("Changed command rule.\n");
    expect(await readFile(join(root, "root-effect"), "utf8")).toBe("side-effect");
    const afterBash = await pausedAccess(client, "ssh_read_file", read, "Changed command rule.\n");
    expect(afterBash).not.toContain("     1\tafter");
    await call("ssh_read_file", { ...read, ...acknowledgement(afterBash) });
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
    const failed = await call("ssh_edit_file", { ...edit, ...acknowledgement(review) }, true);
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
    const args = { workspace_id: id, file_path: "alias/value.txt" };
    const linked = await pausedAccess(client, "ssh_read_file", args, `Project instructions: ${root}/src/AGENTS.md\nScope: ${root}/src\n`);
    expect(await call("ssh_read_file", { ...args, ...acknowledgement(linked) })).toBe("     1\tbefore");
    await unlink(join(root, "src/AGENTS.md"));
    const edit = { workspace_id: id, file_path: "alias/value.txt", old_string: "before", new_string: "after" };
    const removed = await call("ssh_edit_file", edit, true);
    expect(removed).toContain(`Project instructions removed: ${root}/src/AGENTS.md\nScope: ${root}/src`);
    expect(await readFile(join(root, "src/value.txt"), "utf8")).toBe("before\n");
    await call("ssh_edit_file", { ...edit, ...acknowledgement(removed) });
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
    const intermediate = await pausedAccess(client, "ssh_read_file", { ...scope, file_path }, "Review intermediate files.");
    await call("ssh_read_file", { ...scope, file_path, ...acknowledgement(intermediate) });
    await unlink(join(root, "middle/AGENTS.md"));
    // Direct access to the same file does not traverse the intermediate directory.
    expect(await call("ssh_read_file", { ...scope, file_path: "final/value" })).not.toContain("instructions removed");
    const edit = { ...scope, file_path, old_string: "first", new_string: "second" };
    const paused = await call("ssh_edit_file", edit, true);
    expect(paused).toContain(`Project instructions removed: ${root}/middle/AGENTS.md`);
    expect(await readFile(join(root, "final/value"), "utf8")).toBe("first");
    expect(await call("ssh_edit_file", { ...edit, ...acknowledgement(paused) })).not.toContain("instructions removed");
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
    const firstReview = await pausedAccess(client, "ssh_read_file", { workspace_id: first.id, file_path: "src/value.txt" }, "First source rules.\n");
    expect(await call("ssh_read_file", { connection_id: connectionId, file_path: join(secondRoot, "src/value.txt") })).toBe("     1\tsecond");
    const secondArgs = { workspace_id: second.id, file_path: "src/new.txt", content: "second only" };
    const secondWrite = await call("ssh_write_file", { ...secondArgs, ...acknowledgement(firstReview) }, true);
    expect(secondWrite).toContain("WORKSPACE_RULES_CHANGED");
    expect(secondWrite).toContain("Second source rules.\n");
    expect(secondWrite).not.toContain("First source rules.");
    expect(await stat(join(secondRoot, "src/new.txt")).catch(() => null)).toBeNull();
    await call("ssh_write_file", { ...secondArgs, ...acknowledgement(secondWrite) });
    const firstArgs = { workspace_id: first.id, file_path: "src/new.txt", content: "first only" };
    const firstWrite = await call("ssh_write_file", firstArgs, true);
    expect(await call("ssh_write_file", { ...firstArgs, ...acknowledgement(firstWrite) })).not.toContain("First source rules.");
    expect(await readFile(join(firstRoot, "src/new.txt"), "utf8")).toBe("first only");
    expect(await readFile(join(secondRoot, "src/new.txt"), "utf8")).toBe("second only");
    expect(await call("ssh_bash", { workspace_id: first.id, command: "pwd" })).toBe(firstRoot + "\n");
    expect(await call("ssh_bash", { workspace_id: second.id, command: "pwd" })).toBe(secondRoot + "\n");
    expect(await call("ssh_bash", { connection_id: connectionId, command: "pwd" })).toBe(fixture.workspace + "\n");
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

  test("uploads and downloads pause before transfer even when the local destination already exists", async () => {
    const root = await project({ "AGENTS.md": "Transfer root rule.\n", "assets/AGENTS.md": "Review new assets.\n" });
    const { id } = await open(root);
    const localPath = join(fixture.transfers, "workspace-upload.bin");
    const args = { workspace_id: id, localPath, remotePath: "assets/data.bin" };
    const paused = await call("ssh_upload", args, true);
    expect(paused).toStartWith("Error: WORKSPACE_RULES_CHANGED\n");
    expect(paused).toContain("Review new assets.");
    expect(await stat(join(root, "assets/data.bin")).catch(() => null)).toBeNull();
    const failed = await call("ssh_upload", { ...args, ...acknowledgement(paused) }, true);
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
    const refresh = { workspace_id: id, localPath: downloaded, remotePath: "data.bin", cwd: "assets", overwrite: true };
    await writeFile(downloaded, "original local file");
    await pausedAccess(client, "ssh_download", refresh, "Download revised assets carefully.\n");
    const revised = await pausedAccess(client, "ssh_download", refresh, "Download revised assets carefully.\n");
    expect(await readFile(downloaded, "utf8")).toBe("original local file");
    expect(await call("ssh_download", { ...refresh, ...acknowledgement(revised) })).not.toContain("Download revised assets carefully.");
    expect(await readFile(downloaded)).toEqual(bytes);
    await unlink(join(root, "assets/AGENTS.md"));
    const freshPath = join(fixture.transfers, "workspace-new-download", "data.bin");
    const removed = await pausedAccess(client, "ssh_download", { ...refresh, localPath: freshPath, ...acknowledgement(revised) },
      `Project instructions removed: ${root}/assets/AGENTS.md\nScope: ${root}/assets`);
    expect(await stat(dirname(freshPath)).catch(() => null)).toBeNull();
    await call("ssh_download", { ...refresh, localPath: freshPath, ...acknowledgement(removed) });
    expect(await readFile(freshPath)).toEqual(bytes);
    expect(await call("ssh_bash", { workspace_id: id, cwd: "assets", command: "pwd" })).toBe(join(root, "assets") + "\n");
    const escaped = join(fixture.workspace, "escaped-upload.bin");
    await call("ssh_upload", { ...args, remotePath: escaped }, true);
    expect(await stat(escaped).catch(() => null)).toBeNull();
  });

  test("overlapping reads and downloads both report added and removed rules before touching their files", async () => {
    const root = await project({ "src/AGENTS.md": "Old rule.\n", "src/sub/read.txt": "report\n" });
    const runtime = new Runtime(fixture.config);
    const peer = new Client({ name: "concurrent-rule-delivery-test", version: "1" });
    try {
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await createServer(runtime).connect(remote);
      await peer.connect(local);
      const connected = await textCall(peer, "ssh_connect", { host: "fixture" });
      const opened = await textCall(peer, "ssh_workspace_open", { connection_id: connected.slice("Connection: ".length), path: root });
      const scope = { workspace_id: workspaceId(opened) };
      expect(await textCall(peer, "ssh_bash", { ...scope, cwd: "src", command: "pwd" })).toContain("Old rule.\n");
      const read = { ...scope, file_path: "src/sub/read.txt" };
      const oldRule = await pausedAccess(peer, "ssh_read_file", read, "Old rule.\n");
      await textCall(peer, "ssh_read_file", { ...read, ...acknowledgement(oldRule) });
      await unlink(join(root, "src/AGENTS.md"));
      await writeFile(join(root, "src/sub/AGENTS.md"), "Superseded rule.\n");
      const removed = `Project instructions removed: ${root}/src/AGENTS.md\nScope: ${root}/src`;
      const localPath = join(fixture.transfers, "racing-download", "pull.txt");
      const download = { ...scope, remotePath: "src/sub/pull.txt", localPath };
      const inspected = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = runtime.ssh.run.bind(runtime.ssh);
      const hook = spyOn(runtime.ssh, "run").mockImplementation(async (...request) => {
        const result = await original(...request);
        const paths = request[2]?.paths;
        if (request[1] === "workspace_context" && Array.isArray(paths) && paths.includes(join(root, download.remotePath))) {
          inspected.resolve();
          await release.promise;
        }
        return result;
      });
      try {
        const first = pausedAccess(peer, "ssh_download", download, "New rule.\n");
        await inspected.promise;
        await writeFile(join(root, "src/sub/AGENTS.md"), "New rule.\n");
        const newer = await pausedAccess(peer, "ssh_read_file", read, "New rule.\n");
        expect(newer).toContain(removed);
        expect(await textCall(peer, "ssh_read_file", { ...read, ...acknowledgement(newer) })).toBe("     1\treport");
        release.resolve();
        const delayed = await first;
        expect(delayed).toContain(removed);
        expect(delayed).not.toContain("Superseded rule.");
        acknowledgement(delayed);
      } finally { release.resolve(); hook.mockRestore(); }
      expect(await stat(dirname(localPath)).catch(() => null)).toBeNull();
      const missing = await textCall(peer, "ssh_download", download, true);
      expect(missing).toContain("Remote file does not exist");
      expect(missing).not.toContain("New rule.");
      expect(await stat(localPath).catch(() => null)).toBeNull();
      await writeFile(join(root, download.remotePath), "downloaded\n");
      await textCall(peer, "ssh_download", download);
      expect(await readFile(localPath, "utf8")).toBe("downloaded\n");
      expect(await textCall(peer, "ssh_read_file", read)).toBe("     1\treport");
    } finally {
      await peer.close();
      await runtime.close();
    }
  }, 15000);

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
      const args = { workspace_id: id, file_path: "src/value.txt", limit: 1 };
      const review = await pausedAccess(peer, "ssh_read_file", args, "Source rule.\n");
      const first = await textCall(peer, "ssh_read_file", { ...args, ...acknowledgement(review) });
      expect(first).not.toContain("Source rule.\n");
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
      const text = contextText(opened, runtime.workspaces.guidance(opened));
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
      const text = contextText(opened, runtime.workspaces.guidance(opened));
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
    const read = { workspace_id: opened.id, file_path: "src/message.txt" };
    const review = await pausedAccess(client, "ssh_read_file", read, "Keep the message on one line.\n");
    expect(await call("ssh_read_file", { ...read, ...acknowledgement(review) })).toStartWith("     1\tbefore");
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
  private readonly budgets = new Map<string, WaitBudget>();
  readonly requests: string[] = [];
  rules: Instruction[] = [];
  skillFiles: { path: string; scope: string; content: string }[] = [];
  malformed = false;

  get(id: string): { waitBudget: WaitBudget } {
    if (!this.available.has(id)) throw new ToolError("CONNECTION_NOT_FOUND", "Fixture connection was evicted");
    let budget = this.budgets.get(id);
    if (!budget) {
      budget = new WaitBudget();
      this.budgets.set(id, budget);
    }
    return { waitBudget: budget };
  }

  isReady(id: string): boolean { return this.available.has(id); }
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
  test("a dispatched conditional read precedes a reset, and cancelled inspections release their queue slots", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    transport.rules = [rule("/project", "root A")];
    const id = "00000001";
    const opened = await manager.open(id, "/project", []);
    const receipt = manager.guidance(opened).token!;
    manager.delivered(opened);
    const scope = { workspace_id: opened.workspace_id };
    const path = "/project/value";
    const read = { args: { requestedPath: "value" }, observe: () => 1 };
    const condition = "a".repeat(64);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const run = transport.run.bind(transport);
    const hook = spyOn(transport, "run").mockImplementation(async (id, op, args) => {
      if (args?.condition) {
        expect(op).toBe("workspace_read");
        expect(args.condition).toBe(condition);
        entered.resolve();
        await release.promise;
        return { path, content: "authorized" };
      }
      const data = await run(id, op, args);
      return op === "workspace_read" ? { ...data, read_condition: condition } : data;
    });
    try {
      expect(manager.reviewGuidance(await manager.prepare(scope, path, undefined, read), receipt)).toBeUndefined();
      const reading = manager.prepare(scope, path, undefined, read);
      await entered.promise;
      const controller = new AbortController();
      const waiters = Array.from({ length: 64 }, () => manager.prepare(scope, path, controller.signal));
      const outcomes = Promise.allSettled(waiters);
      await expect(manager.open(id, "/project", [], { rereadRules: true })).rejects.toMatchObject({ code: "CONNECTION_BUSY" });
      controller.abort();
      expect((await outcomes).every(outcome => outcome.status === "rejected" && outcome.reason.code === "OPERATION_CANCELLED")).toBe(true);
      const reset = manager.open(id, "/project", [], { rereadRules: true });
      expect(hook.mock.calls.some(([, op]) => op === "workspace_open")).toBe(false);
      release.resolve();
      expect((await reading).file).toEqual({ value: { path, content: "authorized" }, observation: 1 });
      manager.delivered(await reset);
      const afterReset = await manager.prepare(scope, path, undefined, read);
      expect(afterReset.file).toBeUndefined();
      expect(manager.reviewGuidance(afterReset, receipt)?.updated).toEqual(transport.rules);
    } finally {
      release.resolve();
      hook.mockRestore();
    }
  });
  test("a delayed rule cache hit uses only the rules offered with that inspection", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const root = rule("/project", "Root rule\n".repeat(40));
    const other = rule("/other", "Other rule\n".repeat(40));
    transport.rules = [root, other];
    const run = transport.run.bind(transport);
    const inspected = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remote = spyOn(transport, "run").mockImplementation(async (id, operation, args) => {
      const result = await run(id, operation, args);
      if (operation === "workspace_open") return result;
      if (args?.root === "/other") {
        expect(args.knownRules).toBeUndefined();
        return result;
      }
      inspected.resolve();
      expect(args?.knownRules).toEqual([root.sha256]);
      await release.promise;
      return { ...result, instructions: [{ path: root.path, scope: root.scope, sha256: root.sha256 }] };
    });
    try {
      const opened = await manager.open("00000001", "/project", []);
      const scope = { workspace_id: opened.workspace_id };
      const first = manager.prepare(scope, "one");
      await inspected.promise;
      const otherWorkspace = await manager.open("00000001", "/other", []);
      expect(manager.guidance(otherWorkspace).updated).toEqual([other]);
      release.resolve();
      expect(manager.reviewGuidance(await first)?.updated).toEqual([root]);
      expect(manager.reviewGuidance(await manager.prepare({ workspace_id: otherWorkspace.workspace_id }, "two"))?.updated).toEqual([other]);
    } finally {
      release.resolve();
      remote.mockRestore();
    }
  });

  test("open and Bash can display all rules while files still require an explicit, scoped receipt", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const root = rule("/project", "Root rule");
    const nested = rule("/project/src", "Source rule");
    transport.rules = [root, nested];
    const opened = await manager.open("00000001", "/project", []);
    const scope = { workspace_id: opened.workspace_id };
    manager.delivered(opened);
    const bash = await manager.prepare(scope, "src");
    expect(manager.guidance(bash.context!).updated).toEqual([nested]);
    manager.delivered(bash.context!);
    const target = "src/file";
    const file = await manager.prepare(scope, target);
    const review = manager.reviewGuidance(file)!;
    expect(review.updated).toEqual([root, nested]);
    expect(Array.isArray(review.token)).toBe(true);
    expect(review.token).toHaveLength(2);
    manager.delivered(file.context!);
    expect(manager.reviewGuidance(await manager.prepare(scope, target))).toEqual(review);
    const sibling = manager.reviewGuidance(await manager.prepare(scope, "src/other"))!;
    expect(sibling.token).toEqual(review.token);
    expect(manager.reviewGuidance(await manager.prepare(scope, "src/other"), review.token)).toBeUndefined();
    const other = await manager.open("00000001", "/project", ["/shared"]);
    manager.delivered(other);
    const wrongWorkspace = manager.reviewGuidance(await manager.prepare({ workspace_id: other.workspace_id }, target), review.token)!;
    expect(wrongWorkspace.token).not.toEqual(review.token);
    expect(wrongWorkspace.updated).toEqual([root, nested]);
    expect(manager.reviewGuidance(await manager.prepare(scope, target), review.token)).toBeUndefined();
    expect(manager.reviewGuidance(await manager.prepare(scope, "src/other"))).toBeUndefined();
    expect(manager.reviewGuidance(await manager.prepare(scope, target), wrongWorkspace.token)).toBeUndefined();
    manager.delivered(await manager.open("00000001", "/project", [], { rereadRules: true }));
    const reopened = manager.reviewGuidance(await manager.prepare(scope, target), review.token)!;
    expect(reopened.token).not.toEqual(review.token);
    expect(reopened.updated).toEqual([root, nested]);
  });

  test("a displayed rule removed before acknowledgment requires a fresh receipt even if the original bytes return", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const scope = { workspace_id: opened.workspace_id };
    async function present(ack?: RuleAcknowledgment) {
      const file = await manager.prepare(scope, "src/file");
      const review = manager.reviewGuidance(file, ack);
      if (review) manager.delivered(file.context!);
      return review;
    }
    const original = rule("/project/src", "Original");
    transport.rules = [original];
    const first = (await present())!;
    transport.rules = [];
    const removed = (await present(first.token))!;
    expect(removed.updated).toEqual([]);
    expect(removed.removed).toEqual([{ path: original.path, scope: original.scope }]);
    expect(removed.token).not.toBe(first.token);
    expect(await present(first.token)).toEqual(removed);
    expect(await present(removed.token)).toBeUndefined();
    transport.rules = [original];
    const restored = (await present(first.token))!;
    expect(restored.updated).toEqual([original]);
    expect(restored.token).not.toBe(first.token);
    transport.rules = [rule("/project/src", "Revised")];
    const revised = (await present(restored.token))!;
    expect(revised.updated).toEqual(transport.rules);
    expect(revised.token).not.toBe(restored.token);
    expect(await present(revised.token)).toBeUndefined();
    expect(await present()).toBeUndefined();
  });

  test("a late Bash delivery leaves a newer explicit file confirmation intact", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const scope = { workspace_id: opened.workspace_id };
    transport.rules = [rule("/project/src", "Old rule")];
    const bash = await manager.prepare(scope, "src");
    transport.rules = [rule("/project/src", "Current rule")];
    const file = await manager.prepare(scope, "src/file");
    const review = manager.reviewGuidance(file)!;
    manager.delivered(file.context!);
    expect(manager.reviewGuidance(await manager.prepare(scope, "src/file"), review.token)).toBeUndefined();
    expect(manager.guidance(bash.context!)).toEqual({ updated: [], removed: [] });
    manager.delivered(bash.context!);
    expect(manager.reviewGuidance(await manager.prepare(scope, "src/file"))).toBeUndefined();
  });

  test("file accesses already in progress return the full review even if another access confirms it first", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    transport.rules = [rule("/project/src", "Check generated files")];
    const scope = { workspace_id: opened.workspace_id };
    const reading = await manager.prepare(scope, "src/read");
    const downloading = manager.prepare(scope, "src/download");
    const pending = { updated: transport.rules, removed: [] };
    const review = manager.reviewGuidance(reading)!;
    expect(review).toMatchObject(pending);
    manager.delivered(reading.context!);
    expect(manager.reviewGuidance(await manager.prepare(scope, "src/read"), review.token)).toBeUndefined();
    const prepared = await downloading;
    expect(manager.reviewGuidance(prepared)).toMatchObject(pending);
    const retry = await manager.prepare(scope, "src/download");
    expect(manager.reviewGuidance(retry)).toBeUndefined();
    await manager.open("00000001", "/project", []);
    expect(manager.reviewGuidance(retry)).toBeUndefined();
    await manager.open("00000001", "/project", [], { rereadRules: true });
    expect(() => manager.reviewGuidance(retry)).toThrow(expect.objectContaining({ code: "WORKSPACE_RULES_RETRY" }));
  });

  test("a rule deleted after preparation cannot be returned or acknowledged again by the old file access", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const scope = { workspace_id: opened.workspace_id };
    transport.rules = [rule("/project/src", "Original rule")];
    const original = await manager.prepare(scope, "src/file");
    const oldReceipt = manager.reviewGuidance(original)!.token;
    manager.delivered(original.context!);
    const delayed = await manager.prepare(scope, "src/file");
    transport.rules = [];
    const removed = await manager.prepare(scope, "src/file");
    const review = manager.reviewGuidance(removed)!;
    expect(review.removed).toEqual([{ path: "/project/src/AGENTS.md", scope: "/project/src" }]);
    manager.delivered(removed.context!);
    expect(() => manager.reviewGuidance(delayed, oldReceipt)).toThrow(expect.objectContaining({ code: "WORKSPACE_RULES_RETRY" }));
    expect(manager.reviewGuidance(await manager.prepare(scope, "src/file"), oldReceipt)).toEqual(review);
    expect(manager.reviewGuidance(await manager.prepare(scope, "src/file"))).toEqual(review);
    expect(manager.reviewGuidance(await manager.prepare(scope, "src/file"), review.token)).toBeUndefined();
  });

  test("first reads in independent directories each inspect once and return their own pending rule", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const scope = { workspace_id: opened.workspace_id };
    const source = rule("/project/src", "Source rules");
    const docs = rule("/project/docs", "Docs rules");
    transport.rules = [source, docs];
    const original = transport.run.bind(transport);
    const hook = spyOn(transport, "run").mockImplementation(async (id, operation, args) => {
      const result = await original(id, operation, args);
      if (Array.isArray(args?.paths) && args.paths.includes("src/read")) {
        const other = await manager.prepare(scope, "docs/read");
        expect(manager.reviewGuidance(other)).toMatchObject({ updated: [docs], removed: [] });
        manager.delivered(other.context!);
      }
      return result;
    });
    try {
      const delayed = await manager.prepare(scope, "src/read");
      expect(manager.reviewGuidance(delayed)).toMatchObject({ updated: [source], removed: [] });
      expect(transport.requests.filter((op) => op === "workspace_context")).toHaveLength(2);
    } finally { hook.mockRestore(); }
  });

  for (const scenario of ["continued changes", "a temporary rule"] as const) {
    test(`file inspection retries at most once during ${scenario} and preserves the latest delivery`, async () => {
      const transport = new ContextTransport();
      const manager = new WorkspaceManager(transport);
      const opened = await manager.open("00000001", "/project", []);
      manager.delivered(opened);
      const scope = { workspace_id: opened.workspace_id };
      transport.rules = [rule("/project/src", "First revision")];
      const original = transport.run.bind(transport);
      let inspections = 0;
      const hook = spyOn(transport, "run").mockImplementation(async (id, operation, args) => {
        const snapshot = await original(id, operation, args);
        if (Array.isArray(args?.paths) && args.paths.includes("src/delayed")) {
          inspections++;
          if (scenario === "continued changes" && inspections <= 2) {
            transport.rules = [rule("/project/src", `Revision after inspection ${inspections}`)];
            manager.delivered((await manager.prepare(scope, "src/other")).context!);
          } else if (inspections === 1) {
            manager.delivered((await manager.prepare(scope, "src/other")).context!);
            transport.rules = [];
            manager.delivered((await manager.prepare(scope, "src/other")).context!);
          }
        }
        return snapshot;
      });
      try {
        const attempt = manager.prepare(scope, "src/delayed").then((prepared) => manager.reviewGuidance(prepared));
        if (scenario === "continued changes") await expect(attempt).rejects.toMatchObject({ code: "WORKSPACE_RULES_RETRY" });
        else expect(await attempt).toMatchObject({ updated: [], removed: [{ path: "/project/src/AGENTS.md", scope: "/project/src" }] });
        expect(inspections).toBe(2);
      } finally { hook.mockRestore(); }
      const review = manager.reviewGuidance(await manager.prepare(scope, "src/delayed"))!;
      expect(manager.reviewGuidance(await manager.prepare(scope, "src/delayed"), review.token)).toBeUndefined();
    });
  }

  test("overlapping Bash results calculate guidance against intervening operation responses", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    const scope = { workspace_id: opened.workspace_id };
    const original = rule("/project/src", "Original source rule");
    transport.rules = [original];
    const first = await manager.prepare(scope, "/project/src");
    const second = await manager.prepare(scope, "/project/src");
    expect(manager.guidance(first.context!).updated).toEqual([original]);
    manager.delivered(first.context!);
    expect(manager.guidance(second.context!)).toEqual({ updated: [], removed: [] });

    transport.rules = [rule("/project/src", "Refreshed source rule")];
    const refreshed = await manager.prepare(scope, "/project/src");
    manager.delivered(refreshed.context!);
    expect(manager.guidance(second.context!).updated).toEqual([]);
    manager.delivered(second.context!);
    const next = await manager.prepare(scope, "/project/src");
    expect(manager.guidance(next.context!).updated).toEqual([]);
  });

  test("only successful delivery suppresses repeated guidance and old responses cannot update an explicitly reset handle", async () => {
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
    const refreshed = await manager.open("00000001", "/project", [], { rereadRules: true });
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

  for (const reset of [false, true]) {
    test(`${reset ? "resetting" : "refreshing"} during preparation preserves the workspace handle`, async () => {
      const transport = new ContextTransport();
      const manager = new WorkspaceManager(transport);
      const opened = await manager.open("00000001", "/project", []);
      manager.delivered(opened);
      const scope = { workspace_id: opened.workspace_id };
      const originalRun = transport.run.bind(transport);
      const inspected = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const hook = spyOn(transport, "run").mockImplementation(async (id, operation, args) => {
        const result = await originalRun(id, operation, args);
        if (operation === "workspace_context") {
          inspected.resolve();
          await release.promise;
        }
        return result;
      });
      try {
        const pending = manager.prepare(scope, "/project/file");
        await inspected.promise;
        manager.delivered(await manager.open("00000001", "/project", [], { rereadRules: reset }));
        release.resolve();
        if (reset) await expect(pending).rejects.toMatchObject({ code: "WORKSPACE_RULES_RETRY" });
        else expect(manager.reviewGuidance(await pending)).toBeUndefined();
        expect(manager.reviewGuidance(await manager.prepare(scope, "/project/file"))).toBeUndefined();
      } finally {
        release.resolve();
        hook.mockRestore();
      }
    });
  }

  test("completed operations do not return stale guidance after recovery or disconnecting", async () => {
    for (const change of ["reset", "disconnect"]) {
      const transport = new ContextTransport();
      transport.rules = [rule("/project", "Original root rule")];
      const manager = new WorkspaceManager(transport);
      const opened = await manager.open("00000001", "/project", []);
      manager.delivered(opened);
      transport.rules.push(rule("/project/src", "Original source rule"));
      const prepared = await manager.prepare({ workspace_id: opened.workspace_id }, "/project/src/file");
      if (change === "reset") {
        transport.rules = [rule("/project", "Replacement root rule")];
        manager.delivered(await manager.open("00000001", "/project", [], { rereadRules: true }));
      } else {
        transport.available.clear();
      }
      expect(manager.guidance(prepared.context!)).toEqual({ updated: [], removed: [] });
      manager.delivered(prepared.context!);
    }
  });

  test("a catalog refresh interrupts only skill reads whose selected source changed", async () => {
    const transport = new ContextTransport();
    const stable = { path: "/project/.agents/skills/docs/SKILL.md", scope: "/project", content: "name: docs\ndescription: Documentation.\n" };
    transport.skillFiles = [stable, { path: "/project/.agents/skills/first/SKILL.md", scope: "/project", content: "name: check\ndescription: First checks.\n" }];
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
      const unchanged = manager.skill(opened.workspace_id, "docs", "SKILL.md");
      transport.skillFiles = [stable, { path: "/project/.claude/skills/second/SKILL.md", scope: "/project", content: "name: check\ndescription: Second checks.\n" }];
      manager.delivered(await manager.open("00000001", "/project", []));
      resume();
      await expect(pending).rejects.toMatchObject({ code: "SKILL_CATALOG_CHANGED" });
      await expect(unchanged).resolves.toMatchObject({ path: stable.path });
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

  test("rejects conflicting or out-of-scope rule sources without displacing a valid receipt", async () => {
    const transport = new ContextTransport();
    const root = rule("/project", "Root rule");
    transport.rules = [root];
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    const receipt = manager.guidance(opened).token!;
    manager.delivered(opened);
    const scope = { workspace_id: opened.workspace_id };
    const valid = await transport.run("00000001", "workspace_context", { paths: ["/project/file"] });
    for (const instructions of [[{ path: root.path, scope: root.scope, sha256: root.sha256 }], [root, root],
      [{ ...root, path: "/elsewhere/AGENTS.md" }], [rule("/elsewhere", "Other")]]) {
      const invalid = spyOn(transport, "run").mockResolvedValueOnce({ ...valid, instructions });
      try {
        await expect(manager.prepare(scope, "/project/file")).rejects.toMatchObject({ code: "REMOTE_OPERATION_FAILED" });
      } finally { invalid.mockRestore(); }
    }
    expect(manager.reviewGuidance(await manager.prepare(scope, "/project/file"), receipt)).toBeUndefined();
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
    const text = contextText(opened, manager.guidance(opened));
    manager.delivered(opened);
    const names = opened.skills.map((skill) => skill.callName);
    expect(names).toEqual(["project@check", "shared@check", "shared@check-2"]);
    expect(text).not.toContain("/shared-a");
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

  for (const rereadRules of [false, true]) {
    test(`a ${rereadRules ? "rule reread" : "catalog refresh"} that reaches the history limit recovers on its first call`, async () => {
      const transport = new ContextTransport();
      const manager = new WorkspaceManager(transport);
      const opened = await manager.open("00000001", "/project", []);
      manager.delivered(opened);
      const scope = { workspace_id: opened.workspace_id };
      for (let index = 0; index < MAX_KNOWN_RULES; index++) {
        const directory = `/project/dir-${index}`;
        transport.rules = [rule(directory, "Nested guidance")];
        manager.delivered((await manager.prepare(scope, directory)).context!);
      }

      const root = rule("/project", "New root guidance");
      transport.rules = [root];
      const reopened = await manager.open("00000001", "/project", [], { rereadRules });
      expect(reopened.workspace_id).toBe(opened.workspace_id);
      const notice = manager.guidance(reopened);
      expect(notice.updated).toEqual([root]);
      manager.delivered(reopened);
      expect(manager.reviewGuidance(await manager.prepare(scope, "/project/file"), notice.token)).toBeUndefined();
    });
  }

  test("instruction history exhaustion requires reopening instead of silently dropping rule state", async () => {
    const transport = new ContextTransport();
    const manager = new WorkspaceManager(transport);
    const opened = await manager.open("00000001", "/project", []);
    manager.delivered(opened);
    for (let index = 0; index < MAX_KNOWN_RULES; index++) {
      const scope = `/project/a/rule-${index}`;
      transport.rules = [rule(scope, `Rule ${index}`)];
      const filled = await manager.prepare({ workspace_id: opened.workspace_id }, scope + "/file");
      manager.delivered(filled.context!);
    }
    transport.rules = [];
    const originalRun = transport.run.bind(transport);
    let resume: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const hook = spyOn(transport, "run").mockImplementation(async (connectionId, operation, args) => {
      const response = await originalRun(connectionId, operation, args);
      if (operation === "workspace_context" && (args?.paths as string[])?.includes("/project/a/rule-0/file")) await waiting;
      return response;
    });
    try {
      const pending = manager.prepare({ workspace_id: opened.workspace_id }, "/project/a/rule-0/file");
      transport.rules = [rule("/project/b", "Another scope")];
      await expect(manager.prepare({ workspace_id: opened.workspace_id }, "/project/b/file"))
        .rejects.toMatchObject({ code: "WORKSPACE_REOPEN_REQUIRED" });
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

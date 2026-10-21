/** Regressions for bounded worker responses and JSON-escaped file contents over real SSH. */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RemoteChannel } from "../src/channel";
import { Runtime } from "../src/server";
import { SshFixture } from "./fixture";

const readArgs = { path: "escaped.txt", startLine: 1, lineCount: 2000, maxBytes: 262144 };
const escapedContent = "\x01".repeat(262144);

/** Own each fixture and runtime so failures never leave SSH processes or files behind. */
async function withRuntime(maxFileBytes: number, execute: (runtime: Runtime, id: string) => Promise<void>): Promise<void> {
  const fixture = new SshFixture();
  let runtime: Runtime | undefined;
  try {
    await fixture.start();
    await writeFile(join(fixture.workspace, "escaped.txt"), escapedContent);
    runtime = new Runtime({ ...fixture.config, maxFileBytes });
    const connection = await runtime.ssh.connect({ host: "fixture" });
    await execute(runtime, connection.connection_id as string);
  } finally {
    await runtime?.close();
    await fixture.close();
  }
}

test("eight concurrent escaped-text reads preserve every response and leave the connection ready", async () => {
  await withRuntime(4 * 1024 * 1024, async (runtime, id) => {
    const results = await Promise.all(Array.from({ length: 8 }, () => runtime.ssh.run(id, "read", readArgs)));
    for (const result of results) expect(result.content).toBe(escapedContent);
    expect(await runtime.ssh.run(id, "stat", { path: readArgs.path })).toMatchObject({ exists: true, size: 262144 });
  });
}, 20000);

test("a file at the configured size limit survives worst-case JSON escaping", async () => {
  await withRuntime(262144, async (runtime, id) => {
    const result = await runtime.ssh.run(id, "read", readArgs);
    expect(result.content).toBe(escapedContent);
    expect(result.size).toBe(262144);
  });
}, 20000);

test("cancelling a partially delivered response preserves subsequent operations", async () => {
  await withRuntime(262144, async (runtime, id) => {
    const controller = new AbortController();
    const channel = await runtime.ssh.open(id, "read", readArgs);
    channel.stdout.once("data", () => controller.abort());
    await expect(channel.collect(id, 262144, controller.signal)).rejects.toMatchObject({ code: "OPERATION_INTERRUPTED" });
    expect(await runtime.ssh.run(id, "stat", { path: readArgs.path })).toMatchObject({ exists: true });
  });
}, 20000);

test("closing while a response is in flight cancels delivery and confirms worker cleanup", async () => {
  await withRuntime(262144, async (runtime, id) => {
    const channel = await runtime.ssh.open(id, "read", readArgs);
    let closing: ReturnType<Runtime["ssh"]["closeConnection"]> | undefined;
    channel.stdout.once("data", () => { closing = runtime.ssh.closeConnection(id); });
    const result = await Promise.allSettled([channel.collect(id, 262144)]);
    expect(result[0]?.status).toBe("rejected");
    expect(closing).toBeDefined();
    expect(await closing).toMatchObject({ closed: true, remote_cleanup: "confirmed" });
  });
}, 20000);

test("oversized responses are cancelled once and subsequent chunks stay discarded", async () => {
  const sent: Record<string, unknown>[] = [];
  const channel = new RemoteChannel((message) => sent.push(message));
  const response = channel.collect("1234abcd", 1024);
  channel.stdout.write("x".repeat(6 * 1024 + 131073));
  channel.stdout.write("x".repeat(16384));
  channel.finish(0);
  await expect(response).rejects.toMatchObject({ code: "OPERATION_INTERRUPTED" });
  expect(sent.filter((message) => message.type === "cancel")).toHaveLength(1);
});

test("a stalled peer keeps the worker queue bounded and pauses helper output", async () => {
  const child = Bun.spawn(["uv", "run", "--no-project", "python", "-B", "tests/worker_output_test.py"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 20000);

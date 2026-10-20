/** Exercise foreground waits, output bounds, and lifecycle races without remote processes. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { RemoteChannel, type RemoteResult } from "../src/channel";
import { TaskManager } from "../src/tasks";
import { taskText } from "../src/task-text";

const CONNECTION = "1234abcd";
const HEADER_BYTES = Buffer.byteLength("Command:\nfixture\n\nOutput:\n");

/** Feed records through the same protocol decoder as real SSH operations. */
function emit(channel: RemoteChannel, event: RemoteResult): void {
  channel.stdout.write(JSON.stringify(event) + "\n");
}

class TaskFixture {
  readonly channels: RemoteChannel[] = [];
  readonly messages: RemoteResult[] = [];
  readonly sizes = new Map<RemoteChannel, number>();

  /** The test controls start/exit timing; stop requests receive a normal helper acknowledgement. */
  async open(_connectionId: string, _operation: string, args: RemoteResult): Promise<RemoteChannel> {
    const channel = new RemoteChannel((message) => {
      this.messages.push(message);
      const control = message.message as RemoteResult | undefined;
      if (message.type === "control" && control?.action === "stop") {
        queueMicrotask(() => this.finish(channel, -15, "cancelled"));
      }
      if (message.type === "cancel") queueMicrotask(() => channel.finish(255));
    });
    this.channels.push(channel);
    this.sizes.set(channel, Buffer.byteLength(`Command:\n${args.command}\n\nOutput:\n`));
    return channel;
  }

  /** Start confirmation includes an absolute log path before a task ID is returned. */
  started(channel: RemoteChannel): void {
    emit(channel, { event: "started", pid: 100, cwd: "/srv", outputFile: "/home/test/.neverssh/sessions/1234abcd/task_12345678.log", outputBytes: this.sizes.get(channel) });
  }

  /** Split UTF-8 or many tiny writes as the remote byte protocol can do. */
  output(channel: RemoteChannel, bytes: Buffer, stream = "stdout"): void {
    const total = this.sizes.get(channel)! + bytes.length;
    this.sizes.set(channel, total);
    emit(channel, { event: "output", stream, base64: bytes.toString("base64"), outputBytes: total });
  }

  /** Keep completion distinct from channel closure to test final decoder drainage. */
  finish(channel: RemoteChannel, exitCode = 0, reason?: string): void {
    emit(channel, { event: "exit", exitCode, reason, outputBytes: this.sizes.get(channel), outputComplete: true });
    channel.finish(0);
  }
}

let fixture: TaskFixture;
let tasks: TaskManager;
beforeEach(() => { fixture = new TaskFixture(); tasks = new TaskManager(fixture); });
afterEach(async () => { await tasks.close(); });

/** Let open attach its listeners before emitting the remote handshake. */
async function start(): Promise<{ id: string; channel: RemoteChannel }> {
  const pending = tasks.start(CONNECTION, "fixture");
  await Promise.resolve();
  const channel = fixture.channels.at(-1)!;
  fixture.started(channel);
  return { id: await pending, channel };
}

test("foreground waits for completion even after output arrives", async () => {
  let returned = false;
  const pending = tasks.execute(CONNECTION, "fixture", undefined, 1000);
  void pending.then(() => { returned = true; });
  await Promise.resolve();
  const channel = fixture.channels[0]!;
  fixture.started(channel);
  fixture.output(channel, Buffer.from("ready\n"));
  await Promise.resolve();
  expect(returned).toBe(false);
  fixture.finish(channel);
  const result = await pending;
  expect(result).toMatchObject({ finished: true, exit_code: 0, output_bytes: HEADER_BYTES + 6, preview: [{ stream: "stdout", text: "ready\n" }] });
  expect(taskText(result)).toBe("ready\n");
});

test("task list contains only tasks with unread output", async () => {
  const { id, channel } = await start();
  fixture.output(channel, Buffer.from("one\n"));
  expect(tasks.list().map((task) => task.task_id)).toContain(id);
  await tasks.output(id, 0);
  expect(tasks.list().map((task) => task.task_id)).not.toContain(id);
  fixture.output(channel, Buffer.from("two\n"));
  expect(tasks.list().map((task) => task.task_id)).toContain(id);
  fixture.finish(channel);
  await tasks.output(id, 0);
  expect(tasks.list().map((task) => task.task_id)).not.toContain(id);
});

test("fully delivered foreground commands do not appear in the task list", async () => {
  const pending = tasks.execute(CONNECTION, "fixture", undefined, 1000);
  await Promise.resolve();
  const channel = fixture.channels[0]!;
  fixture.started(channel);
  fixture.output(channel, Buffer.from("ready\n"));
  fixture.finish(channel);
  await pending;
  expect(tasks.list()).toHaveLength(0);
});

test("zero wait yields and cancelling a later query leaves the task running", async () => {
  const pending = tasks.execute(CONNECTION, "fixture", undefined, 0);
  await Promise.resolve();
  fixture.started(fixture.channels[0]!);
  const initial = await pending;
  expect(initial).toMatchObject({ finished: false, exit_code: null, output_bytes: HEADER_BYTES });
  expect(taskText(initial)).toContain("Task: ");
  expect(taskText(initial)).toContain("running in background");
  const controller = new AbortController();
  const query = tasks.output(initial.task_id, 300000, controller.signal);
  controller.abort();
  await expect(query).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  expect(tasks.snapshot(initial.task_id).finished).toBe(false);
  expect(fixture.messages).toEqual([]);
});

test("interrupting an unreturned foreground call stops its task and identifies its retained log", async () => {
  const controller = new AbortController();
  const pending = tasks.execute(CONNECTION, "fixture", undefined, 300000, controller.signal);
  await Promise.resolve();
  fixture.started(fixture.channels[0]!);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "OPERATION_CANCELLED", message: expect.stringContaining("Retained log:") });
  expect(fixture.messages.some((message) => message.type === "control")).toBe(true);
});

test("task IDs are prefixed and unique", async () => {
  const first = await start();
  fixture.finish(first.channel);
  const second = await start();
  expect(first.id).toMatch(/^task_[a-f0-9]{8}$/);
  expect(second.id).not.toBe(first.id);
  expect(() => tasks.snapshot("task_00000000")).toThrow(expect.objectContaining({ code: "TASK_NOT_FOUND" }));
});

test("completion drains split UTF-8 and repeated queries return the same preview", async () => {
  const { id, channel } = await start();
  fixture.output(channel, Buffer.from([228]));
  fixture.output(channel, Buffer.from([184, 150]));
  fixture.output(channel, Buffer.from([231]));
  emit(channel, { event: "exit", exitCode: 0, outputBytes: HEADER_BYTES + 4, outputComplete: true });
  expect(tasks.snapshot(id).finished).toBe(false);
  channel.finish(0);
  const result = tasks.snapshot(id);
  expect(result.preview.map((event) => event.text).join("")).toBe("世�");
  expect(result.output_bytes).toBe(HEADER_BYTES + 4);
  expect(await tasks.output(id, 0)).toEqual(result);
});

test("large previews stay bounded while the archived byte count includes all output", async () => {
  const { id, channel } = await start();
  for (let i = 0; i < 128; i++) fixture.output(channel, Buffer.alloc(16384, 120));
  fixture.finish(channel);
  const result = tasks.snapshot(id);
  expect(result).toMatchObject({ finished: true, output_bytes: HEADER_BYTES + 2097152, preview_complete: false, output_complete: true });
  expect(result.preview.reduce((sum, event) => sum + Buffer.byteLength(event.text), 0)).toBeLessThanOrEqual(65536);
  const text = taskText(result);
  expect(text).toContain(`${HEADER_BYTES + 2097152} bytes`);
  expect(text).toContain("read selectively");
  expect(text).not.toContain('"output"');
});

test("tiny output writes are also bounded by retained chunk count", async () => {
  const { id, channel } = await start();
  for (let i = 0; i < 5000; i++) fixture.output(channel, Buffer.from("x"));
  fixture.finish(channel);
  const result = tasks.snapshot(id);
  expect(result.preview).toHaveLength(4096);
  expect(result.preview_complete).toBe(false);
  expect(result.output_bytes).toBe(HEADER_BYTES + 5000);
});

test("a large command header does not trigger a reading reminder when output is fully shown", async () => {
  const pending = tasks.execute(CONNECTION, "#" + "x".repeat(70000), undefined, 1000);
  await Promise.resolve();
  const channel = fixture.channels[0]!;
  fixture.started(channel);
  fixture.output(channel, Buffer.from("ready\n"));
  fixture.finish(channel);
  const result = await pending;
  expect(result.output_bytes).toBeGreaterThan(65536);
  expect(taskText(result)).toBe("ready\n");
});

test("fully shown retained output needs no reading reminder even when the command log is incomplete", async () => {
  const { id, channel } = await start();
  fixture.output(channel, Buffer.from("prefix"));
  emit(channel, { event: "exit", exitCode: -15, reason: "output_limit", outputBytes: fixture.sizes.get(channel), outputComplete: false });
  channel.finish(0);
  const text = taskText(tasks.snapshot(id));
  expect(text).toContain("Log incomplete or unconfirmed.");
  expect(text).not.toContain("read selectively");
});

test("output archived without a delivered preview is marked for selective reading", async () => {
  const { id, channel } = await start();
  emit(channel, { event: "exit", exitCode: -15, reason: "output_error", outputBytes: HEADER_BYTES + 2, outputComplete: false });
  channel.finish(0);
  const result = tasks.snapshot(id);
  expect(result.preview_complete).toBe(false);
  expect(taskText(result)).toContain("read selectively");
});

test("connection loss retains output without inventing a final size or process exit code", async () => {
  const { id, channel } = await start();
  fixture.output(channel, Buffer.from("before loss\n"));
  channel.finish(255, "connection reset");
  const result = tasks.snapshot(id);
  expect(result).toMatchObject({ finished: true, exit_code: null, reason: "connection_lost", size_known: false });
  const text = taskText(result);
  expect(text).toContain("Exit code: unknown");
  expect(text).toContain("remote process state unknown");
  expect(text).toContain(`Last confirmed output size: ${HEADER_BYTES + 12} bytes`);
});

test("protocol failure waits for channel closure before reporting a finished task", async () => {
  const { id, channel } = await start();
  emit(channel, { event: "unexpected" });
  expect(tasks.snapshot(id)).toMatchObject({ finished: false, exit_code: null, reason: "failed" });
  await Promise.resolve();
  expect(tasks.snapshot(id).finished).toBe(true);
});

test("stopping twice preserves the original result and retained output", async () => {
  const { id, channel } = await start();
  fixture.output(channel, Buffer.from("ready\n"));
  const result = await tasks.stop(id);
  expect(result).toMatchObject({ finished: true, exit_code: -15, reason: "cancelled" });
  expect(await tasks.stop(id)).toEqual(result);
  expect(taskText(result)).toContain("Reason: cancelled");
  expect(taskText(result)).toContain("ready\n");
});

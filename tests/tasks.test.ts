/** Exercise foreground waits, output bounds, and lifecycle races without remote processes. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { RemoteChannel, type RemoteResult } from "../src/ssh/request-channel";
import { TaskManager } from "../src/tasks/manager";
import { bashResult } from "../src/tasks/text";
import { simpleCommandWords } from "../src/tasks/simple-command";
import { showsSearchText, viewedFile } from "../src/tasks/file-view";

const REMOTE_HOME = "/home/fixture";

test("only literal single-file viewing commands identify a read", () => {
  for (const command of [
    "cat --number", "/bin/cat -n", "nl -ba", "nl -b a", "bat --plain", "batcat --style=numbers",
    "head --lines=1", "head -n 0", "head -c 0", "tail -n 1", "sed -n '1,2p'", "grep -n hi", "egrep -e 'hi|bye'",
    "fgrep --regexp=hi", "rg -uu -C 1 hi",
  ]) {
    expect(viewedFile(command + " 'file name'", REMOTE_HOME)?.path, command).toBe("file name");
  }
  for (const command of [
    "cat a b", "cat a | head", "head a > result", "bat --version a", "rg --files a", "rg -h a",
    "rg -f patterns a", "cat *.txt", "cat $file", "cat -", "sed -n '1w changed' a", "./cat a",
    "rg -l match a", "grep -il match a", "egrep --count match a", "fgrep -q match a",
  ]) {
    expect(viewedFile(command, REMOTE_HOME), command).toBeUndefined();
  }
  expect(viewedFile("rg -na match file", REMOTE_HOME)?.binaryAsText).toBe(true);
  expect(viewedFile("grep --text match file", REMOTE_HOME)?.binaryAsText).toBe(true);
  expect(viewedFile("grep -eapart file", REMOTE_HOME)?.binaryAsText).toBe(false);
});

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

  cwd(): string { return REMOTE_HOME; }

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
async function start(command = "fixture"): Promise<{ id: string; channel: RemoteChannel }> {
  const pending = tasks.start(CONNECTION, command);
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
  expect(bashResult(result, "fixture").text).toBe("ready\n");
});

test("literal Bash argument recognition preserves quotes and rejects shell evaluation", () => {
  expect(simpleCommandWords(`  cat  'one 'two\\ three "four\\q" '' "a\\$b"  `, REMOTE_HOME))
    .toEqual(["cat", "one two three", "four\\q", "", "a$b"]);
  expect(simpleCommandWords("cat ~/project/'my file'\n", REMOTE_HOME)).toEqual(["cat", REMOTE_HOME + "/project/my file"]);
  expect(simpleCommandWords('cat "~/project/file#1"', REMOTE_HOME)).toEqual(["cat", "~/project/file#1"]);
  expect(simpleCommandWords("cat file#1", REMOTE_HOME)).toEqual(["cat", "file#1"]);
  for (const command of ["cat *.ts", "cat ?.ts", "cat [ab]", 'cat "$path"', "cat foo|true",
    "cat < file", "cat foo # comment", "cat a{b,c}", "cat $(pwd)", "cat `pwd`", "cat ~other/f",
    'cat "$[1+1]"', 'cat "${file}"',
    "cat 'unfinished", "cat \\", "cat file\nfalse"]) {
    expect(simpleCommandWords(command, REMOTE_HOME)).toBeUndefined();
  }
});

test("only an independently recognized command with exit 1 and no failure reason is accepted", async () => {
  const { id, channel } = await start();
  fixture.finish(channel, 1);
  const task = tasks.snapshot(id);
  for (const command of ["grep", "rg a src", "egrep", "fgrep", "find", "diff a b", "test -e f",
    "[ a = b ]", "git diff --exit-code", "git grep 'a|b'", "git -C /srv/project --no-pager diff --quiet",
    "/usr/bin/grep -E 'a|b' *.ts", 'test -n "$value"', 'test -n "${value}"', "rg pattern src\n"]) {
    const result = bashResult(task, command);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Exit code: 1");
  }
  for (const command of ["pgrep", "git status", "git -C grep status", "grepper", "grep a f && false", "grep a f | false",
    "grep a f > /missing/f", "grep a f\nfalse"]) {
    expect(bashResult(task, command).isError).toBe(true);
  }
  expect(bashResult({ ...task, reason: "output_error" }, "grep").isError).toBe(true);
  expect(bashResult({ ...task, exit_code: 2 }, "grep").isError).toBe(true);
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
  expect(bashResult(initial, "fixture").text).toContain("Task: ");
  expect(bashResult(initial, "fixture").text).toContain("running in background");
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
  const text = bashResult(result, "fixture").text;
  expect(text).toContain(`${HEADER_BYTES + 2097152} bytes`);
  expect(text).toContain("read selectively");
  expect(text).not.toContain('"output"');
});

test("file views require delivered stdout and only searches may have a truncated preview", async () => {
  const revision = { path: "/srv/text", requestPath: "/srv/text", sha256: "a".repeat(64) };
  for (const { command, code, stdout, stderr, credit } of [
    { command: "rg abc text", code: 1, stdout: 0, stderr: 0, credit: false },
    { command: "rg abc text", code: 0, stdout: 0, stderr: 1, credit: false },
    { command: "rg abc text", code: 0, stdout: 5, stderr: 0, credit: true },
    { command: "rg abc text", code: 0, stdout: 1, stderr: 5, credit: false },
    { command: "cat text", code: 0, stdout: 5, stderr: 0, credit: false },
    { command: "cat text", code: 0, stdout: 1, stderr: 0, credit: true },
    { command: "head -n 0 text", code: 0, stdout: 0, stderr: 0, credit: false },
    { command: "head -c 0 text", code: 0, stdout: 0, stderr: 1, credit: false },
  ]) {
    const { id, channel } = await start(command);
    for (let i = 0; i < stdout; i++) fixture.output(channel, Buffer.alloc(16384, 120));
    for (let i = 0; i < stderr; i++) fixture.output(channel, Buffer.alloc(16384, 100), "stderr");
    emit(channel, { event: "exit", exitCode: code, outputBytes: fixture.sizes.get(channel),
      outputComplete: true, viewedFile: { ...revision, hasNul: false } });
    channel.finish(0);
    const result = await tasks.output(id, 0);
    expect(Boolean(tasks.takeFileView(result)), command).toBe(credit);
    expect(tasks.takeFileView(result)).toBeUndefined();
  }
});

test("search output distinguishes file text, match separators and binary-only notices", () => {
  const plain = viewedFile("rg match sample", REMOTE_HOME)!;
  const fragments = viewedFile("rg -o match sample", REMOTE_HOME)!;
  const binaryNotice = 'binary file matches (found "\\0" byte around offset 123)\n';
  expect(showsSearchText(plain, "\n", false)).toBe(true);
  expect(showsSearchText(fragments, "\n\n", false)).toBe(false);
  expect(showsSearchText(fragments, " \n", false)).toBe(true);
  expect(showsSearchText(plain, binaryNotice, false)).toBe(true);
  expect(showsSearchText(plain, binaryNotice, true)).toBe(false);
  expect(showsSearchText(plain, "Binary file sample matches\n", true)).toBe(false);
  expect(showsSearchText(plain, "match\n" + binaryNotice, true)).toBe(true);
});

test("multiline only-matching searches require visible text beyond match columns", () => {
  const unnumbered = viewedFile("rg -Uo 'a{0}' sample", REMOTE_HOME)!;
  expect(showsSearchText(unnumbered, "\n\n", false)).toBe(false);
  const numbered = viewedFile("rg -Unbo 'a{0}' sample", REMOTE_HOME)!;
  expect(showsSearchText(numbered, "1:0:\n1:1:\n2:2:\n", false)).toBe(false);
  expect(showsSearchText(numbered, "1:0:a\n3:0:b\n", false)).toBe(true);
  expect(showsSearchText(numbered, "1:0: \n2:0:\t\n", false)).toBe(true);
});

test("only-matching output strips precisely the requested match columns", () => {
  const file = "part:1.txt";
  for (const [flags, prefix] of [
    ["-o", ""], ["-no", "1:"], ["-ob", "0:"], ["-onb", "1:0:"],
    ["-Ho", file + ":"], ["-Ho --line-number", file + ":1:"], ["-Hbon", file + ":1:0:"],
    ["-HnobI", "1:0:"], ["-Iob -H", file + ":0:"],
  ] as const) {
    const view = viewedFile(`rg ${flags} '^' ${file}`, REMOTE_HOME)!;
    expect(showsSearchText(view, prefix + "\n" + prefix + "\n", false), flags).toBe(false);
    expect(showsSearchText(view, prefix + "1:\n", false), flags).toBe(true);
    expect(showsSearchText(view, prefix + " \n", false), flags).toBe(true);
  }
  const clipped = viewedFile(`rg -Hnbo '^' ${file}`, REMOTE_HOME)!;
  expect(showsSearchText(clipped, "rt:1.txt:1:0:\n", false, true)).toBe(false);
  expect(showsSearchText(clipped, "body from a long match\n", false, true)).toBe(true);
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
  expect(bashResult(result, "fixture").text).toBe("ready\n");
});

test("fully shown retained output needs no reading reminder even when the command log is incomplete", async () => {
  const { id, channel } = await start();
  fixture.output(channel, Buffer.from("prefix"));
  emit(channel, { event: "exit", exitCode: -15, reason: "output_limit", outputBytes: fixture.sizes.get(channel), outputComplete: false });
  channel.finish(0);
  const text = bashResult(tasks.snapshot(id), "fixture").text;
  expect(text).toContain("Log incomplete or unconfirmed.");
  expect(text).not.toContain("read selectively");
});

test("output archived without a delivered preview is marked for selective reading", async () => {
  const { id, channel } = await start();
  emit(channel, { event: "exit", exitCode: -15, reason: "output_error", outputBytes: HEADER_BYTES + 2, outputComplete: false });
  channel.finish(0);
  const result = tasks.snapshot(id);
  expect(result.preview_complete).toBe(false);
  expect(bashResult(result, "fixture").text).toContain("read selectively");
});

test("connection loss retains output without inventing a final size or process exit code", async () => {
  const { id, channel } = await start();
  fixture.output(channel, Buffer.from("before loss\n"));
  channel.finish(255, "connection reset");
  const result = tasks.snapshot(id);
  expect(result).toMatchObject({ finished: true, exit_code: null, reason: "connection_lost", size_known: false });
  const text = bashResult(result, "fixture").text;
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
  expect(bashResult(result, "fixture").text).toContain("Reason: cancelled");
  expect(bashResult(result, "fixture").text).toContain("ready\n");
});

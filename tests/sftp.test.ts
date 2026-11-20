/** Exercise shared SFTP admission and owned child lifetimes without contacting user servers. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { SshTransport } from "../src/ssh/transport";
import { SshFixture } from "./fixture";

const fixture = new SshFixture();
let ssh: SshTransport;
let connectionId: string;
let script = "";
let processes: { child: childProcess.ChildProcess; ready: Promise<void>; output: string }[];
let spawnHook: ReturnType<typeof spyOn<typeof childProcess, "spawn">>;

/** Keep the subprocess alive until the test releases it, with optional delayed TERM handling. */
function controlledProcess(termDelay: number | null = 200): string {
  return `process.stdin.resume();
process.on("SIGUSR1", () => process.exit(0));
process.on("SIGTERM", () => { ${termDelay === null ? "" : `setTimeout(() => process.exit(0), ${termDelay});`} });
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);`;
}

/** Tests must observe child closure even when an assertion fails against the old implementation. */
async function killOwned(child: childProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
  await closed;
}

beforeAll(async () => { await fixture.start(); }, 20000);
beforeEach(async () => {
  ssh = new SshTransport(fixture.config);
  const connected = await ssh.connect({ host: "fixture" });
  if (typeof connected.connection_id !== "string") throw new Error("Missing fixture connection");
  connectionId = connected.connection_id;
  script = controlledProcess();
  processes = [];
  const original = childProcess.spawn;
  spawnHook = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof childProcess.spawn>) => {
    if (args[0] !== "sftp") return original(...args);
    const child = original(process.execPath, ["--eval", script], args[2]);
    let output = "";
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("ready\n")) resolve();
      });
      child.once("error", reject);
    });
    processes.push({ child, ready, get output() { return output; } });
    return child;
  }) as typeof childProcess.spawn);
}, 20000);
afterEach(async () => {
  spawnHook?.mockRestore();
  await Promise.all(processes.map(({ child }) => killOwned(child)));
  await ssh?.close();
}, 15000);
afterAll(async () => { await fixture.close(); }, 15000);

test("cancelling one SFTP probe waiter preserves the shared probe and other waiters", async () => {
  const controller = new AbortController();
  const first = ssh.prepareSftp(connectionId, controller.signal).catch((error: unknown) => error);
  const second = ssh.prepareSftp(connectionId).then(() => "ready", (error: unknown) => error);
  expect(processes).toHaveLength(1);
  const probe = processes[0]!;
  await probe.ready;
  controller.abort();
  expect(await first).toMatchObject({ code: "OPERATION_CANCELLED" });
  expect(probe.child.exitCode).toBeNull();
  expect(probe.child.signalCode).toBeNull();
  probe.child.kill("SIGUSR1");
  expect(await second).toBe("ready");
  await ssh.prepareSftp(connectionId);
  expect(processes).toHaveLength(1);
});

test("an already cancelled waiter cannot use a cached SFTP probe", async () => {
  script = 'process.stdout.write("ready\\n"); process.exit(0);';
  await ssh.prepareSftp(connectionId);
  const controller = new AbortController();
  controller.abort();
  await expect(ssh.prepareSftp(connectionId, controller.signal)).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  expect(processes).toHaveLength(1);
});

test("a failed shared probe preserves errors for its waiters and permits a later retry", async () => {
  script = 'process.stderr.write("subsystem unavailable\\n"); process.exit(3);';
  const first = ssh.prepareSftp(connectionId).catch((error: unknown) => error);
  const second = ssh.prepareSftp(connectionId).catch((error: unknown) => error);
  expect(await first).toMatchObject({ code: "SFTP_UNAVAILABLE" });
  expect(await second).toMatchObject({ code: "SFTP_UNAVAILABLE" });
  expect(processes).toHaveLength(1);
  expect(processes[0]!.child.exitCode).toBe(3);
  script = 'process.stdout.write("ready\\n"); process.exit(0);';
  await ssh.prepareSftp(connectionId);
  expect(processes).toHaveLength(2);
});

test("the final cancelled probe waiter waits for its subprocess to close and permits a fresh probe", async () => {
  const controller = new AbortController();
  const pending = ssh.prepareSftp(connectionId, controller.signal).catch((error: unknown) => error);
  const probe = processes[0]!;
  await probe.ready;
  controller.abort();
  expect(await pending).toMatchObject({ code: "OPERATION_CANCELLED" });
  expect(probe.child.exitCode !== null || probe.child.signalCode !== null).toBe(true);
  script = 'process.stdout.write("ready\\n"); process.exit(0);';
  await ssh.prepareSftp(connectionId);
  expect(processes).toHaveLength(2);
});

test("cancelled SFTP waits for TERM cleanup before rejecting", async () => {
  const controller = new AbortController();
  const pending = ssh.sftp(connectionId, ["pwd"], controller.signal).catch((error: unknown) => error);
  const transfer = processes[0]!;
  await transfer.ready;
  controller.abort();
  expect(await pending).toMatchObject({ code: "OPERATION_CANCELLED" });
  expect(transfer.child.exitCode !== null || transfer.child.signalCode !== null).toBe(true);
});

test("cancelling SFTP also stops a TERM-resistant child after its parent exits", async () => {
  const descendantScript = 'process.on("SIGTERM", () => {}); process.stdout.write("child ready\\n"); setInterval(() => {}, 1000);';
  script = `const { spawn } = require("node:child_process");
process.stdin.resume();
process.on("SIGTERM", () => process.exit(0));
const child = spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => process.stdout.write("descendant:" + child.pid + "\\nready\\n"));
setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  const pending = ssh.sftp(connectionId, ["pwd"], controller.signal).catch((error: unknown) => error);
  const transfer = processes[0]!;
  await transfer.ready;
  const descendant = Number(/descendant:(\d+)/.exec(transfer.output)?.[1]);
  expect(descendant).toBeGreaterThan(0);
  try {
    controller.abort();
    expect(await pending).toMatchObject({ code: "OPERATION_CANCELLED" });
    let running = true;
    for (let attempt = 0; attempt < 100 && running; attempt++) {
      const status = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(descendant)]).stdout.toString().trim();
      running = status !== "" && !status.startsWith("Z");
      if (running) await delay(10);
    }
    expect(running).toBe(false);
  } finally {
    try { process.kill(descendant, "SIGKILL"); }
    catch { /* The cancelled process group has already exited. */ }
  }
});

test("SFTP timeout settles only after a TERM-resistant subprocess exits", async () => {
  script = controlledProcess(null);
  const pending = ssh.sftp(connectionId, ["pwd"], undefined, 200).catch((error: unknown) => error);
  const transfer = processes[0]!;
  await transfer.ready;
  expect(await pending).toMatchObject({ code: "SFTP_TIMEOUT" });
  expect(transfer.child.exitCode !== null || transfer.child.signalCode !== null).toBe(true);
}, 10000);

test("successful SFTP is not changed by a later cancellation", async () => {
  script = 'process.stdout.write("ready\\n"); process.exit(0);';
  const controller = new AbortController();
  await ssh.sftp(connectionId, ["pwd"], controller.signal);
  controller.abort();
  expect(processes).toHaveLength(1);
  expect(processes[0]!.child.exitCode).toBe(0);
});

test("concurrent connection closes wait for active SFTP cleanup", async () => {
  script = controlledProcess(null);
  const pending = ssh.sftp(connectionId, ["pwd"]).catch((error: unknown) => error);
  const transfer = processes[0]!;
  await transfer.ready;
  const closed = await Promise.all([ssh.closeConnection(connectionId), ssh.closeConnection(connectionId)]);
  expect(closed[0]).toEqual(closed[1]);
  expect(transfer.child.exitCode !== null || transfer.child.signalCode !== null).toBe(true);
  expect(await pending).toMatchObject({ code: "CONNECTION_LOST" });
}, 15000);

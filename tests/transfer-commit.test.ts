/** Verify upload commits and transfer path expansion through the real loopback SSH/SFTP fixture. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SshTransport } from "../src/ssh";
import { download, upload } from "../src/transfers";
import { SshFixture } from "./fixture";

const fixture = new SshFixture();
let ssh: SshTransport;
let connectionId: string;

beforeAll(async () => {
  await fixture.start();
  ssh = new SshTransport(fixture.config);
  connectionId = (await ssh.connect({ host: "fixture" })).connection_id as string;
}, 20000);

afterAll(async () => {
  await ssh?.close();
  await fixture.close();
}, 15000);

/** Place a deterministic concurrent write after initial conflict checks but before the SFTP upload. */
function beforeUpload(action: () => Promise<void>) {
  const original = ssh.sftp.bind(ssh);
  return spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    if (args[1].some((command) => command.startsWith("put "))) await action();
    return original(...args);
  });
}

/** Check that successful and failed commits both remove their remote staged files. */
async function stagedFiles(remote: string): Promise<string[]> {
  return (await readdir(dirname(remote))).filter((name) => name.startsWith(`${basename(remote)}.neverssh-`));
}

test("upload refuses to overwrite a file created while SFTP is being prepared", async () => {
  const localPath = join(fixture.transfers, "no-overwrite-source");
  const remotePath = join(fixture.workspace, "no-overwrite-target");
  await writeFile(localPath, "upload");
  const hook = beforeUpload(() => writeFile(remotePath, "concurrent writer"));
  try {
    await expect(upload(ssh, connectionId, { localPath, remotePath, overwrite: false })).rejects.toThrow("File exists");
  } finally { hook.mockRestore(); }
  expect(await readFile(remotePath, "utf8")).toBe("concurrent writer");
  expect(await stagedFiles(remotePath)).toEqual([]);
});

test("upload rechecks expectedSha256 when committing staged bytes", async () => {
  const localPath = join(fixture.transfers, "revision-source");
  const remotePath = join(fixture.workspace, "revision-target");
  await writeFile(localPath, "upload");
  await writeFile(remotePath, "original");
  const expectedSha256 = createHash("sha256").update("original").digest("hex");
  const hook = beforeUpload(() => writeFile(remotePath, "concurrent writer"));
  try {
    await expect(upload(ssh, connectionId, { localPath, remotePath, overwrite: false, expectedSha256 })).rejects.toThrow("SHA-256");
  } finally { hook.mockRestore(); }
  expect(await readFile(remotePath, "utf8")).toBe("concurrent writer");
  expect(await stagedFiles(remotePath)).toEqual([]);
});

test("only one concurrent no-overwrite upload can create the destination", async () => {
  const first = join(fixture.transfers, "first-source");
  const second = join(fixture.transfers, "second-source");
  const remotePath = join(fixture.workspace, "concurrent-target");
  await writeFile(first, "first");
  await writeFile(second, "second");
  let arrived = 0;
  let release!: () => void;
  const bothReady = new Promise<void>((resolve) => { release = resolve; });
  const hook = beforeUpload(async () => {
    if (++arrived === 2) release();
    await bothReady;
  });
  let results: PromiseSettledResult<Record<string, unknown>>[];
  try {
    results = await Promise.allSettled([first, second].map((localPath) =>
      upload(ssh, connectionId, { localPath, remotePath, overwrite: false })));
  } finally { hook.mockRestore(); }
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(["first", "second"]).toContain(await readFile(remotePath, "utf8"));
  expect(await stagedFiles(remotePath)).toEqual([]);
});

test("tilde transfer paths use HOME while relative paths still use the explicit cwd", async () => {
  const project = join(fixture.workspace, "tilde-project");
  await mkdir(project);
  const localPath = join(fixture.transfers, "tilde-source");
  await writeFile(localPath, "home payload");
  const uploaded = await upload(ssh, connectionId, { localPath, remotePath: "~/tilde-upload", overwrite: false }, project);
  expect(uploaded.path).toBe(join(fixture.workspace, "tilde-upload"));
  expect(await readFile(join(fixture.workspace, "tilde-upload"), "utf8")).toBe("home payload");
  expect(await readdir(project)).not.toContain("tilde-upload");

  // A matching name in cwd exposes incorrect tilde expansion without depending on a missing-file error.
  await writeFile(join(project, "tilde-upload"), "cwd payload");
  const downloaded = await download(ssh, connectionId, {
    remotePath: "~/tilde-upload", localPath: join(fixture.transfers, "tilde-download"), overwrite: false,
  }, "~/tilde-project");
  expect(await readFile(downloaded.localPath as string, "utf8")).toBe("home payload");
  const relative = await upload(ssh, connectionId, { localPath, remotePath: "relative-upload", overwrite: false }, "~/tilde-project");
  expect(relative.path).toBe(join(project, "relative-upload"));
});

test("cancelling after staging still removes the remote temporary upload", async () => {
  const localPath = join(fixture.transfers, "cancel-source");
  const remotePath = join(fixture.workspace, "cancel-target");
  await writeFile(localPath, "upload");
  const controller = new AbortController();
  const original = ssh.sftp.bind(ssh);
  const hook = spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    await original(...args);
    if (args[1].some((command) => command.startsWith("put "))) controller.abort();
  });
  try {
    await expect(upload(ssh, connectionId, { localPath, remotePath, overwrite: false }, undefined, controller.signal))
      .rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  } finally { hook.mockRestore(); }
  expect(await stagedFiles(remotePath)).toEqual([]);
  expect(await readdir(fixture.workspace)).not.toContain("cancel-target");
});

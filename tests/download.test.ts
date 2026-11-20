/** Exercise download boundaries with real SFTP and controlled changes between validation and commit. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as files from "node:fs/promises";
import { dirname, join } from "node:path";
import { download } from "../src/files/transfers";
import { SshTransport } from "../src/ssh/transport";
import { SshFixture } from "./fixture";

const fixture = new SshFixture();
let ssh: SshTransport;
let connectionId: string;
let unrestricted: SshTransport;
let unrestrictedId: string;

beforeAll(async () => {
  await fixture.start();
  ssh = new SshTransport(fixture.config);
  const connected = (await ssh.connect({ host: "fixture" })).connection_id;
  if (typeof connected !== "string") throw new Error("Missing fixture connection handle");
  connectionId = connected;
  await ssh.prepareSftp(connectionId);
  unrestricted = new SshTransport({ ...fixture.config, localTransferRoots: [] });
  const unrestrictedConnection = (await unrestricted.connect({ host: "fixture" })).connection_id;
  if (typeof unrestrictedConnection !== "string") throw new Error("Missing unrestricted fixture connection handle");
  unrestrictedId = unrestrictedConnection;
}, 20000);

afterAll(async () => {
  await ssh?.close();
  await unrestricted?.close();
  await fixture.close();
}, 15000);

/** Fixture paths contain no whitespace; inspect the actual SFTP destination without assuming its layout. */
function getDestination(commands: string[]): string | undefined {
  return commands.find((command) => command.startsWith("get "))?.split(" ").at(-1);
}

test("empty transfer roots download outside the fixture allowlist and retain explicit overwrite checks", async () => {
  const remotePath = join(fixture.workspace, "unrestricted-download-source");
  const localPath = join(fixture.root, "unrestricted-parent", "nested/destination.bin");
  const original = Buffer.from([0, 1, 2, 128, 255]);
  await files.writeFile(remotePath, original);
  const result = await download(unrestricted, unrestrictedId, { remotePath, localPath, overwrite: false });
  expect(result.localPath).toBe(localPath);
  expect(await files.readFile(localPath)).toEqual(original);
  expect((await files.stat(localPath)).mode & 0o777).toBe(0o600);
  await files.writeFile(remotePath, "replacement payload\n");
  await expect(download(unrestricted, unrestrictedId, { remotePath, localPath, overwrite: false }))
    .rejects.toThrow("set overwrite=true explicitly");
  expect(await files.readFile(localPath)).toEqual(original);
  await download(unrestricted, unrestrictedId, { remotePath, localPath, overwrite: true });
  expect(await files.readFile(localPath, "utf8")).toBe("replacement payload\n");
});

test("unrestricted downloads still reject final destination symlinks", async () => {
  const remotePath = join(fixture.workspace, "unrestricted-link-source");
  const target = join(fixture.root, "unrestricted-link-target");
  const localPath = join(fixture.root, "unrestricted-download-alias");
  await files.writeFile(remotePath, "must not overwrite through link\n");
  await files.writeFile(target, "original local content\n");
  await files.symlink(target, localPath);
  await expect(download(unrestricted, unrestrictedId, { remotePath, localPath, overwrite: true }))
    .rejects.toThrow("never a symlink");
  expect((await files.lstat(localPath)).isSymbolicLink()).toBe(true);
  expect(await files.readFile(target, "utf8")).toBe("original local content\n");
});

test("an unrestricted cancelled download creates no destination parents", async () => {
  const parent = join(fixture.root, "unrestricted-cancelled-parent");
  const controller = new AbortController();
  controller.abort();
  await expect(download(unrestricted, unrestrictedId, {
    remotePath: "never-read", localPath: join(parent, "nested/destination"), overwrite: false,
  }, undefined, controller.signal)).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  expect(await files.stat(parent).catch(() => null)).toBeNull();
});

test("downloaded bytes stay private before local validation and commit", async () => {
  const remotePath = join(fixture.workspace, "public-source");
  const localPath = join(fixture.transfers, "private-destination");
  await files.writeFile(remotePath, "private payload\n", { mode: 0o644 });
  const original = ssh.sftp.bind(ssh);
  let accessible = false;
  let inspected = false;
  const hook = spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    await original(...args);
    const destination = getDestination(args[1]);
    if (!destination) return;
    inspected = true;
    // A private staging directory is sufficient even if SFTP initially gives its payload source permissions.
    let current = destination;
    accessible = true;
    while (current !== fixture.transfers) {
      if (((await files.stat(current)).mode & 0o077) === 0) { accessible = false; break; }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  });
  try {
    await download(ssh, connectionId, { remotePath, localPath, overwrite: false });
  } finally { hook.mockRestore(); }
  expect(inspected).toBe(true);
  expect(accessible).toBe(false);
  expect((await files.stat(localPath)).mode & 0o777).toBe(0o600);
  expect(await files.readFile(localPath, "utf8")).toBe("private payload\n");
});

test("download uses the checked remote target when its source alias changes", async () => {
  const first = join(fixture.workspace, "checked-source");
  const second = join(fixture.workspace, "replacement-source");
  const alias = join(fixture.workspace, "download-alias");
  const localPath = join(fixture.transfers, "checked-destination");
  await files.writeFile(first, "checked payload\n");
  await files.writeFile(second, "unexpected replacement\n");
  await files.symlink(first, alias);
  const original = ssh.sftp.bind(ssh);
  const hook = spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    if (getDestination(args[1])) {
      await files.unlink(alias);
      await files.symlink(second, alias);
    }
    return original(...args);
  });
  try {
    await download(ssh, connectionId, { remotePath: alias, localPath, overwrite: false });
  } finally { hook.mockRestore(); }
  expect(await files.readFile(localPath, "utf8")).toBe("checked payload\n");
});

test("a replaced local parent cannot receive download staging outside transfer roots", async () => {
  const remotePath = join(fixture.workspace, "parent-swap-source");
  const parent = join(fixture.transfers, "changing-parent");
  const outside = join(fixture.root, "outside-download-root");
  await files.writeFile(remotePath, "must stay inside\n");
  await files.mkdir(parent);
  await files.mkdir(outside);
  const original = ssh.sftp.bind(ssh);
  let outsideFiles: string[] = [];
  const hook = spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    if (!getDestination(args[1])) return original(...args);
    await files.rename(parent, parent + "-original");
    await files.symlink(outside, parent);
    try { return await original(...args); }
    finally { outsideFiles = await files.readdir(outside); }
  });
  try {
    await expect(download(ssh, connectionId, {
      remotePath, localPath: join(parent, "destination"), overwrite: false,
    })).rejects.toThrow();
  } finally { hook.mockRestore(); }
  expect(outsideFiles).toEqual([]);
  expect(await files.readdir(outside)).toEqual([]);
});

test("cancellation during final destination validation preserves the existing file", async () => {
  const remotePath = join(fixture.workspace, "cancel-commit-source");
  const localPath = join(fixture.transfers, "cancel-commit-destination");
  await files.writeFile(remotePath, "downloaded payload\n");
  await files.writeFile(localPath, "original local content\n");
  const controller = new AbortController();
  const originalSftp = ssh.sftp.bind(ssh);
  const originalStat = files.lstat;
  let transferred = false;
  let interrupted = false;
  const sftpHook = spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    await originalSftp(...args);
    if (getDestination(args[1])) transferred = true;
  });
  // Delegate every lstat overload unchanged while interrupting this one known validation point.
  const statHook = spyOn(files, "lstat").mockImplementation((async (...args: Parameters<typeof files.lstat>) => {
    const result = await originalStat(...args);
    if (args[0] === localPath && transferred) {
      interrupted = true;
      controller.abort();
    }
    return result;
  }) as typeof files.lstat);
  try {
    await expect(download(ssh, connectionId, { remotePath, localPath, overwrite: true }, undefined, controller.signal))
      .rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  } finally {
    statHook.mockRestore();
    sftpHook.mockRestore();
  }
  expect(interrupted).toBe(true);
  expect(await files.readFile(localPath, "utf8")).toBe("original local content\n");
  expect((await files.readdir(fixture.transfers)).filter((name) => name.startsWith(".neverssh-"))).toEqual([]);
});

test("an already cancelled download does not create local destination directories", async () => {
  const parent = join(fixture.transfers, "cancel-before-start");
  const controller = new AbortController();
  controller.abort();
  await expect(download(ssh, connectionId, {
    remotePath: "never-read", localPath: join(parent, "nested/destination"), overwrite: false,
  }, undefined, controller.signal)).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  expect(await files.stat(parent).catch(() => null)).toBeNull();
});

test("cancellation after SFTP removes staging without publishing a destination", async () => {
  const remotePath = join(fixture.workspace, "cancel-staging-source");
  const localPath = join(fixture.transfers, "cancel-staging-destination");
  await files.writeFile(remotePath, "cancelled payload\n");
  const controller = new AbortController();
  const original = ssh.sftp.bind(ssh);
  const hook = spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    await original(...args);
    if (getDestination(args[1])) controller.abort();
  });
  try {
    await expect(download(ssh, connectionId, { remotePath, localPath, overwrite: false }, undefined, controller.signal))
      .rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  } finally { hook.mockRestore(); }
  expect(await files.stat(localPath).catch(() => null)).toBeNull();
  expect((await files.readdir(fixture.transfers)).filter((name) => name.startsWith(".neverssh-"))).toEqual([]);
});

test("concurrent downloads cannot both create a destination without overwrite permission", async () => {
  const first = join(fixture.workspace, "concurrent-download-first");
  const second = join(fixture.workspace, "concurrent-download-second");
  const localPath = join(fixture.transfers, "concurrent-download-destination");
  await files.writeFile(first, "first payload\n");
  await files.writeFile(second, "second payload\n");
  const original = ssh.sftp.bind(ssh);
  let arrived = 0;
  let resume: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { resume = resolve; });
  const hook = spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    if (getDestination(args[1])) {
      if (++arrived === 2) resume();
      await waiting;
    }
    return original(...args);
  });
  let results: PromiseSettledResult<Record<string, unknown>>[];
  try {
    results = await Promise.allSettled([first, second].map((remotePath) =>
      download(ssh, connectionId, { remotePath, localPath, overwrite: false })));
  } finally {
    resume();
    hook.mockRestore();
  }
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(["first payload\n", "second payload\n"]).toContain(await files.readFile(localPath, "utf8"));
  expect((await files.readdir(fixture.transfers)).filter((name) => name.startsWith(".neverssh-"))).toEqual([]);
});

test("the size limit accepts its exact boundary and rejects a growing source without replacing the destination", async () => {
  const limit = 1024;
  const remotePath = join(fixture.workspace, "bounded-source");
  const localPath = join(fixture.transfers, "bounded-destination");
  const originalBytes = Buffer.alloc(limit, 0x61);
  await files.writeFile(remotePath, originalBytes);
  const limited = new SshTransport({ ...fixture.config, maxFileBytes: limit });
  try {
    const connected = (await limited.connect({ host: "fixture" })).connection_id;
    if (typeof connected !== "string") throw new Error("Missing fixture connection handle");
    const result = await download(limited, connected, { remotePath, localPath, overwrite: false });
    expect(result.size).toBe(limit);
    expect(await files.readFile(localPath)).toEqual(originalBytes);

    await files.writeFile(remotePath, "small when checked\n");
    const originalSftp = limited.sftp.bind(limited);
    const hook = spyOn(limited, "sftp").mockImplementation(async (...args) => {
      if (getDestination(args[1])) await files.writeFile(remotePath, Buffer.alloc(limit + 1, 0x62));
      return originalSftp(...args);
    });
    try {
      await expect(download(limited, connected, { remotePath, localPath, overwrite: true })).rejects.toThrow("maxFileBytes");
    } finally { hook.mockRestore(); }
    expect(await files.readFile(localPath)).toEqual(originalBytes);
    expect((await files.readdir(fixture.transfers)).filter((name) => name.startsWith(".neverssh-"))).toEqual([]);
  } finally { await limited.close(); }
});

test("a failed SFTP result removes staged bytes and preserves an existing destination", async () => {
  const remotePath = join(fixture.workspace, "failed-transfer-source");
  const localPath = join(fixture.transfers, "failed-transfer-destination");
  await files.writeFile(remotePath, "unconfirmed payload\n");
  await files.writeFile(localPath, "original local content\n");
  const original = ssh.sftp.bind(ssh);
  const hook = spyOn(ssh, "sftp").mockImplementation(async (...args) => {
    await original(...args);
    if (getDestination(args[1])) throw new Error("Fixture SFTP failure after receiving payload");
  });
  try {
    await expect(download(ssh, connectionId, { remotePath, localPath, overwrite: true })).rejects.toThrow("Fixture SFTP failure");
  } finally { hook.mockRestore(); }
  expect(await files.readFile(localPath, "utf8")).toBe("original local content\n");
  expect((await files.readdir(fixture.transfers)).filter((name) => name.startsWith(".neverssh-"))).toEqual([]);
});

/** Exercise upload snapshots and SFTP path handling in an isolated real SSH fixture. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { lstat, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { download, upload } from "../src/files/transfers";
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
  connectionId = (await ssh.connect({ host: "fixture" })).connection_id as string;
  unrestricted = new SshTransport({ ...fixture.config, localTransferRoots: [] });
  const connected = (await unrestricted.connect({ host: "fixture" })).connection_id;
  if (typeof connected !== "string") throw new Error("Missing unrestricted fixture connection handle");
  unrestrictedId = connected;
}, 20000);

afterAll(async () => {
  await ssh?.close();
  await unrestricted?.close();
  await fixture.close();
}, 15000);

test("upload supports destination names near the filesystem component limit", async () => {
  const localPath = join(fixture.transfers, "long-name-source");
  const remotePath = join(fixture.workspace, "x".repeat(240));
  await writeFile(localPath, "long name payload");
  const result = await upload(ssh, connectionId, { localPath, remotePath, overwrite: false });
  expect(result.path).toBe(remotePath);
  expect(await readFile(remotePath, "utf8")).toBe("long name payload");
});

test("empty transfer roots upload an absolute source outside the fixture allowlist through its symlink", async () => {
  const source = join(fixture.root, "unrestricted-source.bin");
  const alias = join(fixture.root, "unrestricted-source-alias");
  const remotePath = join(fixture.workspace, "unrestricted-upload.bin");
  const payload = Buffer.from([0, 1, 2, 128, 255]);
  await writeFile(source, payload);
  await symlink(source, alias);
  const result = await upload(unrestricted, unrestrictedId, { localPath: alias, remotePath, overwrite: false });
  expect(result.localPath).toBe(source);
  expect(await readFile(remotePath)).toEqual(payload);
  expect((await lstat(alias)).isSymbolicLink()).toBe(true);
});

test("unrestricted uploads still require absolute regular files and respect cancellation", async () => {
  const directory = join(fixture.root, "unrestricted-source-directory");
  const source = join(fixture.root, "cancelled-unrestricted-source");
  const remotePath = join(fixture.workspace, "must-not-upload-unrestricted");
  await mkdir(directory);
  await writeFile(source, "cancelled payload");
  await expect(upload(unrestricted, unrestrictedId, { localPath: "relative-source", remotePath, overwrite: false }))
    .rejects.toThrow("localPath must be absolute");
  await expect(upload(unrestricted, unrestrictedId, { localPath: directory, remotePath, overwrite: false }))
    .rejects.toThrow("regular file");
  const controller = new AbortController();
  controller.abort();
  await expect(upload(unrestricted, unrestrictedId, { localPath: source, remotePath, overwrite: false }, undefined, controller.signal))
    .rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
  expect(await stat(remotePath).catch(() => null)).toBeNull();
});

test("transfers preserve literal quotes, backslashes, and wildcard characters", async () => {
  const localPath = join(fixture.transfers, "quoted-source");
  await writeFile(localPath, "literal filename payload");
  for (const name of ["single'quote", 'double"quote', "back\\slash", "wild*?[1]", "hash#!"]) {
    const remotePath = join(fixture.workspace, name);
    await upload(ssh, connectionId, { localPath, remotePath, overwrite: false });
    expect(await readFile(remotePath, "utf8")).toBe("literal filename payload");
    const destination = join(fixture.transfers, "received-" + name);
    await download(ssh, connectionId, { remotePath, localPath: destination, overwrite: false });
    expect(await readFile(destination, "utf8")).toBe("literal filename payload");
  }
});

test("upload follows an absent final symlink target while preserving the link", async () => {
  const localPath = join(fixture.transfers, "dangling-source");
  const remotePath = join(fixture.workspace, "dangling-link");
  const target = join(fixture.workspace, "new-parent", "target");
  await writeFile(localPath, "dangling target payload");
  await symlink(target, remotePath);
  const result = await upload(ssh, connectionId, { localPath, remotePath, overwrite: false });
  expect(result.path).toBe(target);
  expect(await readFile(target, "utf8")).toBe("dangling target payload");
  expect((await lstat(remotePath)).isSymbolicLink()).toBe(true);
});

test("upload rechecks its local source after preparing SFTP", async () => {
  const parent = join(fixture.transfers, "source-parent");
  const outside = join(fixture.root, "outside-upload");
  await mkdir(parent);
  await mkdir(outside);
  await writeFile(join(parent, "value"), "allowed payload");
  await writeFile(join(outside, "value"), "outside payload");
  const original = ssh.prepareSftp.bind(ssh);
  const hook = spyOn(ssh, "prepareSftp").mockImplementation(async (...args) => {
    await original(...args);
    await rename(parent, parent + "-original");
    await symlink(outside, parent);
  });
  try {
    await expect(upload(ssh, connectionId, {
      localPath: join(parent, "value"), remotePath: join(fixture.workspace, "must-not-upload"), overwrite: false,
    })).rejects.toThrow("outside localTransferRoots");
  } finally { hook.mockRestore(); }
});

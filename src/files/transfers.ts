/** Mediates the only tools allowed to read or write local user files. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../config";
import { type RemoteResult, SshTransport } from "../ssh/transport";
import { checkAbort } from "../errors";

/** Keep one wording for every transfer-root rejection. */
function outsideTransferRoot(): Error {
  return new Error("Local path is outside localTransferRoots; configure a dedicated transfer directory locally");
}

/** Check a resolved path is inside one configured transfer root. */
function inside(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail === "" || (tail !== ".." && !tail.startsWith("../") && !isAbsolute(tail));
}

/** Create missing local parents after proving the deepest existing ancestor is inside a transfer root. */
async function ensureParent(config: Config, parent: string): Promise<void> {
  const root = config.localTransferRoots.find((candidate) => inside(candidate, parent));
  if (!root) throw outsideTransferRoot();

  let existing = parent;
  while (!(await stat(existing).then((info) => info.isDirectory()).catch(() => false))) {
    const next = dirname(existing);
    if (next === existing) throw outsideTransferRoot();
    existing = next;
  }
  if (!inside(root, await realpath(existing))) throw outsideTransferRoot();
  await mkdir(parent, { recursive: true });
}

/** Check canonical paths, including symlinked parents, against explicitly enabled transfer roots. */
export async function transferPath(config: Config, filename: string, writing: boolean): Promise<string> {
  if (!config.localTransferRoots.length) throw new Error("Local transfers are disabled; configure localTransferRoots locally");
  if (!isAbsolute(filename)) throw new Error("localPath must be absolute");
  const normalized = resolve(filename);
  let canonical: string;
  if (writing) {
    const info = await lstat(normalized).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info && !info.isFile()) throw new Error("Download destination must be a regular file, never a symlink");
    await ensureParent(config, dirname(normalized));
    canonical = join(await realpath(dirname(normalized)), basename(normalized));
  } else {
    canonical = await realpath(normalized);
  }
  if (!config.localTransferRoots.some((root) => inside(root, canonical))) throw outsideTransferRoot();
  return canonical;
}

/** Expand tilde against HOME, while ordinary relative paths resolve against the requested base. */
function remotePath(value: string, base: string, home = base): string {
  const expanded = value === "~" ? home : value.startsWith("~/") ? posix.join(home, value.slice(2)) : value;
  return expanded.startsWith("/") ? posix.normalize(expanded) : posix.normalize(posix.join(base, expanded));
}

/** Escape one SFTP batch argument; CR/LF cannot be represented in a batch line. */
function sftpQuote(value: string): string {
  if (value.includes("\n") || value.includes("\r")) throw new Error("SFTP transfer paths cannot contain newlines");
  return value.replace(/([\\\s"'*?[\]!#])/g, "\\$1");
}

/** Resolve the remote base directory for a transfer request. */
function remoteBase(ssh: SshTransport, connectionId: string, cwd?: string): string {
  const home = ssh.cwd(connectionId);
  return cwd ? remotePath(cwd, home) : home;
}

type RemoteStat = { path: string; exists: boolean; size?: number; realpath?: string };
type RemoteHash = { path: string; size: number; sha256: string };

/** Read an opened regular file into bounded, immutable transfer bytes. */
async function readSnapshot(handle: FileHandle, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  checkAbort(signal);
  const info = await handle.stat();
  if (!info.isFile()) throw new Error("Transfer requires a regular file");
  if (info.size > maxBytes) throw new Error("File exceeds maxFileBytes");
  const data = Buffer.alloc(maxBytes + 1);
  let used = 0;
  while (used < data.length) {
    checkAbort(signal);
    const read = await handle.read(data, used, data.length - used, null);
    if (!read.bytesRead) break;
    used += read.bytesRead;
  }
  if (used > maxBytes) throw new Error("File grew beyond maxFileBytes");
  checkAbort(signal);
  return data.subarray(0, used);
}

/** Upload one bounded binary file over SFTP, reusing the authenticated ControlMaster. */
export async function upload(ssh: SshTransport, connectionId: string, args: {
  localPath: string; remotePath: string; overwrite: boolean; expectedSha256?: string | undefined;
}, cwd?: string, signal?: AbortSignal): Promise<RemoteResult> {
  checkAbort(signal);
  const requestedSource = await transferPath(ssh.config, args.localPath, false);
  await ssh.prepareSftp(connectionId, signal);
  const filename = await transferPath(ssh.config, requestedSource, false);
  // Recheck the opened descriptor so swapped symlinks and special files cannot bypass basic limits.
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer;
  try {
    data = await readSnapshot(handle, ssh.config.maxFileBytes, signal);
  } finally { await handle.close(); }

  const digest = createHash("sha256").update(data).digest("hex");
  const requested = remotePath(args.remotePath, remoteBase(ssh, connectionId, cwd), ssh.cwd(connectionId));
  const info = await ssh.run(connectionId, "stat", { path: requested }, undefined, signal) as unknown as RemoteStat;
  // Pin even an absent target: a dangling final symlink still selects its real destination.
  const remote = info.realpath ?? requested;
  if (info.exists) {
    if (args.expectedSha256) {
      const current = await ssh.run(connectionId, "hash", { path: remote }, undefined, signal) as unknown as RemoteHash;
      if (current.sha256 !== args.expectedSha256) throw new Error("Content conflict: SHA-256 does not match");
    } else if (!args.overwrite) {
      throw new Error("File exists: set overwrite=true or provide expectedSha256");
    }
  } else if (args.expectedSha256) {
    throw new Error("Content conflict: expected file does not exist");
  }

  await ssh.run(connectionId, "mkdir", { path: posix.dirname(remote) }, undefined, signal);
  const temporary = posix.join(posix.dirname(remote), `.neverssh-upload-${randomUUID()}`);
  const snapshotDirectory = await mkdtemp(join(tmpdir(), "neverssh-upload-"));
  const snapshot = join(snapshotDirectory, "payload");
  try {
    await writeFile(snapshot, data, { mode: 0o600 });
    await ssh.sftp(connectionId, [`put ${sftpQuote(snapshot)} ${sftpQuote(temporary)}`], signal);
    // The worker shares commit admission with text edits and rechecks conflicts after staging.
    const committed = await ssh.run(connectionId, "commit_upload", {
      path: remote, temporary, overwrite: args.overwrite, sha256: digest,
      ...(args.expectedSha256 ? { expectedSha256: args.expectedSha256 } : {}),
    }, undefined, signal);
    return { ...committed, localPath: filename };
  } catch (error) {
    // Cleanup must still run when the request's own cancellation signal has already fired.
    await ssh.sftp(connectionId, [`rm ${sftpQuote(temporary)}`], undefined, 10000).catch(() => {});
    throw error;
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
}

/** Download over SFTP into a private local temporary file before committing atomically. */
export async function download(ssh: SshTransport, connectionId: string, args: {
  remotePath: string; localPath: string; overwrite: boolean;
}, cwd?: string, signal?: AbortSignal): Promise<RemoteResult> {
  checkAbort(signal);
  const filename = await transferPath(ssh.config, args.localPath, true);
  await ssh.prepareSftp(connectionId, signal);
  if (!args.overwrite && await lstat(filename).then(() => true).catch(() => false)) {
    throw new Error("Local destination exists; set overwrite=true explicitly");
  }
  const requested = remotePath(args.remotePath, remoteBase(ssh, connectionId, cwd), ssh.cwd(connectionId));
  // Check existence and size without reading the file; SFTP carries the bytes once.
  const info = await ssh.run(connectionId, "stat", { path: requested }, undefined, signal) as unknown as RemoteStat;
  if (!info.exists) throw new Error("Remote file does not exist: " + requested);
  if (info.size !== undefined && info.size > ssh.config.maxFileBytes) throw new Error("Remote file exceeds maxFileBytes");
  const remote = info.realpath ?? requested;
  const temporaryDirectory = await mkdtemp(join(dirname(filename), ".neverssh-download-"));
  const temporary = join(temporaryDirectory, "payload");
  try {
    await ssh.sftp(connectionId, [`get ${sftpQuote(remote)} ${sftpQuote(temporary)}`], signal);
    const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: Buffer;
    try {
      data = await readSnapshot(handle, ssh.config.maxFileBytes, signal);
      await handle.chmod(0o600);
    } finally { await handle.close(); }
    const sha256 = createHash("sha256").update(data).digest("hex");
    // Revalidate immediately before committing; localTransferRoots is a boundary, not an OS sandbox.
    await transferPath(ssh.config, filename, true);
    checkAbort(signal);
    if (args.overwrite) await rename(temporary, filename);
    else await link(temporary, filename);
    return { path: remote, localPath: filename, size: data.length, sha256 };
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}

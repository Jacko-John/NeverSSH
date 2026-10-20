/** Mediates the only tools allowed to read or write local user files. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "./config";
import { type RemoteResult, SshTransport } from "./ssh";
import { checkAbort } from "./errors";

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


/** Resolve a remote path against the connected worker's home or an explicit cwd. */
function remotePath(value: string, base: string): string {
  const expanded = value === "~" ? base : value.startsWith("~/") ? posix.join(base, value.slice(2)) : value;
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

/** Upload one bounded binary file over SFTP, reusing the authenticated ControlMaster. */
export async function upload(ssh: SshTransport, connectionId: string, args: {
  localPath: string; remotePath: string; overwrite: boolean; expectedSha256?: string | undefined;
}, cwd?: string, signal?: AbortSignal): Promise<RemoteResult> {
  const filename = await transferPath(ssh.config, args.localPath, false);
  await ssh.prepareSftp(connectionId, signal);
  // Recheck the opened descriptor so swapped symlinks and special files cannot bypass basic limits.
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > ssh.config.maxFileBytes) throw new Error("Upload requires a regular file within maxFileBytes");
    data = Buffer.alloc(ssh.config.maxFileBytes + 1);
    let used = 0;
    while (used < data.length) {
      const read = await handle.read(data, used, data.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used > ssh.config.maxFileBytes) throw new Error("Upload grew beyond maxFileBytes");
    data = data.subarray(0, used);
  } finally { await handle.close(); }

  const digest = createHash("sha256").update(data).digest("hex");
  const requested = remotePath(args.remotePath, remoteBase(ssh, connectionId, cwd));
  const info = await ssh.run(connectionId, "stat", { path: requested }, undefined, signal) as unknown as RemoteStat;
  if (info.exists) {
    if (args.expectedSha256) {
      const current = await ssh.run(connectionId, "hash", { path: requested }, undefined, signal) as unknown as RemoteHash;
      if (current.sha256 !== args.expectedSha256) throw new Error("Content conflict: SHA-256 does not match");
    } else if (!args.overwrite) {
      throw new Error("File exists: set overwrite=true or provide expectedSha256");
    }
  } else if (args.expectedSha256) {
    throw new Error("Content conflict: expected file does not exist");
  }

  // Follow an existing final symlink as the text writer does, then replace the target atomically.
  const remote = info.exists && info.realpath ? info.realpath : requested;
  await ssh.run(connectionId, "mkdir", { path: posix.dirname(remote) }, undefined, signal);
  const temporary = `${remote}.neverssh-${randomUUID()}`;
  const snapshotDirectory = await mkdtemp(join(tmpdir(), "neverssh-upload-"));
  const snapshot = join(snapshotDirectory, "payload");
  try {
    await writeFile(snapshot, data, { mode: 0o600 });
    await ssh.sftp(connectionId, [
      `put ${sftpQuote(snapshot)} ${sftpQuote(temporary)}`,
      `rename ${sftpQuote(temporary)} ${sftpQuote(remote)}`,
    ], signal);
  } catch (error) {
    await ssh.sftp(connectionId, [`rm ${sftpQuote(temporary)}`], signal).catch(() => {});
    throw error;
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }

  const verified = await ssh.run(connectionId, "hash", { path: remote }, undefined, signal) as unknown as RemoteHash;
  if (verified.size !== data.length || verified.sha256 !== digest) throw new Error("Upload size or SHA-256 verification failed");
  return { connection_id: connectionId, path: verified.path, localPath: filename, bytesWritten: data.length, sha256: verified.sha256 };
}

/** Download over SFTP into a private local temporary file before committing atomically. */
export async function download(ssh: SshTransport, connectionId: string, args: {
  remotePath: string; localPath: string; overwrite: boolean;
}, cwd?: string, signal?: AbortSignal): Promise<RemoteResult> {
  const filename = await transferPath(ssh.config, args.localPath, true);
  await ssh.prepareSftp(connectionId, signal);
  if (!args.overwrite && await lstat(filename).then(() => true).catch(() => false)) {
    throw new Error("Local destination exists; set overwrite=true explicitly");
  }
  const remote = remotePath(args.remotePath, remoteBase(ssh, connectionId, cwd));
  // Check existence and size without reading the file; SFTP carries the bytes once.
  const info = await ssh.run(connectionId, "stat", { path: remote }, undefined, signal) as unknown as RemoteStat;
  if (!info.exists) throw new Error("Remote file does not exist: " + remote);
  if (info.size !== undefined && info.size > ssh.config.maxFileBytes) throw new Error("Remote file exceeds maxFileBytes");
  const temporary = join(dirname(filename), `.neverssh-${randomUUID()}`);
  try {
    await ssh.sftp(connectionId, [`get ${sftpQuote(remote)} ${sftpQuote(temporary)}`], signal);
    await chmod(temporary, 0o600);
    const data = await readFile(temporary);
    if (data.length > ssh.config.maxFileBytes) throw new Error("Download exceeds maxFileBytes");
    const sha256 = createHash("sha256").update(data).digest("hex");
    checkAbort(signal);
    // Revalidate immediately before committing; localTransferRoots is a boundary, not an OS sandbox.
    await transferPath(ssh.config, filename, true);
    if (args.overwrite) await rename(temporary, filename);
    else await link(temporary, filename);
    return { connection_id: connectionId, path: info.path ?? remote, localPath: filename, size: data.length, sha256 };
  } finally { await rm(temporary, { force: true }); }
}

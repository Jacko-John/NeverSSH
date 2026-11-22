/** Mediates the only tools allowed to read or write local user files. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../config";
import { type RemoteResult, SshTransport } from "../ssh/transport";
import { checkAbort } from "../errors";
import { hashPayload, withStagingFile } from "./staging";

/** Keep one wording for every transfer-root rejection. */
function outsideTransferRoot(): Error {
  return new Error("Local path is outside localTransferRoots; use a path inside a configured transfer directory");
}

/** Check a resolved path is inside one configured transfer root. */
function inside(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail === "" || (tail !== ".." && !tail.startsWith("../") && !isAbsolute(tail));
}

/** Create local parents after checking existing ancestors against any configured boundary. */
async function ensureParent(config: Config, parent: string): Promise<void> {
  if (config.localTransferRoots.length) {
    const root = config.localTransferRoots.find((candidate) => inside(candidate, parent));
    if (!root) throw outsideTransferRoot();

    let existing = parent;
    while (!(await stat(existing).then((info) => info.isDirectory()).catch(() => false))) {
      const next = dirname(existing);
      if (next === existing) throw outsideTransferRoot();
      existing = next;
    }
    if (!inside(root, await realpath(existing))) throw outsideTransferRoot();
  }
  await mkdir(parent, { recursive: true });
}

/** Resolve absolute local paths, enforcing a transfer-root boundary only when configured. */
export async function transferPath(config: Config, filename: string, writing: boolean): Promise<string> {
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
  if (config.localTransferRoots.length && !config.localTransferRoots.some((root) => inside(root, canonical))) {
    throw outsideTransferRoot();
  }
  return canonical;
}

/** Expand tilde against HOME, while ordinary relative paths resolve against the requested base. */
function resolveFrom(value: string, base: string, home: string): string {
  const expanded = value === "~" ? home : value.startsWith("~/") ? posix.join(home, value.slice(2)) : value;
  return expanded.startsWith("/") ? posix.normalize(expanded) : posix.normalize(posix.join(base, expanded));
}

/** Escape one SFTP batch argument; CR/LF cannot be represented in a batch line. */
function sftpQuote(value: string): string {
  if (value.includes("\n") || value.includes("\r")) throw new Error("SFTP transfer paths cannot contain newlines");
  return value.replace(/([\\\s"'*?[\]!#])/g, "\\$1");
}

/** File revisions and transfers must resolve the same request to the same path. */
export function remotePath(path: string, home: string, cwd?: string): string {
  return resolveFrom(path, cwd ? resolveFrom(cwd, home, home) : home, home);
}

type TransferTarget = { path: string; exists: boolean; size?: number; sha256?: string };

const READ_PAYLOAD = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type UploadOptions = { localPath: string; remotePath: string; overwrite: boolean; expectedSha256?: string | undefined };

/** Upload one bounded binary file over SFTP, reusing the authenticated ControlMaster. */
export async function upload(ssh: SshTransport, connectionId: string, args: UploadOptions, cwd?: string, signal?: AbortSignal): Promise<RemoteResult> {
  checkAbort(signal);
  const requestedSource = await transferPath(ssh.config, args.localPath, false);
  await ssh.prepareSftp(connectionId, signal);
  const filename = await transferPath(ssh.config, requestedSource, false);
  return withStagingFile(join(tmpdir(), "neverssh-upload-"), async snapshot => {
    const handle = await open(filename, READ_PAYLOAD);
    const { sha256 } = await hashPayload(handle, ssh.config.maxFileBytes, signal, snapshot).finally(() => handle.close());
    const requested = remotePath(args.remotePath, ssh.cwd(connectionId), cwd);
    const remote = await uploadTarget(ssh, connectionId, args, requested, signal);
    const temporary = posix.join(posix.dirname(remote), `.neverssh-upload-${randomUUID()}`);
    try {
      await ssh.sftp(connectionId, [`put ${sftpQuote(snapshot)} ${sftpQuote(temporary)}`], signal);
      const result = await ssh.run(connectionId, "commit_upload", {
        path: remote, temporary, overwrite: args.overwrite, sha256,
        ...(args.expectedSha256 ? { expectedSha256: args.expectedSha256 } : {}),
      }, undefined, signal);
      return { ...result, localPath: filename };
    } catch (error) {
      // Cleanup must still run when the request's own cancellation signal has already fired.
      await ssh.sftp(connectionId, [`rm ${sftpQuote(temporary)}`], undefined, 10000).catch(() => {});
      throw error;
    }
  });
}

/** Pin the remote target before staging. The worker checks conflicts again at commit. */
async function uploadTarget(ssh: SshTransport, connectionId: string, args: UploadOptions,
  requested: string, signal?: AbortSignal): Promise<string> {
  const target = await ssh.run(connectionId, "prepare_upload", {
    path: requested, ...(args.expectedSha256 && { checkRevision: true }),
  }, undefined, signal) as unknown as TransferTarget;
  if (args.expectedSha256) {
    if (!target.exists) throw new Error("Content conflict: expected file does not exist");
    if (target.sha256 !== args.expectedSha256) throw new Error("Content conflict: SHA-256 does not match");
  } else if (target.exists && !args.overwrite) {
    throw new Error("File exists: set overwrite=true or provide expectedSha256");
  }
  return target.path;
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
  const requested = remotePath(args.remotePath, ssh.cwd(connectionId), cwd);
  // Check existence and size without reading the file; SFTP carries the bytes once.
  const info = await ssh.run(connectionId, "stat", { path: requested }, undefined, signal) as unknown as TransferTarget;
  if (!info.exists) throw new Error("Remote file does not exist: " + requested);
  if (info.size !== undefined && info.size > ssh.config.maxFileBytes) throw new Error("Remote file exceeds maxFileBytes");
  const remote = info.path;
  return withStagingFile(join(dirname(filename), ".neverssh-download-"), async temporary => {
    await ssh.sftp(connectionId, [`get ${sftpQuote(remote)} ${sftpQuote(temporary)}`], signal);
    const handle = await open(temporary, READ_PAYLOAD);
    let payload;
    try {
      payload = await hashPayload(handle, ssh.config.maxFileBytes, signal);
      await handle.chmod(0o600);
    } finally { await handle.close(); }
    // Revalidate the destination type and any configured root boundary before committing.
    await transferPath(ssh.config, filename, true);
    checkAbort(signal);
    if (args.overwrite) await rename(temporary, filename);
    else await link(temporary, filename);
    return { path: remote, localPath: filename, ...payload };
  });
}

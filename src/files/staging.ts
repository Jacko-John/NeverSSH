/** Local SFTP staging and verification, bounded independently of the configured file limit. */
import { createHash } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { checkAbort } from "../errors";

/** Keep the payload private until the caller commits it, and remove it on every exit. */
export async function withStagingFile<T>(prefix: string, use: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(prefix);
  try { return await use(join(directory, "payload")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** Hash the bytes read from the checked descriptor; uploads also copy those exact bytes to staging. */
export async function hashPayload(source: FileHandle, limit: number, signal?: AbortSignal, copyTo?: string) {
  checkAbort(signal);
  const info = await source.stat();
  if (!info.isFile()) throw new Error("Transfer requires a regular file");
  if (info.size > limit) throw new Error("File exceeds maxFileBytes");
  const hash = createHash("sha256");
  // A regular file's reported size can change, or start at zero on a virtual filesystem.
  const buffer = Buffer.allocUnsafe(Math.min(128 * 1024, Math.max(4096, info.size + 1), limit + 1));
  let size = 0;
  const copy = copyTo === undefined ? undefined : await open(copyTo, "wx", 0o600);
  try {
    for (;;) {
      checkAbort(signal);
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, limit - size + 1), null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error("File grew beyond maxFileBytes");
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (copy) await copy.writeFile(bytes);
    }
    checkAbort(signal);
    return { size, sha256: hash.digest("hex") };
  } finally { await copy?.close(); }
}

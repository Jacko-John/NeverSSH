/** Remember file revisions read or written in this MCP process, mirroring Read-before-Edit. */
import { posix } from "node:path";

const MAX_REVISIONS = 1024;

type Revision = { sha256: string };

/** Track the latest revision per request spelling and per resolved remote path. */
export class FileRevisions {
  private readonly revisions = new Map<string, Revision>();

  /** Key the normalized request spelling so equivalent relative paths share a revision. */
  private requestKey(connectionId: string, filePath: string): string {
    return `${connectionId}\0${posix.normalize(filePath)}`;
  }

  /** Also key the resolved absolute path so later absolute references still match. */
  private absoluteKey(connectionId: string, path: string): string {
    return `${connectionId}\0\0${path}`;
  }

  /** Record a successful read or write; the remote helper supplies the resolved path and sha256. */
  remember(connectionId: string, filePath: string, result: Record<string, unknown>): void {
    if (typeof result.path !== "string" || typeof result.sha256 !== "string") return;
    const revision = { sha256: result.sha256 };
    for (const key of [this.requestKey(connectionId, filePath), this.absoluteKey(connectionId, result.path)]) {
      this.revisions.delete(key);
      this.revisions.set(key, revision);
    }
    while (this.revisions.size > MAX_REVISIONS) {
      const oldest = this.revisions.keys().next().value;
      if (oldest === undefined) break;
      this.revisions.delete(oldest);
    }
  }

  /** Missing means this MCP process has not read or written the file. */
  get(connectionId: string, filePath: string): Revision | undefined {
    return this.revisions.get(this.requestKey(connectionId, filePath)) ?? this.revisions.get(this.absoluteKey(connectionId, filePath));
  }
}

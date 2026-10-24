/** Remember file revisions read or written in this MCP process, mirroring Read-before-Edit. */
import { posix } from "node:path";

const MAX_REVISIONS = 1024;

type Revision = { sha256: string };
type Remembered = { kind: "revision"; value: Revision } | { kind: "alias"; canonicalKey: string };

/** Resolve request aliases to one revision per canonical path, within a shared entry budget. */
export class FileRevisions {
  private readonly revisions = new Map<string, Remembered>();

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
    // Refresh the canonical revision once; every retained spelling follows this entry.
    const canonicalKey = this.absoluteKey(connectionId, result.path);
    const entries: [string, Remembered][] = [
      [canonicalKey, { kind: "revision", value: { sha256: result.sha256 } }],
      [this.requestKey(connectionId, filePath), { kind: "alias", canonicalKey }],
    ];
    for (const [key, value] of entries) {
      this.revisions.delete(key);
      this.revisions.set(key, value);
    }

    // Evict aliases with their destination so no dangling references consume the budget.
    while (this.revisions.size > MAX_REVISIONS) {
      const oldest = this.revisions.keys().next().value;
      if (oldest === undefined) break;
      const removed = this.revisions.get(oldest)!;
      this.revisions.delete(oldest);
      if (removed.kind === "revision") {
        for (const [key, value] of this.revisions) {
          if (value.kind === "alias" && value.canonicalKey === oldest) this.revisions.delete(key);
        }
      }
    }
  }

  /** Missing means this MCP process has not read or written the file. */
  get(connectionId: string, filePath: string): Revision | undefined {
    const alias = this.revisions.get(this.requestKey(connectionId, filePath));
    const canonicalKey = alias?.kind === "alias" ? alias.canonicalKey : this.absoluteKey(connectionId, filePath);
    const revision = this.revisions.get(canonicalKey);
    return revision?.kind === "revision" ? revision.value : undefined;
  }
}

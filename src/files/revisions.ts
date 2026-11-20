/** Remember file revisions read or written in this MCP process, mirroring Read-before-Edit. */
import { posix } from "node:path";

const MAX_REVISIONS = 1024;
const MAX_PAGE_RANGES = 32;

type Revision = { sha256: string };
type PageRange = [first: number, last: number];
type PartialRead = { unit: "page" | "line"; total: number; ranges: PageRange[] };
type FileState = Revision & { observation: number; partial?: PartialRead };
type Remembered = { kind: "revision"; value: FileState } | { kind: "alias"; canonicalKey: string; observation: number };

/** Keep disjoint page intervals until they cover the revision. Bound sparse, out-of-order reads. */
function partialRead(previous: FileState | undefined, result: Record<string, unknown>): PartialRead | undefined {
  const { startLine: start, endLine: end, totalLines: total } = result;
  if (typeof start !== "number" || typeof end !== "number" || typeof total !== "number" || !total) return;
  if (previous && !previous.partial) return;
  const unit = result.kind === "document" ? "page" : "line";
  const existing = previous?.partial;
  const ranges: PageRange[] = existing?.unit === unit && existing.total === total ? [...existing.ranges] : [];
  if (start <= end) ranges.push([start, end]);
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: PageRange[] = [];
  for (const [first, last] of ranges) {
    const tail = merged.at(-1);
    if (tail && first <= tail[1] + 1) tail[1] = Math.max(tail[1], last);
    else merged.push([first, last]);
  }
  if (merged[0]?.[0] === 1 && merged[0][1] >= total) return;
  return { unit, total, ranges: merged.slice(0, MAX_PAGE_RANGES) };
}

/** Resolve request aliases to one revision per canonical path, within a shared entry budget. */
export class FileRevisions {
  private readonly revisions = new Map<string, Remembered>();
  private sequence = 0;
  private evictedThrough = 0;

  /** Order a read or shell view at dispatch, even if other observations arrive before its result. */
  nextObservation(): number {
    return ++this.sequence;
  }

  /** Key the normalized request spelling so equivalent relative paths share a revision. */
  private requestKey(connectionId: string, filePath: string): string {
    return `${connectionId}\0${posix.normalize(filePath)}`;
  }

  /** Also key the resolved absolute path so later absolute references still match. */
  private absoluteKey(connectionId: string, path: string): string {
    return `${connectionId}\0\0${path}`;
  }

  /** Track the observed bytes separately from whether enough pages were delivered to allow a mutation. */
  remember(connectionId: string, filePath: string, result: Record<string, unknown>, observation = this.nextObservation()): void {
    if (typeof result.path !== "string" || typeof result.sha256 !== "string") return;
    // Refresh the canonical revision once; every retained spelling follows this entry.
    const canonicalKey = this.absoluteKey(connectionId, result.path);
    const previous = this.revisions.get(canonicalKey);
    const prior = previous?.kind === "revision" ? previous.value : undefined;
    const lastAlias = this.observed(connectionId, filePath);
    const latest = Math.max(prior?.observation ?? this.evictedThrough, lastAlias?.observation ?? this.evictedThrough);
    const sameBytes = prior?.sha256 === result.sha256 ? prior : undefined;
    const partial = partialRead(sameBytes, result);
    if (observation < latest) {
      // Late pages may extend coverage of identical bytes without changing a newer
      // revision, view format, or alias binding.
      if (sameBytes && !partial) delete sameBytes.partial;
      else if (partial && sameBytes?.partial?.unit === partial.unit && sameBytes.partial.total === partial.total) {
        sameBytes.partial = partial;
      }
      return;
    }
    const state: FileState = { sha256: result.sha256, observation };
    if (partial) state.partial = partial;
    const entries: [string, Remembered][] = [
      [canonicalKey, { kind: "revision", value: state }],
      [this.requestKey(connectionId, filePath), { kind: "alias", canonicalKey, observation }],
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
      // Missing entries may once have held a newer observation than an old task result.
      const retiredObservation = removed.kind === "revision" ? removed.value.observation : removed.observation;
      this.evictedThrough = Math.max(this.evictedThrough, retiredObservation);
      this.revisions.delete(oldest);
      if (removed.kind === "revision") {
        for (const [key, value] of this.revisions) {
          if (value.kind === "alias" && value.canonicalKey === oldest) this.revisions.delete(key);
        }
      }
    }
  }

  private observed(connectionId: string, filePath: string): FileState | undefined {
    const alias = this.revisions.get(this.requestKey(connectionId, filePath));
    const canonicalKey = alias?.kind === "alias" ? alias.canonicalKey : this.absoluteKey(connectionId, filePath);
    const revision = this.revisions.get(canonicalKey);
    return revision?.kind === "revision" ? revision.value : undefined;
  }

  /** Compare with the newest retained observation, even if that observation was a partial read. */
  readChange(connectionId: string, filePath: string, result: Record<string, unknown>, observation: number): "changed" | "superseded" | undefined {
    if (typeof result.path !== "string" || typeof result.sha256 !== "string") return;
    const alias = this.observed(connectionId, filePath);
    const record = this.revisions.get(this.absoluteKey(connectionId, result.path));
    const canonical = record?.kind === "revision" ? record.value : undefined;
    const latest = alias && (!canonical || alias.observation > canonical.observation) ? alias : canonical;
    if (!latest || latest.sha256 === result.sha256) return;
    return latest.observation > observation ? "superseded" : "changed";
  }

  /** Only a complete read of the same revision, an eligible shell view, or a write authorizes editing. */
  get(connectionId: string, filePath: string): Revision | undefined {
    const state = this.observed(connectionId, filePath);
    return state && !state.partial ? { sha256: state.sha256 } : undefined;
  }
}

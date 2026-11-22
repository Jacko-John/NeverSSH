/** Track the versions of scoped instructions observed, shown, and confirmed in one workspace. */
import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { ToolError } from "../errors";
import type { Instruction, InstructionReview, RuleAcknowledgment, WorkspaceContext } from "./types";

export const MAX_KNOWN_RULES = 2048;

type RuleVersion = {
  receipt: string; scope: string; sha256: string | null; insertion: number;
  shown: boolean; replacesShown: boolean; confirmedAt?: number;
};
type Entry = { version: RuleVersion; instruction?: Instruction };
export type RuleSnapshot = { history: WorkspaceRules; versions: ReadonlyMap<string, RuleVersion | undefined>; entries: readonly Entry[] };
type RuleContext = Pick<WorkspaceContext, "instructions" | "rule_scopes">;

/** v0.7 clients copy one code back into the original file call. Recompute it from the full snapshot. */
function legacyRetryCode(view: RuleSnapshot): string {
  const receipts = view.entries.map(entry => entry.version.receipt).sort();
  return createHash("sha256").update("file-review:").update(receipts.join("")).digest("hex");
}

/** Return the version receipts alongside the rules shown, without keeping a record of the response. */
function ruleNotice(entries: Entry[]): InstructionReview | undefined {
  if (!entries.length) return;
  const updated: Instruction[] = [];
  const removals: RuleVersion[] = [];
  for (const entry of entries) {
    if (entry.instruction) updated.push(entry.instruction);
    else removals.push(entry.version);
  }
  const token = entries.length === 1 ? entries[0]!.version.receipt : entries.map(entry => entry.version.receipt).sort();
  // Keep removals in their original registration order across different ancestor chains.
  const removed = removals.sort((a, b) => a.insertion - b.insertion)
    .map(({ scope }) => ({ path: posix.join(scope, "AGENTS.md"), scope }));
  return { updated, removed, token, changed: entries.some(entry => entry.version.replacesShown) };
}

export function retryInspection(): ToolError {
  return new ToolError("WORKSPACE_RULES_RETRY", "Workspace guidance changed during inspection. Retry the operation in the same workspace. Nothing was executed.");
}

function historyFull(): ToolError {
  return new ToolError("WORKSPACE_REOPEN_REQUIRED", "Instruction delivery history is full. Reopen the project with ssh_workspace_open before continuing. Nothing was executed.");
}

export class WorkspaceRules {
  // Each inspected directory has exactly one rule source, its own AGENTS.md.
  private readonly latest = new Map<string, RuleVersion>();
  // Also remember observations of absent rules: an older inspection must not resurrect one.
  private readonly observedAt = new Map<string, number>();
  private evictedBefore = 0;
  private confirmation = 0;
  private insertion = 0;
  private overflow = false;
  // A condition describes the last approved read's directory scopes and their current contents.
  private permitted: string | undefined;

  get confirmedThrough(): number { return this.confirmation; }
  get readCondition(): string | undefined { return this.permitted; }
  /** Apply a whole remote inspection together. A conflicting older result must be fetched again. */
  observe(context: RuleContext, order: number, mode: "access" | "refresh" | "reread" = "access"): RuleSnapshot | undefined {
    if (this.overflow && mode === "access") throw historyFull();
    const versions = new Map<string, RuleVersion | undefined>();
    const entries: Entry[] = [];
    let size = this.latest.size;
    let changed = false;
    const stage = (scope: string, instruction?: Instruction): boolean => {
      let version = this.latest.get(scope);
      const sha256 = instruction?.sha256 ?? null;
      if ((version?.sha256 ?? null) !== sha256) {
        if (order < (this.observedAt.get(scope) ?? this.evictedBefore)) return false;
        changed = true;
        const replacesShown = !!version && (version.shown || version.replacesShown);
        if (!instruction && !replacesShown) {
          // No response ever showed this rule. Its disappearance needs no acknowledgment.
          size--;
          version = undefined;
        } else {
          if (!version) size++;
          version = { receipt: randomBytes(32).toString("hex"), scope, sha256, replacesShown, shown: false,
            insertion: version?.insertion ?? ++this.insertion };
        }
      }
      versions.set(scope, version);
      if (version) entries.push(instruction ? { version, instruction } : { version });
      return true;
    };
    for (const rule of context.instructions) {
      if (versions.has(rule.scope)) throw new ToolError("REMOTE_OPERATION_FAILED", "Duplicate AGENTS.md source in a workspace scope");
      if (!stage(rule.scope, rule)) return;
    }
    for (const scope of context.rule_scopes) {
      if (!versions.has(scope) && !stage(scope)) return;
    }
    // Check for superseded observations before a reopen replaces the history, even at capacity.
    const full = this.overflow || size > MAX_KNOWN_RULES;
    if (mode === "reread" || (mode === "refresh" && full)) {
      return new WorkspaceRules().observe(context, order);
    }
    if (full) {
      this.overflow = true;
      this.permitted = undefined;
      throw historyFull();
    }
    if (changed) {
      this.permitted = undefined;
      for (const [scope, version] of versions) {
        if (version) this.latest.set(scope, version);
        else this.latest.delete(scope);
      }
    }
    for (const scope of context.rule_scopes) {
      if ((this.observedAt.get(scope) ?? this.evictedBefore) >= order) continue;
      this.observedAt.delete(scope);
      this.observedAt.set(scope, order);
    }
    // Empty directories do not consume rule history. On eviction only an older conflicting
    // inspection has to retry; a fresh operation can always make progress.
    while (this.observedAt.size > MAX_KNOWN_RULES) {
      const [scope, seen] = this.observedAt.entries().next().value!;
      this.evictedBefore = Math.max(this.evictedBefore, seen);
      this.observedAt.delete(scope);
    }
    return { history: this, versions, entries };
  }

  /** Include additions since preparation, even if the original snapshot contained no rule. */
  isCurrent(view: RuleSnapshot): boolean {
    for (const [scope, version] of view.versions) {
      if (this.latest.get(scope) !== version) return false;
    }
    return true;
  }

  /** Only a returned receipt can confirm a version. A partial receipt leaves other scopes pending. */
  review(view: RuleSnapshot, confirmedBefore: number, ack?: RuleAcknowledgment, condition?: string): InstructionReview | undefined {
    if (this.overflow) throw historyFull();
    if (!this.isCurrent(view)) throw retryInspection();
    const tokens = ack && typeof ack !== "string" ? new Set(ack) : undefined;
    const legacyRetry = typeof ack === "string" && view.entries.length > 1 && ack === legacyRetryCode(view);
    const pending: Entry[] = [];
    for (const entry of view.entries) {
      const version = entry.version;
      if (version.confirmedAt !== undefined && version.confirmedAt <= confirmedBefore) continue;
      if (ack === version.receipt || tokens?.has(version.receipt) || legacyRetry) {
        version.confirmedAt ??= ++this.confirmation;
      } else {
        pending.push(entry);
      }
    }
    const review = ruleNotice(pending);
    if (review && pending.length > 1) review.legacyRetryCode = legacyRetryCode(view);
    if (!review && condition) this.permitted = condition;
    return review;
  }

  /** Bash shows new guidance once. Opening also offers another receipt for unconfirmed root rules. */
  presentation(view: RuleSnapshot, opening: boolean): InstructionReview | undefined {
    return ruleNotice(view.entries.filter(({ version }) => this.latest.get(version.scope) === version &&
      (opening ? version.confirmedAt === undefined : !version.shown)));
  }

  /** Commit presentation only for versions that still match the inspected files. */
  displayed(view: RuleSnapshot): void {
    for (const { version } of view.entries) {
      if (this.latest.get(version.scope) === version) version.shown = true;
    }
  }
}

/** Bind project context to explicit remote handles without changing the client's local workspace. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { cleanString } from "../config";
import { checkAbort, ToolError } from "../errors";
import { ShortIds } from "../ids";
import type { SshTransport } from "../ssh/transport";
import type { Instruction, InstructionDelta, InstructionReview, PreparedScope, SkillRead, SkillSummary, WorkspaceContext, WorkspaceScope } from "./types";

const MAX_WORKSPACES = 128;
const MAX_KNOWN_RULES = 2048;
const absolutePath = cleanString.max(4096).refine((value) => posix.isAbsolute(value), "Expected an absolute remote path");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const warnings = z.array(z.string().max(8192)).max(2048);
const remoteContextSchema = z.strictObject({
  root: absolutePath,
  paths: z.array(absolutePath).min(1).max(64),
  rule_scope_leaves: z.array(absolutePath).min(1).max(256),
  instructions: z.array(z.strictObject({ path: absolutePath, scope: absolutePath, sha256: digest, content: z.string().max(131072) })).max(MAX_KNOWN_RULES),
  skill_files: z.array(z.strictObject({ path: absolutePath, scope: absolutePath, content: z.string().max(65536) })).max(128),
  project_files: z.array(absolutePath).max(8192),
  git: z.strictObject({ root: absolutePath.nullable(), branch: z.string().nullable(), status: z.string().max(65536), omitted: z.number().int().nonnegative() }).nullable(),
  warnings,
});
const remoteSkillSchema = z.strictObject({
  path: absolutePath, directory: absolutePath, content: z.string().max(131072), sha256: digest,
  resources: z.array(cleanString.max(4096)).max(128), warnings,
});
const metadataSchema = z.object({ name: cleanString.trim().min(1).max(64), description: cleanString.trim().min(1).max(1024) });
type RemoteContext = z.infer<typeof remoteContextSchema>;
type WorkspaceTransport = Pick<SshTransport, "run" | "cwd"> & {
  sessions(): { sessions: { connection_id: string }[] };
  get(id: string): unknown;
};
type KnownRule = { scope: string; sha256: string | null; version: number; confirmed: boolean };
type RuleHistory = ReadonlyMap<string, KnownRule>;
type Workspace = {
  id: string; connectionId: string; root: string; skillDirectories: string[]; epoch: number;
  rules: RuleHistory; skills: Map<string, SkillSummary>; rulesOverflow: boolean;
  displayed: Map<string, Pick<Instruction, "scope" | "sha256">>;
};
type RuleInspection = { knownAtStart: RuleHistory; inspectedWith: RuleHistory; rechecked: boolean };
type PendingDelivery = { workspace: Workspace; epoch: number; catalog: boolean; inspection: RuleInspection };
type ContextDetails = Omit<WorkspaceContext, "workspace_id" | "connection_id">;
type OperationScope = { connection_id: string; workspace_id?: undefined } | { connection_id?: undefined; workspace_id: string };

function retryInspection(): ToolError {
  return new ToolError("WORKSPACE_RULES_RETRY", "Workspace guidance changed during inspection. Retry the operation to check the current rules. Nothing was executed.");
}

/** Preserve the version of unchanged rules, including a removal awaiting acknowledgment. */
function ruleSnapshot(history: RuleHistory, context: ContextDetails): Map<string, KnownRule> {
  const snapshot = new Map<string, KnownRule>();
  const inspected = new Set(context.rule_scopes);
  for (const rule of context.instructions) {
    const previous = history.get(rule.path);
    snapshot.set(rule.path, previous?.sha256 === rule.sha256 && previous.scope === rule.scope ? previous :
      { scope: rule.scope, sha256: rule.sha256, version: (previous?.version ?? 0) + 1, confirmed: false });
  }
  for (const [path, previous] of history) {
    if (inspected.has(previous.scope) && !snapshot.has(path)) {
      snapshot.set(path, previous.sha256 === null ? previous :
        { scope: previous.scope, sha256: null, version: previous.version + 1, confirmed: false });
    }
  }
  return snapshot;
}

/** Compare remote POSIX ancestry without claiming an operating-system sandbox. */
function within(root: string, path: string): boolean {
  const relative = posix.relative(root, path);
  return relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
}

/** Keep names printable and reserve the namespace separator without changing ordinary names. */
function shortSkillName(skill: SkillSummary): string {
  return encodeURIComponent(skill.name);
}

/** Distinguish same-named project and shared skills without exposing storage paths. */
function scopedSkillName(root: string, skill: SkillSummary): string {
  const scope = within(root, skill.directory) ? "project" : "shared";
  return `${scope}@${shortSkillName(skill)}`;
}

/** Build one bounded catalog before publishing or replacing any workspace state. */
function skillCatalog(root: string, files: RemoteContext["skill_files"], warnings: string[]): SkillSummary[] {
  const skills: SkillSummary[] = [];
  for (const file of files) {
    try {
      const metadata = metadataSchema.parse(Bun.YAML.parse(file.content));
      skills.push({ ...metadata, callName: "", path: file.path, directory: posix.dirname(file.path), scope: file.scope });
    } catch {
      warnings.push(`Skill metadata is invalid or missing name/description: ${file.path}`);
    }
  }
  const counts = new Map<string, number>();
  for (const skill of skills) {
    const name = shortSkillName(skill);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = new Set<string>();
  for (const skill of skills) {
    const name = shortSkillName(skill);
    const base = (counts.get(name) ?? 0) > 1 ? scopedSkillName(root, skill) : name;
    let candidate = base;
    let suffix = 2;
    while (names.has(candidate)) candidate = `${base}-${suffix++}`;
    names.add(candidate);
    skill.callName = candidate;
  }
  return skills;
}

/** Validate remote context and parse skill metadata without changing delivery history. */
function contextDetails(remote: RemoteContext, root: string, catalog: boolean): ContextDetails {
  if (remote.root !== root || [...remote.paths, ...remote.rule_scope_leaves].some((path) => !within(root, path))) {
    throw new ToolError("WORKSPACE_PATH_CHANGED", "Workspace paths changed; reopen the project with ssh_workspace_open before continuing");
  }
  const { skill_files, rule_scope_leaves, ...details } = remote;
  const inspected = new Set<string>();
  for (const leaf of rule_scope_leaves) {
    for (let scope = leaf; !inspected.has(scope); scope = posix.dirname(scope)) {
      inspected.add(scope);
      if (scope === root) break;
    }
  }
  const warnings = [...details.warnings];
  const skills = catalog ? skillCatalog(root, skill_files, warnings) : [];
  return { ...details, rule_scopes: [...inspected], skills, warnings };
}

/** Own bounded project state for one MCP process; reconnecting requires opening a new handle. */
export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly ids = new ShortIds();
  private readonly pending = new WeakMap<WorkspaceContext, PendingDelivery>();
  private readonly reviewKey = randomBytes(32);

  constructor(private readonly ssh: WorkspaceTransport) {}

  /** Reject retired connections without assuming their transport records still exist. */
  private assertReady(connectionId: string): void {
    if (!this.ssh.sessions().sessions.some((connection) => connection.connection_id === connectionId)) {
      throw new ToolError("CONNECTION_LOST", "Reconnect and reopen the project with ssh_workspace_open");
    }
  }

  private get(id: string): Workspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new ToolError("WORKSPACE_NOT_FOUND", "Open the project with ssh_workspace_open");
    this.assertReady(workspace.connectionId);
    return workspace;
  }

  /** Discover the canonical project before publishing its handle; formatting owns delivery. */
  async open(connectionId: string, path: string, skillDirectories: string[], signal?: AbortSignal): Promise<WorkspaceContext> {
    checkAbort(signal);
    this.ssh.get(connectionId);
    const remote = remoteContextSchema.parse(await this.ssh.run(connectionId, "workspace_open", {
      path, skillDirectories,
    }, undefined, signal));
    checkAbort(signal);
    this.assertReady(connectionId);
    const details = contextDetails(remote, remote.root, true);
    const available = new Set(this.ssh.sessions().sessions.map((connection) => connection.connection_id));
    for (const [id, workspace] of this.workspaces) {
      if (!available.has(workspace.connectionId)) this.workspaces.delete(id);
    }
    let workspace = [...this.workspaces.values()].find((entry) =>
      entry.connectionId === connectionId && entry.root === remote.root &&
      entry.skillDirectories.length === skillDirectories.length &&
      entry.skillDirectories.every((directory, index) => directory === skillDirectories[index]));
    if (!workspace) {
      if (this.workspaces.size >= MAX_WORKSPACES) throw new ToolError("WORKSPACE_LIMIT", "Close an unused connection before opening more workspaces");
      workspace = { id: `ws_${this.ids.next()}`, connectionId, root: remote.root, skillDirectories: [...skillDirectories], epoch: 0,
        rules: new Map(), skills: new Map(), rulesOverflow: false, displayed: new Map() };
    }
    // Everything that can reject the discovered context has completed; publish the reset together.
    workspace.epoch++;
    workspace.rules = new Map();
    workspace.displayed.clear();
    workspace.skills.clear();
    workspace.rulesOverflow = false;
    this.workspaces.set(workspace.id, workspace);
    return this.contextResult(workspace, details, true);
  }

  /** Resolve the project path and collect the rules for file access or a shell command's cwd. */
  async prepare(scope: WorkspaceScope, path: string, signal?: AbortSignal, intent: "file" | "bash" = "file"): Promise<PreparedScope> {
    this.validateScope(scope);
    checkAbort(signal);
    if (scope.connection_id !== undefined) {
      this.ssh.get(scope.connection_id);
      return { connectionId: scope.connection_id, path };
    }
    const workspace = this.get(scope.workspace_id);
    const epoch = workspace.epoch;
    // An acknowledgment from a concurrent request applies to later calls. Keep the
    // starting state so this request still needs a receipt for its outstanding changes.
    const inspection = { knownAtStart: workspace.rules, inspectedWith: workspace.rules, rechecked: false };
    for (;;) {
      const remote = remoteContextSchema.parse(await this.ssh.run(workspace.connectionId, "workspace_context", {
        root: workspace.root, paths: [path],
      }, workspace.root, signal));
      checkAbort(signal);
      this.assertCurrent(workspace, epoch,
        "The workspace was reopened during preparation. Reopen it with ssh_workspace_open, then retry. Nothing was executed.");
      if (workspace.rulesOverflow) {
        throw new ToolError("WORKSPACE_REOPEN_REQUIRED", "Instruction delivery history is full. Reopen the project with ssh_workspace_open before continuing. Nothing was executed.");
      }
      const details = contextDetails(remote, workspace.root, false);
      if (intent === "file" && this.inspectionConflicts(inspection, workspace, details)) {
        // Another request has observed conflicting rules. Inspect once more before
        // issuing a receipt, then ask the caller to retry if the rule keeps changing.
        if (inspection.rechecked) throw retryInspection();
        inspection.inspectedWith = workspace.rules;
        inspection.rechecked = true;
        continue;
      }
      const context = this.contextResult(workspace, details, false, inspection);
      // The worker returns the lexical path followed by its checked canonical target, if different.
      return { connectionId: workspace.connectionId, path: context.paths.at(-1)!, context };
    }
  }

  /** Admit file access only after the caller confirms the applicable versions. */
  reviewGuidance(prepared: PreparedScope, acknowledgment?: string): InstructionReview | undefined {
    const context = prepared.context;
    if (!context) return;
    const pending = this.currentDelivery(context);
    if (!pending || pending.workspace.rulesOverflow) {
      throw new ToolError("WORKSPACE_REOPEN_REQUIRED", "Workspace guidance changed during preparation. Reopen with ssh_workspace_open, then retry. Nothing was executed.");
    }
    const { workspace, inspection } = pending;
    if (this.inspectionConflicts(inspection, workspace, context)) throw retryInspection();
    const snapshot = ruleSnapshot(workspace.rules, context);
    const unconfirmed = new Set<string>();
    for (const [path, rule] of snapshot) {
      const atStart = inspection.knownAtStart.get(path);
      if (!rule.confirmed || !atStart?.confirmed || atStart.version !== rule.version) unconfirmed.add(path);
    }
    if (!unconfirmed.size) {
      if (inspection.rechecked) throw retryInspection();
      return;
    }
    // The receipt authenticates the exact observed rule versions and both path spellings.
    // Unrelated reviews do not change it, and no outstanding tokens need to be retained.
    const versions = [...snapshot.keys()].sort().map((path) => {
      const rule = snapshot.get(path)!;
      return [path, rule.scope, rule.sha256, rule.version];
    });
    const token = createHmac("sha256", this.reviewKey).update(JSON.stringify([
      workspace.id, workspace.epoch, context.paths, [...context.rule_scopes].sort(), versions,
    ])).digest("hex");
    const supplied = Buffer.from(acknowledgment ?? "");
    if (supplied.length === token.length && timingSafeEqual(supplied, Buffer.from(token))) {
      const confirmed = new Map(workspace.rules);
      for (const path of unconfirmed) confirmed.set(path, { ...snapshot.get(path)!, confirmed: true });
      if (confirmed.size > MAX_KNOWN_RULES) {
        throw new ToolError("WORKSPACE_REOPEN_REQUIRED", "Instruction delivery history is full. Reopen the project with ssh_workspace_open before continuing. Nothing was executed.");
      }
      workspace.rules = confirmed;
      return;
    }
    const updated = context.instructions.filter((rule) => unconfirmed.has(rule.path));
    const removed = [...snapshot].filter(([path, rule]) => unconfirmed.has(path) && rule.sha256 === null)
      .map(([path, rule]) => ({ path, scope: rule.scope }));
    return { updated, removed, token };
  }

  /** Resolve cwd without changing other calls' defaults; the remote inspection checks symlinks. */
  path(scope: WorkspaceScope, path: string, cwd?: string): string {
    this.validateScope(scope);
    if (scope.workspace_id === undefined) return path;
    const workspace = this.get(scope.workspace_id);
    const home = this.ssh.cwd(workspace.connectionId);
    const expand = (value: string) => value === "~" ? home : value.startsWith("~/") ? posix.join(home, value.slice(2)) : value;
    return posix.resolve(workspace.root, expand(cwd ?? "."), expand(path));
  }

  /** Preserve completed operation results while suppressing guidance from retired workspace state. */
  guidance(context: WorkspaceContext): InstructionDelta {
    const pending = this.currentDelivery(context);
    return pending ? this.displayChanges(pending.workspace, context) : { updated: [], removed: [] };
  }

  /** Record what was displayed. An explicit file acknowledgment owns admission. */
  delivered(context: WorkspaceContext): void {
    const pending = this.currentDelivery(context);
    this.pending.delete(context);
    if (!pending) return;
    const { workspace, catalog } = pending;
    const delta = this.displayChanges(workspace, context);
    for (const rule of delta.removed) workspace.displayed.delete(rule.path);
    // Bash can finish with an older rule snapshot after a newer file review. Preserve
    // its display history without replacing the newer version used for file admission.
    let changes: Map<string, KnownRule> | undefined;
    for (const [path, rule] of ruleSnapshot(workspace.rules, context)) {
      const previous = workspace.rules.get(path);
      if (rule === previous || previous?.version !== pending.inspection.inspectedWith.get(path)?.version) continue;
      changes ??= new Map(workspace.rules);
      if (!previous && changes.size >= MAX_KNOWN_RULES) {
        workspace.rulesOverflow = true;
        continue;
      }
      changes.set(path, rule);
    }
    if (changes) workspace.rules = changes;
    for (const rule of delta.updated) {
      if (workspace.rules.has(rule.path)) workspace.displayed.set(rule.path, { scope: rule.scope, sha256: rule.sha256 });
    }
    if (catalog) {
      for (const skill of context.skills) workspace.skills.set(skill.callName, skill);
    }
  }

  /** Read one catalogued skill or a contained resource; content never grants tool permissions. */
  async skill(id: string, selected: string, resource: string, signal?: AbortSignal): Promise<SkillRead> {
    checkAbort(signal);
    const workspace = this.get(id);
    const epoch = workspace.epoch;
    const skill = workspace.skills.get(selected);
    if (!skill) {
      const matches = [...workspace.skills.values()].filter((entry) => shortSkillName(entry) === selected);
      if (matches.length > 1) {
        const choices = matches.slice(0, 8).map((entry) => entry.callName).join(", ");
        throw new ToolError("SKILL_AMBIGUOUS", `Use a skill name from the catalog: ${choices}`);
      }
      throw new ToolError("SKILL_NOT_FOUND", "Reopen the project with ssh_workspace_open and use a skill name from its catalog");
    }
    const value = remoteSkillSchema.parse(await this.ssh.run(workspace.connectionId, "workspace_skill_read", {
      path: skill.path, resource,
    }, workspace.root, signal));
    checkAbort(signal);
    this.assertCurrent(workspace, epoch,
      "The workspace was reopened while this skill was being read. Its result was discarded; reopen the project with ssh_workspace_open and use its current catalog.");
    if (value.directory !== skill.directory || !within(skill.directory, value.path)) {
      throw new ToolError("SKILL_PATH_CHANGED", "The skill directory changed; reopen the project with ssh_workspace_open before reading it");
    }
    return { ...value, workspace_id: id, connection_id: workspace.connectionId, name: selected, execution: "remote" };
  }

  private validateScope(scope: WorkspaceScope): asserts scope is OperationScope {
    if ((scope.connection_id !== undefined) === (scope.workspace_id !== undefined)) {
      throw new ToolError("INVALID_SCOPE", "Provide exactly one of connection_id or workspace_id");
    }
  }

  /** Reopening retires in-flight context and skill reads, even when the handle is reused. */
  private assertCurrent(workspace: Workspace, epoch: number, message: string): void {
    this.assertReady(workspace.connectionId);
    if (workspace.epoch !== epoch) {
      throw new ToolError("WORKSPACE_REOPEN_REQUIRED", message);
    }
  }

  /** Discard contexts from a retired workspace generation or connection. */
  private currentDelivery(context: WorkspaceContext): PendingDelivery | undefined {
    const pending = this.pending.get(context);
    if (!pending) return;
    const { workspace, epoch } = pending;
    if (this.workspaces.get(workspace.id) !== workspace || workspace.epoch !== epoch) return;
    if (!this.ssh.sessions().sessions.some((connection) => connection.connection_id === workspace.connectionId)) return;
    return pending;
  }

  /** Bind the inspected rules to the workspace generation and the request's starting state. */
  private contextResult(workspace: Workspace, details: ContextDetails, catalog: boolean,
    inspection: RuleInspection = { knownAtStart: workspace.rules, inspectedWith: workspace.rules, rechecked: false }): WorkspaceContext {
    const context = { ...details, workspace_id: workspace.id, connection_id: workspace.connectionId };
    this.pending.set(context, { workspace, epoch: workspace.epoch, catalog, inspection });
    return context;
  }

  /** Detect a remote snapshot that disagrees with guidance delivered during this inspection. */
  private inspectionConflicts(inspection: RuleInspection, workspace: Workspace, context: ContextDetails): boolean {
    if (inspection.inspectedWith === workspace.rules) return false;
    for (const [path, rule] of ruleSnapshot(workspace.rules, context)) {
      const current = workspace.rules.get(path);
      if (rule !== current && current?.version !== inspection.inspectedWith.get(path)?.version) return true;
    }
    return false;
  }

  /** Return only rule changes that need presentation in the operation result. */
  private displayChanges(workspace: Workspace, context: ContextDetails): InstructionDelta {
    const current = new Set(context.instructions.map((rule) => rule.path));
    // A path through multiple directory links can inspect scopes outside both endpoint ancestry chains.
    const inspected = new Set(context.rule_scopes);
    const updated = context.instructions.filter((rule) => workspace.displayed.get(rule.path)?.sha256 !== rule.sha256);
    const removed = [...workspace.displayed].filter(([path, rule]) =>
      inspected.has(rule.scope) && !current.has(path))
      .map(([path, rule]) => ({ path, scope: rule.scope }));
    return { updated, removed };
  }
}

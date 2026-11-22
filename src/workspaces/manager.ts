/** Bind project context to explicit remote handles without changing the client's local workspace. */
import { posix } from "node:path";
import { z } from "zod";
import { cleanString } from "../config";
import { checkAbort, ToolError } from "../errors";
import { ShortIds } from "../ids";
import type { SshTransport } from "../ssh/transport";
import { type WaitBudget, WaitQueue } from "../ssh/wait-queue";
import { MAX_KNOWN_RULES, retryInspection, WorkspaceRules, type RuleSnapshot } from "./rules";
import type { InstructionNotice, InstructionReview, PreparedScope, RuleAcknowledgment, SkillRead, SkillSummary, WorkspaceContext, WorkspaceRead, WorkspaceScope } from "./types";

const MAX_WORKSPACES = 128;
const MAX_RULE_HINTS = 4;
// A hint costs a 64-character digest plus JSON overhead. Short rules travel inline.
const MIN_RULE_HINT_CHARS = 128;
const absolutePath = cleanString.max(4096).refine((value) => posix.isAbsolute(value), "Expected an absolute remote path");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const warnings = z.array(z.string().max(8192)).max(2048);
const remoteContextSchema = z.strictObject({
  root: absolutePath,
  read_condition: digest.optional(),
  paths: z.array(absolutePath).min(1).max(64),
  rule_scope_leaves: z.array(absolutePath).min(1).max(256),
  instructions: z.array(z.strictObject({ path: absolutePath, scope: absolutePath, sha256: digest, content: z.string().max(131072).optional() })).max(MAX_KNOWN_RULES),
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
type WorkspaceTransport = Pick<SshTransport, "run" | "cwd" | "isReady"> & {
  get(id: string): { waitBudget: WaitBudget };
};
type Workspace = {
  id: string; connectionId: string; root: string; skillDirectories: string[]; catalogOrder: number;
  rules: WorkspaceRules; skills: Map<string, SkillSummary>;
};
type PendingDelivery = {
  workspace: Workspace; snapshot: RuleSnapshot; confirmedBefore: number; catalogOrder?: number; readCondition?: string | undefined;
};
type ContextDetails = Omit<WorkspaceContext, "workspace_id" | "connection_id">;
type OperationScope = { connection_id: string; workspace_id?: undefined } | { connection_id?: undefined; workspace_id: string };

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
function contextDetails(remote: RemoteContext, root: string, catalog: boolean, known?: ReadonlyMap<string, string>): ContextDetails {
  if (remote.root !== root || [...remote.paths, ...remote.rule_scope_leaves].some((path) => !within(root, path))) {
    throw new ToolError("WORKSPACE_PATH_CHANGED", "Workspace paths changed; reopen the project with ssh_workspace_open before continuing");
  }
  const { skill_files, rule_scope_leaves, read_condition: _condition, instructions: received, ...details } = remote;
  const inspected = new Set<string>();
  for (const leaf of rule_scope_leaves) {
    for (let scope = leaf; !inspected.has(scope); scope = posix.dirname(scope)) {
      inspected.add(scope);
      if (scope === root) break;
    }
  }
  const instructions = received.map(({ scope, path, sha256, content }) => {
    if (!inspected.has(scope) || path !== posix.join(scope, "AGENTS.md")) {
      throw new ToolError("REMOTE_OPERATION_FAILED", "Workspace rule source does not match its inspected directory");
    }
    const body = content ?? known?.get(sha256);
    if (body === undefined) throw new ToolError("REMOTE_OPERATION_FAILED", "Workspace rule response omitted an unknown rule body");
    return { scope, path, sha256, content: body };
  });
  const skills = catalog ? skillCatalog(root, skill_files, details.warnings) : [];
  return { ...details, instructions, rule_scopes: [...inspected], skills };
}

/** Own bounded project state for one MCP process; reconnecting requires opening a new handle. */
export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly ids = new ShortIds();
  private readonly pending = new WeakMap<WorkspaceContext, PendingDelivery>();
  // Retain bodies from one inspection across the process, within its 128 KiB rule budget.
  private lastRules: { workspaceId: string; bodies: ReadonlyMap<string, string> } | undefined;
  private readonly inspections = new Map<string, { count: number; reading: boolean; waiters?: WaitQueue }>();
  private inspectionOrder = 0;

  constructor(private readonly ssh: WorkspaceTransport) {}

  /** Reject retired connections without assuming their transport records still exist. */
  private assertReady(connectionId: string): void {
    if (!this.ssh.isReady(connectionId)) {
      throw new ToolError("CONNECTION_LOST", "Reconnect and reopen the project with ssh_workspace_open");
    }
  }

  private get(id: string): Workspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new ToolError("WORKSPACE_NOT_FOUND", "Open the project with ssh_workspace_open");
    this.assertReady(workspace.connectionId);
    return workspace;
  }

  /** Refresh the catalog without forgetting rules. Recovery starts a fresh confirmation history. */
  async open(connectionId: string, path: string, skillDirectories: string[],
    { signal, rereadRules = false }: { signal?: AbortSignal; rereadRules?: boolean } = {}): Promise<WorkspaceContext> {
    checkAbort(signal);
    this.ssh.get(connectionId);
    const requestOrder = ++this.inspectionOrder;
    return this.inspect(connectionId, false, signal, () =>
      this.openWorkspace(connectionId, path, skillDirectories, rereadRules, requestOrder, signal));
  }

  private async openWorkspace(connectionId: string, path: string, skillDirectories: string[], rereadRules: boolean,
    requestOrder: number, signal?: AbortSignal): Promise<WorkspaceContext> {
    let order = requestOrder;
    for (;;) {
      const remote = remoteContextSchema.parse(await this.ssh.run(connectionId, "workspace_open", {
        path, skillDirectories,
      }, undefined, signal));
      checkAbort(signal);
      this.assertReady(connectionId);
      const details = contextDetails(remote, remote.root, true);
      let workspace: Workspace | undefined;
      for (const [id, candidate] of this.workspaces) {
        if (!this.ssh.isReady(candidate.connectionId)) this.workspaces.delete(id);
        else if (candidate.connectionId === connectionId && candidate.root === remote.root &&
          candidate.skillDirectories.length === skillDirectories.length &&
          candidate.skillDirectories.every((directory, index) => directory === skillDirectories[index])) workspace = candidate;
      }
      if (!workspace) {
        if (this.workspaces.size >= MAX_WORKSPACES) throw new ToolError("WORKSPACE_LIMIT", "Close an unused connection before opening more workspaces");
        workspace = { id: `ws_${this.ids.next()}`, connectionId, root: remote.root, skillDirectories: [...skillDirectories],
          catalogOrder: 0, rules: new WorkspaceRules(), skills: new Map() };
      }
      if (workspace.catalogOrder > requestOrder) throw retryInspection();
      const snapshot = workspace.rules.observe(details, order, rereadRules ? "reread" : "refresh");
      if (!snapshot) {
        if (order !== requestOrder) throw retryInspection();
        order = ++this.inspectionOrder;
        continue;
      }
      workspace.rules = snapshot.history;
      workspace.catalogOrder = requestOrder;
      this.workspaces.set(workspace.id, workspace);
      return this.contextResult(details, { workspace, snapshot, confirmedBefore: snapshot.history.confirmedThrough, catalogOrder: requestOrder });
    }
  }

  /** Resolve a file or Bash cwd against the same rule history. Retry one superseded remote inspection. */
  async prepare(scope: WorkspaceScope, path: string, signal?: AbortSignal, read?: WorkspaceRead): Promise<PreparedScope> {
    this.validateScope(scope);
    checkAbort(signal);
    if (scope.connection_id !== undefined) {
      this.ssh.get(scope.connection_id);
      return { connectionId: scope.connection_id, path };
    }
    const workspace = this.get(scope.workspace_id);
    const rules = workspace.rules;
    const confirmedBefore = rules.confirmedThrough;
    const condition = read && rules.readCondition;
    return this.inspect(workspace.connectionId, condition !== undefined, signal, exclusive =>
      this.inspectPath(workspace, path, rules, confirmedBefore, read, exclusive ? condition : undefined, signal));
  }

  private async inspectPath(workspace: Workspace, path: string, rules: WorkspaceRules, confirmedBefore: number,
    read: WorkspaceRead | undefined, condition: string | undefined, signal?: AbortSignal): Promise<PreparedScope> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const order = ++this.inspectionOrder;
      const known = this.lastRules?.workspaceId === workspace.id ? this.lastRules.bodies : undefined;
      const observation = condition ? read?.observe() : undefined;
      const response = await this.ssh.run(workspace.connectionId, read ? "workspace_read" : "workspace_context", {
        root: workspace.root, paths: [path], ...(known && { knownRules: [...known.keys()] }),
        ...(condition && { condition, read: read!.args }),
      }, workspace.root, signal);
      checkAbort(signal);
      this.assertReady(workspace.connectionId);
      if (rules !== workspace.rules) throw retryInspection();
      if (observation !== undefined && "path" in response) {
        const target = absolutePath.parse(response.path);
        if (!within(workspace.root, target)) throw new ToolError("WORKSPACE_PATH_CHANGED", "Read target left the workspace");
        return { connectionId: workspace.connectionId, path: target, file: { value: response, observation } };
      }
      const remote = remoteContextSchema.parse(response);
      const details = contextDetails(remote, workspace.root, false, known);
      const snapshot = rules.observe(details, order);
      if (snapshot) {
        const context = this.contextResult(details, { workspace, snapshot, confirmedBefore, readCondition: remote.read_condition });
        // The worker returns the lexical path followed by its checked canonical target, if different.
        return { connectionId: workspace.connectionId, path: context.paths.at(-1)!, context };
      }
      condition = undefined;
    }
    throw retryInspection();
  }

  /** Check the exact current rule versions again immediately before file access. */
  reviewGuidance(prepared: PreparedScope, ack?: RuleAcknowledgment): InstructionReview | undefined {
    if (!prepared.context) return;
    const pending = this.currentDelivery(prepared.context);
    if (!pending) {
      this.assertReady(prepared.connectionId);
      throw retryInspection();
    }
    return pending.workspace.rules.review(pending.snapshot, pending.confirmedBefore, ack, pending.readCondition);
  }

  /** Ordinary inspections overlap. A conditional read dispatches only between inspections,
   * so observing a change or resetting receipts cannot overtake its authorization. */
  private async inspect<T>(connectionId: string, conditional: boolean, signal: AbortSignal | undefined,
    run: (exclusive: boolean) => Promise<T>): Promise<T> {
    const state = this.inspections.get(connectionId) ?? { count: 0, reading: false };
    this.inspections.set(connectionId, state);
    const exclusive = conditional && state.count === 0;
    state.count++;
    try {
      if (state.reading) await (state.waiters ??= new WaitQueue(this.ssh.get(connectionId).waitBudget)).wait(signal);
      checkAbort(signal);
      if (exclusive) state.reading = true;
      return await run(exclusive);
    } finally {
      if (exclusive) {
        state.reading = false;
        state.waiters?.wakeAll();
        delete state.waiters;
      }
      if (--state.count === 0) this.inspections.delete(connectionId);
    }
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

  /** Preserve command results while suppressing obsolete guidance. Catalog responses must be current. */
  guidance(context: WorkspaceContext): InstructionNotice {
    const pending = this.currentDelivery(context);
    const opening = this.pending.get(context)?.catalogOrder !== undefined;
    if (opening && (!pending || !pending.workspace.rules.isCurrent(pending.snapshot))) throw retryInspection();
    return pending?.workspace.rules.presentation(pending.snapshot, opening) ?? { updated: [], removed: [] };
  }

  /** Formatting commits presentation only. File confirmation requires a returned receipt. */
  delivered(context: WorkspaceContext): void {
    const pending = this.currentDelivery(context);
    this.pending.delete(context);
    if (!pending) return;
    pending.workspace.rules.displayed(pending.snapshot);
    if (pending.catalogOrder !== undefined) {
      pending.workspace.skills = new Map(context.skills.map(skill => [skill.callName, skill]));
    }
  }

  /** Read one catalogued skill or a contained resource; content never grants tool permissions. */
  async skill(id: string, selected: string, resource: string, signal?: AbortSignal): Promise<SkillRead> {
    checkAbort(signal);
    const workspace = this.get(id);
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
    this.assertReady(workspace.connectionId);
    if (workspace.skills.get(selected)?.path !== skill.path) {
      throw new ToolError("SKILL_CATALOG_CHANGED", "The skill catalog was refreshed during this read. Retry with the skill name from the current catalog.");
    }
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

  private currentDelivery(context: WorkspaceContext): PendingDelivery | undefined {
    const pending = this.pending.get(context);
    if (!pending) return;
    const { workspace, snapshot, catalogOrder } = pending;
    if (workspace.rules !== snapshot.history || (catalogOrder !== undefined && workspace.catalogOrder !== catalogOrder)) return;
    if (!this.ssh.isReady(workspace.connectionId)) return;
    return pending;
  }

  private contextResult(details: ContextDetails, pending: PendingDelivery): WorkspaceContext {
    const { workspace } = pending;
    let bodies: Map<string, string> | undefined;
    for (const { sha256, content } of details.instructions) {
      if (content.length < MIN_RULE_HINT_CHARS) continue;
      bodies ??= new Map();
      bodies.set(sha256, content);
      if (bodies.size === MAX_RULE_HINTS) break;
    }
    this.lastRules = bodies && { workspaceId: workspace.id, bodies };
    const context = { ...details, workspace_id: workspace.id, connection_id: workspace.connectionId };
    this.pending.set(context, pending);
    return context;
  }
}

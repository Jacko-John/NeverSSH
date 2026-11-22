/** Domain results for remote project guidance and explicitly selected skill resources. */
import type { RemoteResult } from "../ssh/request-channel";
export type WorkspaceScope = {
  connection_id?: string | undefined;
  workspace_id?: string | undefined;
};

export type Instruction = { path: string; scope: string; sha256: string; content: string };
export type SkillSummary = {
  name: string; callName: string; description: string; path: string; directory: string; scope: string;
};
export type GitSummary = { root: string | null; branch: string | null; status: string; omitted: number };
export type WorkspaceContext = {
  workspace_id: string;
  connection_id: string;
  root: string;
  paths: string[];
  rule_scopes: string[];
  instructions: Instruction[];
  skills: SkillSummary[];
  project_files: string[];
  git: GitSummary | null;
  warnings: string[];
};
export type InstructionDelta = {
  updated: Instruction[];
  removed: Pick<Instruction, "path" | "scope">[];
};
export type RuleAcknowledgment = string | readonly string[];
export type InstructionNotice = InstructionDelta & { token?: RuleAcknowledgment };
export type InstructionReview = InstructionDelta & { token: RuleAcknowledgment; changed: boolean; legacyRetryCode?: string };
export type WorkspaceRead = {
  args: { requestedPath: string; startLine?: number | undefined; lineCount?: number | undefined };
  observe: () => number;
};
export type PreparedScope = {
  connectionId: string; path: string; context?: WorkspaceContext; file?: { value: RemoteResult; observation: number };
};
export type SkillRead = {
  workspace_id: string; connection_id: string; name: string;
  path: string; directory: string; execution: "remote"; content: string; sha256: string;
  resources: string[]; warnings: string[];
};

/** Domain results for remote project guidance and explicitly selected skill resources. */
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
export type InstructionReview = InstructionDelta & { token: string };
export type PreparedScope = { connectionId: string; path: string; context?: WorkspaceContext };
export type SkillRead = {
  workspace_id: string; connection_id: string; name: string;
  path: string; directory: string; execution: "remote"; content: string; sha256: string;
  resources: string[]; warnings: string[];
};

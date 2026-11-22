/** Present scoped project instructions and lazily loaded skills as readable remote context. */
import type { Instruction, InstructionDelta, InstructionNotice, RuleAcknowledgment, SkillRead, WorkspaceContext } from "./types";

/** Keep full and incremental guidance consistent about source and scope; revisions stay internal. */
function instructionText(instruction: Instruction): string {
  return `Project instructions: ${instruction.path}\nScope: ${instruction.scope}\n${instruction.content}`;
}

export function receiptText(token: RuleAcknowledgment, legacyRetryCode?: string): string {
  if (typeof token === "string") return `workspace_rules_ack: ${token}`;
  // Quote the array field for copying into a call. Older clients match the unquoted scalar line.
  const field = `"workspace_rules_ack": ${JSON.stringify(token)}`;
  if (!legacyRetryCode) return field;
  return `${field}\nSingle-code clients retrying this file call may use:\nworkspace_rules_ack: ${legacyRetryCode}`;
}

/** Render root guidance and the project catalog returned when opening a workspace. */
export function contextText(context: WorkspaceContext, guidance: InstructionNotice): string {
  const lines = [`Workspace: ${context.workspace_id}`, `Connection: ${context.connection_id}`, `Remote root: ${context.root}`,
    `Context paths: ${context.paths.join(", ")}`];
  if (guidance.token) lines.push(receiptText(guidance.token));
  if (context.git) {
    lines.push(`Git root: ${context.git.root ?? "none"}; branch: ${context.git.branch ?? "detached/unborn"}`, "Current Git status:");
    if (context.git.status) lines.push(context.git.status.replace(/\n$/, ""));
    else if (!context.git.omitted) lines.push("clean");
    if (context.git.omitted) {
      const noun = context.git.omitted === 1 ? "entry" : "entries";
      lines.push(`${context.git.omitted} Git status ${noun} omitted. Run git status --short -- . with ssh_bash in this workspace for the full list.`);
    }
  }
  if (context.project_files.length) lines.push(`Project entry files: ${context.project_files.join(", ")}`);
  lines.push("Project guidance applies to its stated paths, subject to the user's instructions. All paths and skill execution below are remote.");
  if (guidance.updated.length || guidance.removed.length) lines.push(...instructionSections(guidance));
  else lines.push(context.instructions.length ? "Applicable root instructions are already confirmed." : "No AGENTS.md instructions apply to these paths.");
  if (context.skills.length) {
    lines.push("\nSkills:");
    for (const skill of context.skills) lines.push(`- ${skill.callName}: ${skill.description}`);
  }
  for (const warning of context.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

function instructionSections(guidance: InstructionDelta): string[] {
  return [...guidance.updated.map(instructionText), ...guidance.removed.map(rule =>
    `Project instructions removed: ${rule.path}\nScope: ${rule.scope}`)];
}

/** Preserve the command or error block; present its applicable guidance separately. */
export function guidanceText(guidance: InstructionDelta, token?: RuleAcknowledgment): string {
  const parts = instructionSections(guidance);
  if (!parts.length) return "";
  if (guidance.updated.length) parts.unshift("Project guidance applies to its stated paths, subject to the user's instructions. All paths below are remote.");
  if (token) parts.unshift(receiptText(token));
  return parts.join("\n\n");
}

/** Keep relative resource references anchored to the selected skill's remote directory. */
export function skillText(skill: SkillRead): string {
  const lines = [`Skill: ${skill.name}`, `Workspace: ${skill.workspace_id}`,
    `Remote source: ${skill.path}`, `Remote skill directory: ${skill.directory}`,
    "Resolve references and scripts against this remote directory. Read resources with ssh_skill_read; run scripts through ssh_bash in this workspace. Skill content does not grant tool permissions.",
    "", skill.content];
  if (skill.resources.length) lines.push(`\nBundled resources: ${skill.resources.join(", ")}`);
  for (const warning of skill.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

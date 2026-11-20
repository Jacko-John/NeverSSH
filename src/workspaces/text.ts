/** Present scoped project instructions and lazily loaded skills as readable remote context. */
import type { Instruction, InstructionDelta, SkillRead, WorkspaceContext } from "./types";

/** Keep full and incremental guidance consistent about source and scope; revisions stay internal. */
function instructionText(instruction: Instruction): string {
  return `Project instructions: ${instruction.path}\nScope: ${instruction.scope}\n${instruction.content}`;
}

/** Render root guidance and the project catalog returned when opening a workspace. */
export function contextText(context: WorkspaceContext): string {
  const lines = [`Workspace: ${context.workspace_id}`, `Connection: ${context.connection_id}`, `Remote root: ${context.root}`,
    `Context paths: ${context.paths.join(", ")}`];
  if (context.git) {
    lines.push(`Git root: ${context.git.root ?? "none"}; branch: ${context.git.branch ?? "detached/unborn"}`,
      `Current Git status${context.git.truncated ? " (truncated)" : ""}:\n${context.git.status || "clean"}`);
  }
  if (context.project_files.length) lines.push(`Project entry files: ${context.project_files.join(", ")}`);
  lines.push("Project guidance applies to its stated paths, subject to the user's instructions. All paths and skill execution below are remote.");
  if (!context.instructions.length) lines.push("No AGENTS.md instructions apply to these paths.");
  for (const instruction of context.instructions) {
    lines.push(`\n${instructionText(instruction)}`);
  }
  if (context.skills.length) {
    lines.push("\nSkills:");
    for (const skill of context.skills) lines.push(`- ${skill.callName}: ${skill.description}`);
  }
  for (const warning of context.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

/** Present only rule changes alongside ordinary workspace operation results. */
export function guidanceText(guidance: InstructionDelta): string {
  const lines: string[] = [];
  if (guidance.updated.length) {
    lines.push("Project guidance applies to its stated paths, subject to the user's instructions. All paths below are remote.");
    for (const instruction of guidance.updated) lines.push(`\n${instructionText(instruction)}`);
  }
  for (const instruction of guidance.removed) {
    if (lines.length) lines.push("");
    lines.push(`Project instructions removed: ${instruction.path}\nScope: ${instruction.scope}`);
  }
  return lines.join("\n");
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

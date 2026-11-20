/** Public input schemas shared by MCP registration, documentation, and tests. */
import { z } from "zod";
import { cleanString, connectSchema } from "../config";

const shortId = z.string().refine((value) => /^[a-f0-9]{8}$/.test(value), "Use the short ID returned by ssh_connect");
export const connectionId = shortId.describe("Short connection_id returned by ssh_connect in this MCP instance.");
const taskId = z.string().refine((value) => /^task_[a-f0-9]{8}$/.test(value), "Use the task_id returned by ssh_bash")
  .describe("Prefixed task_id returned by ssh_bash; unique within this MCP instance.");
const taskScope = { task_id: taskId };
const waitSeconds = z.number().min(0).max(300);
const workspaceId = z.string().refine((value) => /^ws_[a-f0-9]{8}$/.test(value), "Use the workspace_id returned by ssh_workspace_open")
  .describe("Workspace handle returned by ssh_workspace_open in this MCP instance.");
const operationScope = { connection_id: connectionId.optional(), workspace_id: workspaceId.optional() };
const scopeMessage = "Provide exactly one connection_id or workspace_id";

/** Keep a portable object schema; enforce scope exclusivity when validating the request. */
function validOperationScope(value: { connection_id?: string | undefined; workspace_id?: string | undefined }): boolean {
  return (value.connection_id !== undefined) !== (value.workspace_id !== undefined);
}

export const connectionContracts = {
  ssh_discover: {
    input: z.strictObject({}),
  },
  ssh_connect: {
    input: connectSchema,
  },
  ssh_sessions: {
    input: z.strictObject({}),
  },
  ssh_close: {
    input: z.strictObject({ connection_id: connectionId }),
  },
};

/** Text results deliberately have no structured output schema. */
export const commandContracts = {
  ssh_bash: {
    input: z.strictObject({
      ...operationScope,
      command: cleanString.max(131072),
      cwd: cleanString.max(4096).optional().describe("Remote working directory, relative to the workspace root or remote HOME; defaults to that root."),
      run_in_background: z.boolean().default(false),
      wait_seconds: waitSeconds.default(120),
    }).refine(validOperationScope, scopeMessage),
  },
  ssh_task_output: {
    input: z.strictObject({ ...taskScope, wait_seconds: waitSeconds.default(30) }),
  },
  ssh_task_stop: {
    input: z.strictObject(taskScope),
  },
  ssh_task_list: {
    input: z.strictObject({ connection_id: connectionId.optional() }),
  },
};

export const workspaceContracts = {
  ssh_workspace_open: {
    input: z.strictObject({
      connection_id: connectionId,
      path: cleanString.max(4096).describe("Remote project directory; canonicalized when opened. Relative paths resolve against remote HOME."),
      skill_directories: z.array(cleanString.max(4096)).max(16).default([".agents/skills", ".claude/skills"])
        .describe("Remote skill directories, resolved once from the workspace root. Defaults are .agents/skills and .claude/skills; nested directory discovery is unsupported. Absolute and ~/ paths may select shared remote skills. Use [] to disable discovery."),
    }),
  },
  ssh_skill_read: {
    input: z.strictObject({
      workspace_id: workspaceId,
      skill_name: cleanString.max(65536)
        .describe("Skill name from the workspace catalog, such as testing or shared@testing. Copy the listed name to select its source."),
      resource: cleanString.max(4096).default("SKILL.md")
        .describe("Text resource relative to the discovered remote skill directory; defaults to its SKILL.md. Does not execute scripts."),
    }),
  },
};

const remotePath = cleanString.max(4096).describe("Remote path: absolute, ~/..., or relative to cwd.");
const localPath = cleanString.max(4096).describe("Absolute file path on the NeverSSH client host; restricted to localTransferRoots only when that list is nonempty.");
const filePath = cleanString.max(4096).describe("Remote file path; relative to the workspace root or, with connection_id, remote HOME.");
const transferScope = {
  ...operationScope,
  cwd: remotePath.optional().describe("Remote working directory; defaults to the workspace root or remote HOME. localPath always stays local."),
};
const hash = z.string().refine((value) => /^[a-f0-9]{64}$/.test(value), "Use a lowercase hex SHA-256").optional();

/** Define every tool input once, using the configured file limit for text mutations. */
export function createToolContracts(maxFileBytes: number) {
  return {
    ...connectionContracts,
    ...commandContracts,
    ...workspaceContracts,
    ssh_read_file: {
      input: z.strictObject({
        ...operationScope,
        file_path: filePath.describe("Remote text or image file path; relative to the workspace root or, with connection_id, remote HOME."),
        offset: z.number().int().min(1).default(1).describe("Starting text line, counted from 1; ignored for images."),
        limit: z.number().int().min(1).default(2000).describe("Maximum text lines to return; images are always returned whole."),
      }).refine(validOperationScope, scopeMessage),
    },
    ssh_write_file: {
      input: z.strictObject({
        ...operationScope, file_path: filePath,
        content: z.string().max(maxFileBytes),
      }).refine(validOperationScope, scopeMessage),
    },
    ssh_edit_file: {
      input: z.strictObject({
        ...operationScope, file_path: filePath,
        old_string: cleanString.max(maxFileBytes),
        new_string: z.string().max(maxFileBytes),
        replace_all: z.boolean().default(false),
      }).refine(validOperationScope, scopeMessage),
    },
    ssh_upload: {
      input: z.strictObject({
        ...transferScope, localPath, remotePath,
        overwrite: z.boolean().default(false), expectedSha256: hash,
      }).refine(validOperationScope, scopeMessage),
    },
    ssh_download: {
      input: z.strictObject({
        ...transferScope, remotePath, localPath, overwrite: z.boolean().default(false),
      }).refine(validOperationScope, scopeMessage),
    },
  };
}

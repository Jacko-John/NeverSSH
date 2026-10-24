/** Public input schemas shared by MCP registration, documentation, and tests; results are text-only. */
import { z } from "zod";
import { cleanString, connectSchema } from "../config";

const shortId = z.string().refine((value) => /^[a-f0-9]{8}$/.test(value), "Use the short ID returned by ssh_connect");
export const connectionId = shortId.describe("Short connection_id returned by ssh_connect in this MCP instance.");
const taskId = z.string().refine((value) => /^task_[a-f0-9]{8}$/.test(value), "Use the task_id returned by ssh_bash")
  .describe("Prefixed task_id returned by ssh_bash; unique within this MCP instance.");
const taskScope = { task_id: taskId };
const waitSeconds = z.number().min(0).max(300);

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
      connection_id: connectionId,
      command: cleanString.max(131072),
      cwd: cleanString.max(4096).optional(),
      run_in_background: z.boolean().default(false),
      wait_seconds: waitSeconds.default(120),
    }),
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

const remotePath = cleanString.max(4096).describe("Remote path: absolute, ~/..., or relative to cwd.");
const filePath = cleanString.max(4096).describe("Remote file path; absolute paths are recommended, relative paths resolve against the remote home directory.");
const transferScope = {
  connection_id: connectionId,
  cwd: remotePath.optional().describe("Remote working directory; defaults to this connection's remote home directory."),
};
const hash = z.string().refine((value) => /^[a-f0-9]{64}$/.test(value), "Use a lowercase hex SHA-256").optional();

/** Define every tool input once, using the configured file limit for text mutations. */
export function createToolContracts(maxFileBytes: number) {
  return {
    ...connectionContracts,
    ...commandContracts,
    ssh_read_file: {
      input: z.strictObject({
        connection_id: connectionId, file_path: filePath,
        offset: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).default(2000),
      }),
    },
    ssh_write_file: {
      input: z.strictObject({
        connection_id: connectionId, file_path: filePath,
        content: z.string().max(maxFileBytes),
      }),
    },
    ssh_edit_file: {
      input: z.strictObject({
        connection_id: connectionId, file_path: filePath,
        old_string: cleanString.max(maxFileBytes),
        new_string: z.string().max(maxFileBytes),
        replace_all: z.boolean().default(false),
      }),
    },
    ssh_upload: {
      input: z.strictObject({
        ...transferScope, localPath: cleanString.max(4096), remotePath,
        overwrite: z.boolean().default(false), expectedSha256: hash,
      }),
    },
    ssh_download: {
      input: z.strictObject({
        ...transferScope, remotePath, localPath: cleanString.max(4096), overwrite: z.boolean().default(false),
      }),
    },
  };
}

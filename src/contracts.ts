/** Public input schemas shared by MCP registration, documentation, and tests; results are text-only. */
import { z } from "zod";
import { cleanString, hostField, portField, userField } from "./config";

const shortId = z.string().refine((value) => /^[a-f0-9]{8}$/.test(value), "Use the short ID returned by ssh_connect");
export const connectionId = shortId.describe("Short connection_id returned by ssh_connect in this MCP instance.");
const target = { host: hostField, user: userField.optional(), port: portField.optional() };
const taskId = z.string().refine((value) => /^task_[a-f0-9]{8}$/.test(value), "Use the task_id returned by ssh_bash")
  .describe("Prefixed task_id returned by ssh_bash; unique within this MCP instance.");
const taskScope = { task_id: taskId };
const waitSeconds = z.number().min(0).max(300);

export const connectionContracts = {
  ssh_discover: {
    input: z.strictObject({}),
  },
  ssh_connect: {
    input: z.strictObject({ ...target, timeout_seconds: z.number().min(1).max(180).default(60) }),
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

export const toolContracts = { ...connectionContracts, ...commandContracts };

/** Internal connection metadata for lifecycle management and the session-list formatter. */
export type ConnectionSummary = { connection_id: string; host: string; user: string; port: number };

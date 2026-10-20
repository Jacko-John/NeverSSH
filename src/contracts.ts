/** Public connection and command schemas shared by MCP registration, documentation, and tests. */
import { z } from "zod";
import { cleanString, hostField, portField, userField } from "./config";

const shortId = z.string().regex(/^[a-f0-9]{8}$/);
export const connectionId = shortId.describe("Short connection_id returned by ssh_connect in this MCP instance.");
const target = { host: hostField, user: userField.optional(), port: portField.optional() };
const taskId = z.string().regex(/^task_[a-f0-9]{8}$/).describe("Prefixed task_id returned by ssh_bash; unique within this MCP instance.");
const taskScope = { task_id: taskId };
const waitSeconds = z.number().min(0).max(300);

export const connectionSummary = z.strictObject({
  connection_id: connectionId,
  host: z.string(),
  user: z.string(),
  port: portField,
});

const error = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
});

/** Include failures in the output contract as well as MCP's isError flag. */
function output<T extends z.ZodType>(success: T) {
  return z.union([success, error]);
}

export const connectionContracts = {
  ssh_discover: {
    input: z.strictObject({}),
    output: output(z.strictObject({ servers: z.array(z.strictObject({ host: hostField })) })),
  },
  ssh_connect: {
    input: z.strictObject({ ...target, timeout_seconds: z.number().min(1).max(180).default(60) }),
    output: output(z.strictObject({ connection_id: connectionId })),
  },
  ssh_sessions: {
    input: z.strictObject({}),
    output: output(z.strictObject({ sessions: z.array(connectionSummary) })),
  },
  ssh_close: {
    input: z.strictObject({ connection_id: connectionId }),
    output: output(z.strictObject({
      connection_id: connectionId,
      closed: z.literal(true),
      remote_cleanup: z.enum(["confirmed", "unconfirmed"]),
    })),
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
export type ConnectionSummary = z.infer<typeof connectionSummary>;

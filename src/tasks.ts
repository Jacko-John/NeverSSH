/** Own remote Bash lifetimes and a bounded tail preview; full output lives in remote archives. */
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { RemoteChannel } from "./channel";
import { checkAbort, ToolError } from "./errors";
import { ShortIds } from "./ids";
import { JsonLines } from "./json-lines";
import type { SshTransport } from "./ssh";

const PREVIEW_BYTES = 65536;
const PREVIEW_CHUNKS = 4096;
const MAX_ACTIVE_TASKS = 4;
const MAX_RETAINED_TASKS = 256;
const RETENTION_MS = 14 * 24 * 60 * 60_000;

type Stream = "stdout" | "stderr";
type Preview = { stream: Stream; text: string };
type Reason = "cancelled" | "connection_closed" | "connection_lost" | "failed" | "output_limit" | "output_error";

/** Validate private helper records before they change local task state. */
const helperEvent = z.union([
  z.object({ event: z.literal("started"), pid: z.number().int().positive(), cwd: z.string(),
    outputFile: z.string().startsWith("/"), outputBytes: z.number().int().positive() }),
  z.object({ event: z.literal("output"), stream: z.enum(["stdout", "stderr"]),
    base64: z.string().max(21848).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    outputBytes: z.number().int().nonnegative() }),
  z.object({ event: z.literal("exit"), exitCode: z.number().int(), outputBytes: z.number().int().nonnegative(),
    outputComplete: z.boolean(), message: z.string().nullish(),
    reason: z.enum(["cancelled", "disconnected", "failed", "output_limit", "output_error"]).nullish() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

export type TaskSummary = {
  connection_id: string;
  task_id: string;
  finished: boolean;
  exit_code: number | null;
  reason?: TaskResult["reason"];
  stop_requested: boolean;
  output_file: string;
  output_bytes: number;
};

export type TaskResult = {
  connection_id: string;
  task_id: string;
  finished: boolean;
  exit_code: number | null;
  reason?: Reason;
  message?: string | undefined;
  stop_requested: boolean;
  output_file: string;
  output_bytes: number;
  size_known: boolean;
  output_complete: boolean;
  preview_complete: boolean;
  preview: Preview[];
};

type Task = {
  id: string;
  connectionId: string;
  channel?: RemoteChannel;
  outputFile: string;
  outputBytes: number;
  outputComplete: boolean;
  preview: Preview[];
  previewBytes: number;
  previewComplete: boolean;
  readBytes: number;
  started: boolean;
  finishedAt?: number;
  exitCode: number | null;
  reason?: Reason | undefined;
  message?: string | undefined;
  stopRequested: boolean;
  changed: EventEmitter;
};

/** Task handles belong to one MCP process, including retained status after connection closure. */
export class TaskManager {
  private readonly tasks = new Map<string, Task>();
  private readonly ids = new ShortIds();
  private closed = false;

  constructor(private readonly ssh: Pick<SshTransport, "open">) {}

  /** Task IDs are unique in this MCP instance; connection ownership stays internal. */
  private get(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new ToolError("TASK_NOT_FOUND", "Task does not exist in this MCP instance");
    return task;
  }

  /** Preserve all active tasks; evict completed local previews without touching remote logs. */
  private prune(): void {
    for (const task of this.tasks.values()) {
      if (task.finishedAt !== undefined &&
          (Date.now() - task.finishedAt >= RETENTION_MS || this.tasks.size >= MAX_RETAINED_TASKS)) {
        this.tasks.delete(task.id);
      }
    }
  }

  /** Bound both preview bytes and allocation count, retaining the newest complete chunks. */
  private append(task: Task, stream: Stream, text: string): void {
    if (!text) return;
    task.preview.push({ stream, text });
    task.previewBytes += Buffer.byteLength(text);
    while (task.preview.length && (task.previewBytes > PREVIEW_BYTES || task.preview.length > PREVIEW_CHUNKS)) {
      task.previewBytes -= Buffer.byteLength(task.preview.shift()!.text);
      task.previewComplete = false;
    }
  }

  /** Admit a command only after reserving local capacity, then confirm the remote child exists. */
  async start(connectionId: string, command: string, cwd?: string, signal?: AbortSignal, attempt = 0): Promise<string> {
    checkAbort(signal);
    if (this.closed) throw new ToolError("CONNECTION_LOST", "Task manager is closed");
    const active = [...this.tasks.values()].filter((task) => task.connectionId === connectionId && task.finishedAt === undefined);
    if (active.length >= MAX_ACTIVE_TASKS) {
      throw new ToolError("TASK_LIMIT_REACHED", "Four commands are already active on this connection; wait for or stop one first");
    }
    this.prune();
    if (this.tasks.size >= MAX_RETAINED_TASKS) throw new ToolError("TASK_LIMIT_REACHED", "Task registry is full");
    const task: Task = {
      id: `task_${this.ids.next()}`, connectionId, outputFile: "", outputBytes: 0, outputComplete: true,
      preview: [], previewBytes: 0, previewComplete: true, readBytes: 0, started: false, exitCode: null,
      stopRequested: false, changed: new EventEmitter(),
    };
    this.tasks.set(task.id, task);
    try {
      const channel = await this.ssh.open(connectionId, "bash", { command, taskId: task.id }, cwd, signal);
      task.channel = channel;
      await this.attach(task, channel, signal);
      return task.id;
    } catch (error) {
      task.channel?.cancel();
      this.tasks.delete(task.id);
      // Archive collisions are reported before Bash starts, so only this case permits an automatic retry.
      if (error instanceof ToolError && error.code === "TASK_ID_EXISTS" && attempt < 8) {
        return this.start(connectionId, command, cwd, signal, attempt + 1);
      }
      throw error;
    }
  }

  /** Decode the private protocol; program stdout never supplies task metadata. */
  private attach(task: Task, channel: RemoteChannel, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const records = new JsonLines(131072);
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      let terminal = false;
      let broken = false;
      let diagnostics = "";
      const cleanupStart = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (message: string, reason: Reason = "failed", code = "COMMAND_START_FAILED") => {
        if (broken) return;
        broken = true;
        task.reason = reason;
        task.message = message;
        task.outputComplete = false;
        cleanupStart();
        if (!task.started) reject(new ToolError(code, message));
        task.changed.emit("change");
      };
      const abort = () => {
        channel.cancel();
        fail("Command start cancelled; inspect remote state before retrying", "failed", "OPERATION_CANCELLED");
      };
      const timer = setTimeout(() => {
        channel.cancel();
        fail("Remote command did not confirm startup within 15 seconds; inspect remote state before retrying");
      }, 15000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      channel.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
      channel.stdout.setEncoding("utf8");
      channel.stdout.on("data", (chunk: string) => {
        try {
          records.push(chunk, (record) => {
            if (broken) return;
            const event = helperEvent.parse(record);
            if ("ok" in event) {
              fail(event.error.message, "failed", event.error.code);
              channel.cancel();
              return;
            }
            if (event.event === "started" && !task.started && !terminal) {
              task.started = true;
              task.outputFile = event.outputFile;
              task.outputBytes = event.outputBytes;
              cleanupStart();
              resolve();
            } else if (event.event === "output" && task.started && !terminal) {
              const bytes = Buffer.from(event.base64, "base64");
              if (bytes.length > 16384 || event.outputBytes !== task.outputBytes + bytes.length) {
                throw new Error("Malformed output byte count");
              }
              const stream: Stream = event.stream;
              task.outputBytes = event.outputBytes;
              this.append(task, stream, decoders[stream].write(bytes));
            } else if (event.event === "exit" && task.started && !terminal) {
              if (event.outputBytes < task.outputBytes) {
                throw new Error("Malformed task exit event");
              }
              terminal = true;
              task.exitCode = event.exitCode;
              task.reason = event.reason === "disconnected" ? "connection_closed" : event.reason ?? undefined;
              task.message = typeof event.message === "string" ? event.message : undefined;
              if (event.outputBytes > task.outputBytes) task.previewComplete = false;
              task.outputBytes = event.outputBytes;
              task.outputComplete = event.outputComplete;
              channel.stdin.end();
            } else {
              throw new Error("Unexpected helper event");
            }
          });
        } catch (error) {
          fail(`Invalid remote helper response: ${error instanceof Error ? error.message : String(error)}`);
          channel.cancel();
        }
      });
      channel.once("error", (error) => { fail(error.message); channel.cancel(); });
      channel.once("close", (code: number) => {
        cleanupStart();
        for (const stream of ["stdout", "stderr"] as const) this.append(task, stream, decoders[stream].end());
        if (!terminal && !broken) {
          fail(`SSH channel closed without a command result: ${diagnostics.trim() || `exit ${code}`}. Inspect remote state before retrying.`,
            code === 255 ? "connection_lost" : "failed");
        }
        if (!terminal) task.exitCode = null;
        task.finishedAt = Date.now();
        task.changed.emit("change");
      });
    });
  }

  /** List tasks with output not yet consumed by ssh_task_output, active first. */
  list(connectionId?: string): TaskSummary[] {
    this.prune();
    const tasks = [...this.tasks.values()]
      .filter((task) => connectionId === undefined || task.connectionId === connectionId)
      .filter((task) => task.outputBytes > task.readBytes);
    tasks.sort((left, right) => {
      const leftFinished = left.finishedAt === undefined ? 0 : 1;
      const rightFinished = right.finishedAt === undefined ? 0 : 1;
      if (leftFinished !== rightFinished) return leftFinished - rightFinished;
      return (right.finishedAt ?? 0) - (left.finishedAt ?? 0);
    });
    return tasks.map((task) => ({
      connection_id: task.connectionId, task_id: task.id,
      finished: task.finishedAt !== undefined,
      exit_code: task.finishedAt !== undefined ? task.exitCode : null,
      ...(task.reason ? { reason: task.reason } : {}),
      stop_requested: task.stopRequested,
      output_file: task.outputFile, output_bytes: task.outputBytes,
    }));
  }

  /** Return a repeatable preview without requiring a client output cursor. */
  snapshot(taskId: string): TaskResult {
    const task = this.get(taskId);
    const sizeKnown = task.reason !== "connection_lost" && task.reason !== "failed";
    return {
      connection_id: task.connectionId, task_id: task.id, finished: task.finishedAt !== undefined,
      exit_code: task.finishedAt !== undefined ? task.exitCode : null,
      ...(task.reason ? { reason: task.reason } : {}), ...(task.message ? { message: task.message } : {}),
      stop_requested: task.stopRequested, output_file: task.outputFile, output_bytes: task.outputBytes,
      size_known: sizeKnown, output_complete: task.outputComplete,
      preview_complete: task.previewComplete && sizeKnown, preview: task.preview.slice(),
    };
  }

  /** Wait for closure, not merely the next output chunk; the budget never restarts on output. */
  private async wait(task: Task, waitMs: number, signal?: AbortSignal): Promise<void> {
    checkAbort(signal);
    if (task.finishedAt !== undefined || waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        task.changed.removeListener("change", changed);
        signal?.removeEventListener("abort", abort);
      };
      const done = () => { cleanup(); resolve(); };
      const changed = () => { if (task.finishedAt !== undefined) done(); };
      const abort = () => { cleanup(); reject(new ToolError("OPERATION_CANCELLED", "Waiting cancelled")); };
      const timer = setTimeout(done, waitMs);
      task.changed.on("change", changed);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  /** Cancel an interrupted initial call so it cannot silently leave an unreported background task. */
  async execute(connectionId: string, command: string, cwd: string | undefined, waitMs: number, signal?: AbortSignal): Promise<TaskResult> {
    const id = await this.start(connectionId, command, cwd, signal);
    try {
      await this.wait(this.get(id), waitMs, signal);
      const task = this.get(id);
      const result = this.snapshot(id);
      // The inline result contains the full output only for a successful, fully previewed command.
      if (result.finished && result.reason === undefined && result.exit_code === 0 &&
          result.preview_complete && result.output_complete && result.size_known) {
        task.readBytes = task.outputBytes;
      }
      return result;
    } catch (error) {
      await this.stop(id);
      const task = this.get(id);
      throw new ToolError("OPERATION_CANCELLED", `Bash call cancelled; stop requested for ${id}. Retained log: ${task.outputFile}`);
    }
  }

  /** Interrupting a later query leaves its already reported command running. */
  async output(taskId: string, waitMs = 30000, signal?: AbortSignal): Promise<TaskResult> {
    const task = this.get(taskId);
    await this.wait(task, waitMs, signal);
    const result = this.snapshot(taskId);
    task.readBytes = task.outputBytes;
    return result;
  }

  /** Request TERM, allow helper escalation, and avoid claiming completion until the channel closes. */
  async stop(taskId: string): Promise<TaskResult> {
    const task = this.get(taskId);
    if (task.finishedAt === undefined && task.channel) {
      task.stopRequested = true;
      task.channel.stdin.write(JSON.stringify({ action: "stop" }) + "\n");
      await this.wait(task, 4000);
      if (task.finishedAt === undefined) task.channel.cancel();
    }
    return this.snapshot(taskId);
  }

  /** Stop owned commands during MCP EOF and refuse further starts. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.tasks.values()]
      .filter((task) => task.finishedAt === undefined).map((task) => this.stop(task.id)));
  }
}

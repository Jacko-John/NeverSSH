/** Own remote Bash lifetimes and a bounded tail preview; full output lives in remote archives. */
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { RemoteChannel } from "../ssh/request-channel";
import { bounded, checkAbort, ToolError } from "../errors";
import { ShortIds } from "../ids";
import { JsonLines } from "../ssh/json-lines";
import type { SshTransport } from "../ssh/transport";
import { showsSearchText, viewedFile, type FileView } from "./file-view";
import { outputEvent, tailEvent, TaskPreview, type PreviewChunk } from "./preview";

const MAX_ACTIVE_TASKS = 4;
const MAX_RETAINED_TASKS = 256;
const RETENTION_MS = 14 * 24 * 60 * 60_000;

type Reason = "cancelled" | "connection_closed" | "connection_lost" | "failed" | "output_limit" | "output_error";
const viewedRevision = z.object({
  path: z.string().startsWith("/"), requestPath: z.string().startsWith("/"), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  hasNul: z.boolean(),
});

/** Validate private helper records before they change local task state. */
const helperEvent = z.union([
  z.object({ event: z.literal("started"), pid: z.number().int().positive(), cwd: z.string(),
    outputFile: z.string().startsWith("/"), outputBytes: z.number().int().positive() }),
  outputEvent, tailEvent, z.object({ event: z.literal("progress"), outputBytes: z.number().int().nonnegative() }),
  z.object({ event: z.literal("exit"), exitCode: z.number().int(), outputBytes: z.number().int().nonnegative(),
    outputComplete: z.boolean(), message: z.string().nullish(), viewedFile: viewedRevision.nullish(),
    reason: z.enum(["cancelled", "disconnected", "failed", "output_limit", "output_error"]).nullish() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

export type TaskSummary = {
  connection_id: string;
  task_id: string;
  finished: boolean;
  exit_code: number | null;
  reason?: Reason | undefined;
  stop_requested: boolean;
  output_file: string;
  output_bytes: number;
};

export type TaskResult = TaskSummary & {
  message?: string | undefined;
  size_known: boolean;
  output_complete: boolean;
  preview_complete: boolean;
  preview: PreviewChunk[];
};

/** A final, known exit with all archived program output present in the preview. */
export function hasCompleteResult(result: TaskResult): boolean {
  return result.finished && result.exit_code !== null && result.size_known && result.output_complete && result.preview_complete;
}

type Task = {
  id: string;
  connectionId: string;
  channel?: RemoteChannel;
  outputFile: string;
  outputBytes: number;
  outputComplete: boolean;
  preview: TaskPreview;
  onDemand: boolean;
  pendingPreview?: { id: number; promise: Promise<TaskResult>; resolve: (value: TaskResult) => void };
  readBytes: number;
  viewObservation: number;
  view: FileView | undefined;
  viewedFile?: z.infer<typeof viewedRevision>;
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
  private previewSequence = 0;
  private closed = false;

  constructor(private readonly ssh: Pick<SshTransport, "open" | "cwd">) {}

  /** Task IDs are unique in this MCP instance; connection ownership stays internal. */
  private get(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new ToolError("TASK_NOT_FOUND", "Task does not exist in this MCP instance");
    return task;
  }

  /** Preserve all active tasks; evict completed local previews without touching remote logs. */
  private prune(): void {
    const expiredBefore = Date.now() - RETENTION_MS;
    for (const task of this.tasks.values()) {
      if (task.finishedAt !== undefined &&
          (task.finishedAt <= expiredBefore || this.tasks.size >= MAX_RETAINED_TASKS)) {
        this.tasks.delete(task.id);
      }
    }
  }

  /** Admit a command only after reserving local capacity, then confirm the remote child exists. */
  async start(connectionId: string, command: string, cwd?: string, signal?: AbortSignal, viewObservation = 0, attempt = 0): Promise<string> {
    checkAbort(signal);
    if (this.closed) throw new ToolError("CONNECTION_LOST", "Task manager is closed");
    let active = 0;
    for (const task of this.tasks.values()) {
      if (task.connectionId === connectionId && task.finishedAt === undefined) active++;
    }
    if (active >= MAX_ACTIVE_TASKS) {
      throw new ToolError("TASK_LIMIT_REACHED", "Four commands are already active on this connection; wait for or stop one first");
    }
    this.prune();
    if (this.tasks.size >= MAX_RETAINED_TASKS) throw new ToolError("TASK_LIMIT_REACHED", "Task registry is full");
    const view = viewedFile(command, this.ssh.cwd(connectionId));
    const task: Task = {
      id: `task_${this.ids.next()}`, connectionId, outputFile: "", outputBytes: 0, outputComplete: true,
      preview: new TaskPreview(), onDemand: false, readBytes: 0, viewObservation, started: false, exitCode: null,
      stopRequested: false, changed: new EventEmitter(), view,
    };
    this.tasks.set(task.id, task);
    try {
      const channel = await this.ssh.open(connectionId, "bash", { command, taskId: task.id, ...(view ? { viewPath: view.path } : {}) }, cwd, signal);
      task.channel = channel;
      await this.attach(task, channel, signal);
      return task.id;
    } catch (error) {
      task.channel?.cancel();
      this.tasks.delete(task.id);
      // Archive collisions are reported before Bash starts, so only this case permits an automatic retry.
      if (error instanceof ToolError && error.code === "TASK_ID_EXISTS" && attempt < 8) {
        return this.start(connectionId, command, cwd, signal, viewObservation, attempt + 1);
      }
      throw error;
    }
  }

  /** Decode the private protocol; program stdout never supplies task metadata. */
  private attach(task: Task, channel: RemoteChannel, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const records = new JsonLines(131072);
      let terminal = false;
      let broken = false;
      let startupError: { code: string; message: string } | undefined;
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
        fail("Command start cancelled; inspect remote state before retrying", "failed", "OPERATION_CANCELLED");
        channel.cancel();
      };
      const timer = setTimeout(() => {
        fail("Remote command did not confirm startup within 15 seconds; inspect remote state before retrying");
        channel.cancel();
      }, 15000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      channel.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
      channel.stdout.setEncoding("utf8");
      channel.stdout.on("data", (chunk: string) => {
        try {
          records.push(chunk, (record) => {
            if (broken) return;
            if (startupError || terminal) throw new Error("Unexpected helper event after a terminal record");
            const event = helperEvent.parse(record);
            if ("ok" in event) {
              if (task.started) {
                fail(event.error.message, "failed", event.error.code);
                channel.cancel();
              } else {
                // The helper has reported an error and is exiting. Let the worker reap it
                // before a client can close the connection or retry an archive collision.
                startupError = event.error;
              }
              return;
            }
            if (event.event === "started" && !task.started) {
              task.started = true;
              task.outputFile = event.outputFile;
              task.preview.through = task.outputBytes = event.outputBytes;
              cleanupStart();
              resolve();
            } else if (event.event === "output" && task.started && !task.onDemand) {
              task.preview.output(event);
              task.outputBytes = event.outputBytes;
            } else if ((event.event === "progress" || event.event === "tail") && task.started) {
              if (event.outputBytes < task.outputBytes) throw new Error("Malformed output byte count");
              task.onDemand = true;
              if (event.event === "tail") task.preview.tail(event);
              task.outputBytes = event.outputBytes;
              if (event.event === "tail" && event.requestId !== undefined) this.deliverPreview(task, event.requestId);
            } else if (event.event === "exit" && task.started) {
              if (event.outputBytes < task.outputBytes) {
                throw new Error("Malformed task exit event");
              }
              terminal = true;
              task.exitCode = event.exitCode;
              task.reason = event.reason === "disconnected" ? "connection_closed" : event.reason ?? undefined;
              task.message = typeof event.message === "string" ? event.message : undefined;
              task.outputBytes = event.outputBytes;
              task.outputComplete = event.outputComplete;
              task.onDemand = false;
              if (event.viewedFile) task.viewedFile = event.viewedFile;
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
        task.preview.finish();
        if (!terminal && !broken) {
          // A collision can be retried only when the helper also exits with its reserved pre-start status.
          if (startupError && (code === 2 || (code === 1 && startupError.code !== "TASK_ID_EXISTS"))) {
            fail(startupError.message, "failed", startupError.code);
          } else {
            const detail = startupError ? `${startupError.code}: ${startupError.message} (helper exit ${code})` : diagnostics.trim() || `exit ${code}`;
            fail(`SSH channel closed without a command result: ${detail}. Inspect remote state before retrying.`,
              code === 255 ? "connection_lost" : "failed");
          }
        }
        if (!terminal) task.exitCode = null;
        task.finishedAt = Date.now();
        // Retained previews do not need the closed streams or the worker that owned them.
        delete task.channel;
        this.deliverPreview(task);
        task.changed.emit("change");
      });
    });
  }

  /** A search may show just some matches. Other views require a complete preview with stdout. */
  takeFileView(result: TaskResult): (z.infer<typeof viewedRevision> & { observation: number }) | undefined {
    if (!result.finished || result.reason || result.exit_code !== 0 || !result.output_complete) return;
    const task = this.get(result.task_id);
    const revision = task.viewedFile;
    if (!revision || !task.view) return;
    delete task.viewedFile;
    if (task.view.search) {
      let stdout = "";
      for (const chunk of result.preview) if (chunk.stream === "stdout") stdout += chunk.text;
      if (!showsSearchText(task.view, stdout, revision.hasNul, !result.preview_complete)) return;
    } else if (!result.preview_complete || !result.preview.some(chunk => chunk.stream === "stdout" && chunk.text.length > 0)) return;
    return { ...revision, observation: task.viewObservation };
  }

  /** List tasks with unread output, active first. */
  list(connectionId?: string): TaskSummary[] {
    this.prune();
    const tasks: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.outputBytes > task.readBytes && (connectionId === undefined || task.connectionId === connectionId)) tasks.push(task);
    }
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
      preview_complete: task.preview.complete && task.preview.through === task.outputBytes && sizeKnown,
      preview: task.preview.chunks.slice(),
    };
  }

  private deliverPreview(task: Task, id?: number): void {
    if (task.pendingPreview && (id === undefined || task.pendingPreview.id === id)) {
      task.pendingPreview.resolve(this.snapshot(task.id));
      delete task.pendingPreview;
    }
  }

  /** Concurrent readers share a snapshot. Each marks only the bytes at that checkpoint. */
  private async currentPreview(task: Task, signal?: AbortSignal): Promise<TaskResult> {
    checkAbort(signal);
    if (!task.channel || !task.onDemand) return this.snapshot(task.id);
    const message = "Timed out waiting for task preview: " + task.id;
    let pending = task.pendingPreview;
    if (!pending) {
      const id = ++this.previewSequence;
      const { promise, resolve } = Promise.withResolvers<TaskResult>();
      const reply = bounded(promise, 5000, "TASK_PREVIEW_TIMEOUT", message).finally(() => {
        if (task.pendingPreview?.id === id) delete task.pendingPreview;
      });
      task.pendingPreview = pending = { id, promise: reply, resolve };
      task.channel.requestPreview(id);
    }
    return signal ? bounded(pending.promise, 5000, "TASK_PREVIEW_TIMEOUT", message, signal) : pending.promise;
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
  async execute(connectionId: string, command: string, cwd: string | undefined, waitMs: number, signal?: AbortSignal,
    viewObservation = 0): Promise<TaskResult> {
    const id = await this.start(connectionId, command, cwd, signal, viewObservation);
    try {
      await this.wait(this.get(id), waitMs, signal);
      checkAbort(signal);
    } catch {
      await this.stop(id);
      const task = this.get(id);
      throw new ToolError("OPERATION_CANCELLED", `Bash call cancelled; stop requested for ${id}. Retained log: ${task.outputFile}`);
    }
    return this.snapshot(id);
  }

  /** Acknowledge only the bytes in this response, even if another snapshot has arrived. */
  markRead(result: TaskResult): void {
    const task = this.tasks.get(result.task_id);
    if (task) task.readBytes = Math.max(task.readBytes, result.output_bytes);
  }

  /** Interrupting a later query leaves its already reported command running. */
  async output(taskId: string, waitMs = 30000, signal?: AbortSignal): Promise<TaskResult> {
    const task = this.get(taskId);
    await this.wait(task, waitMs, signal);
    const result = await this.currentPreview(task, signal);
    this.markRead(result);
    return result;
  }

  /** Request TERM, allow helper escalation, and avoid claiming completion until the channel closes. */
  async stop(taskId: string): Promise<TaskResult> {
    const task = this.get(taskId);
    if (task.finishedAt === undefined && task.channel) {
      task.stopRequested = true;
      task.channel.stopCommand();
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

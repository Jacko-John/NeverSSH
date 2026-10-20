/** Present command results as readable MCP text while preserving program whitespace. */
import type { TaskResult, TaskSummary } from "./tasks";

type View = "bash" | "query" | "stop";

/** Include exact bytes so agents can choose a bounded log-reading strategy. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const unit = bytes < 1024 * 1024 ? "KiB" : bytes < 1024 * 1024 * 1024 ? "MiB" : "GiB";
  const divisor = unit === "KiB" ? 1024 : unit === "MiB" ? 1024 * 1024 : 1024 * 1024 * 1024;
  return `${(bytes / divisor).toFixed(2)} ${unit} (${bytes} bytes)`;
}

type TaskState = Pick<TaskResult, "finished" | "exit_code" | "reason" | "stop_requested">;

/** Describe uncertainty explicitly when only the local SSH channel's closure is known. */
function status(task: TaskState): string {
  if (task.reason === "connection_lost") return "connection lost; remote process state unknown";
  if (task.finished) {
    if (task.exit_code === null) return "result unknown";
    if (task.reason === "cancelled") return "stopped";
    if (task.reason === "connection_closed") return "stopped with connection";
    if (task.reason) return "failed";
    return task.exit_code === 0 ? "completed" : "failed";
  }
  return task.stop_requested ? "stop requested; completion not yet confirmed" : "running in background";
}

/** Keep raw Bash output compact; task reports label each stream for clarity. */
function programOutput(task: TaskResult, labeled: boolean): string {
  const stdout = task.preview.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join("");
  const stderr = task.preview.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join("");
  if (labeled) return [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n\n");
  if (stdout && stderr) return `${stdout}\nstderr:\n${stderr}`;
  return stdout || (stderr ? `stderr:\n${stderr}` : "");
}

/** Show the retained log only when its size or completeness affects the next step. */
function log(task: TaskResult, hint = false): string {
  const suffix = hint ? "; read selectively" : "";
  if (!task.size_known) return `Log: ${task.output_file}${suffix}`;
  const growing = task.finished ? "" : "; still growing";
  return `Log: ${task.output_file} (${size(task.output_bytes)}${growing})${suffix}`;
}

/** A successful short command needs no handle; background and incomplete results do. */
function bashHeader(task: TaskResult): string[] {
  const lines = [`Task: ${task.task_id} (${status(task)})`];
  if (task.reason && task.reason !== "connection_lost") lines.push(`Reason: ${task.reason}`);
  if (task.finished) lines.push(`Exit code: ${task.exit_code ?? "unknown"}`);
  if (!task.size_known) lines.push(`Last confirmed output size: ${size(task.output_bytes)}; remote file size may differ`);
  lines.push(log(task, !task.preview_complete));
  if (!task.output_complete) lines.push("Log incomplete or unconfirmed.");
  return lines;
}

/** Explicit queries and stops report status even when the command succeeded. */
function reportHeader(task: TaskResult, includeLog: boolean): string[] {
  const lines = [`Task: ${task.task_id} (${status(task)})`];
  if (task.reason) lines.push(`Reason: ${task.reason}`);
  if (task.finished) lines.push(`Exit code: ${task.exit_code ?? "unknown"}`);
  const showLog = includeLog || !task.preview_complete || !task.output_complete;
  if (!task.size_known) {
    lines.push(`Last confirmed output size: ${size(task.output_bytes)}; remote file size may differ`);
  } else if (!task.finished) {
    lines.push(`Output size so far: ${size(task.output_bytes)}; still growing`);
  } else if (!showLog) {
    lines.push(`Output size: ${size(task.output_bytes)}`);
  }
  if (!task.output_complete) lines.push("Log incomplete or unconfirmed.");
  if (showLog) lines.push(log(task, !task.preview_complete));
  return lines;
}

/** Compact one-line status for task discovery. */
function listStatus(task: TaskSummary): string {
  if (!task.finished) return task.stop_requested ? "stopping" : "running";
  if (task.reason === "connection_lost") return "lost";
  if (task.reason === "cancelled" || task.reason === "connection_closed") return "stopped";
  if (task.exit_code === null) return "unknown";
  if (task.reason) return "failed";
  return task.exit_code === 0 ? "completed" : "failed";
}

/** List retained tasks without previews; active tasks come first from TaskManager.list. */
export function taskListText(tasks: TaskSummary[]): string {
  if (!tasks.length) return "No tasks.";
  return tasks.map((task) =>
    `${task.task_id}  ${listStatus(task)}  ${task.connection_id}  ${task.output_file || "-"}`).join("\n");
}

/** Keep the first line unambiguous for clients that read task handles from text. */
export function taskText(task: TaskResult, view: View = "bash"): string {
  if (view === "bash") {
    const output = programOutput(task, false);
    if (task.finished && task.reason === undefined && task.exit_code === 0 &&
        task.preview_complete && task.output_complete && task.size_known) return output;
    const header = bashHeader(task).join("\n");
    return output ? `${header}\n\n${output}` : header;
  }

  const output = programOutput(task, true);
  const header = reportHeader(task, view === "stop").join("\n");
  return output ? `${header}\n\n${output}` : header;
}

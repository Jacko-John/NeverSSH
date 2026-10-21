/** One request's input, output, and result within a shared SSH worker connection. */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { ToolError } from "./errors";
import { JsonLines } from "./json-lines";

export type RemoteResult = Record<string, unknown>;

export class RemoteChannel extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  private ended = false;

  constructor(private readonly send: (message: RemoteResult) => void) {
    super();
    const input = new JsonLines(131072);
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        try {
          input.push(chunk.toString(), (message) => {
            if (!this.ended) this.send({ type: "control", message });
          });
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      final: (callback) => {
        try {
          if (!this.ended) this.send({ type: "eof" });
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    this.stdin.on("error", () => {});
  }

  /** Stop this request through the supervisor, which remains responsible for its children. */
  cancel(): void {
    if (this.ended) return;
    try {
      this.send({ type: "cancel" });
    } catch {
      // A disconnected worker will finish the channel through its connection-loss handler.
    }
  }

  /** Deliver the terminal event once, after all preceding output records. */
  finish(code: number, diagnostic?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (diagnostic) this.stderr.write(diagnostic);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }

  /** Collect a one-shot file or transfer result; cancellation leaves a mutation's outcome uncertain. */
  collect(connectionId: string, maxFileBytes: number, signal?: AbortSignal, timeoutMs = 30000): Promise<RemoteResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let failure: Error | undefined;
      // A UTF-8 byte can become six JSON characters (for example, U+0001 -> \\u0001).
      const responseLimit = maxFileBytes * 6 + 131072;

      const interrupt = (message: string) => {
        if (failure) return;
        failure = new ToolError("OPERATION_INTERRUPTED", message);
        stdout = "";
        this.cancel();
      };
      const abort = () => interrupt("Operation cancelled; inspect the destination before retrying a mutation");
      const timer = setTimeout(() => {
        interrupt("Operation timed out; inspect the destination before retrying a mutation");
      }, timeoutMs);

      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      this.stdout.setEncoding("utf8");
      this.stdout.on("data", (chunk: string) => {
        if (failure) return;
        stdout += chunk;
        if (stdout.length > responseLimit) {
          interrupt("Remote response exceeds its size limit");
        }
      });
      this.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });

      this.once("close", (code: number) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failure) return reject(failure);

        try {
          const response = JSON.parse(stdout.trim());
          if (response.ok && code === 0 && response.result) return resolve(response.result);
          if (response.error) {
            return reject(new ToolError("REMOTE_OPERATION_FAILED", `${response.error.code}: ${response.error.message}`));
          }
        } catch {
          // Missing or malformed helper output is reported with transport diagnostics below.
        }

        reject(new ToolError(
          code === 255 ? "CONNECTION_LOST" : "REMOTE_OPERATION_FAILED",
          stderr.trim() || "Invalid remote operation response",
          { connection_id: connectionId },
        ));
      });
      this.stdin.end();
    });
  }
}

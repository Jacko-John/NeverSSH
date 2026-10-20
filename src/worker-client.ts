/** Multiplex requests and shutdown over one remote worker process. */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { RemoteChannel, type RemoteResult } from "./channel";
import type { Config } from "./config";
import { bounded, checkAbort, ToolError } from "./errors";
import { JsonLines } from "./json-lines";
import fileOpsSource from "./remote/file_ops.py" with { type: "text" };
import { ARCHIVE_FORMAT, BUILD_ID, BUILD_MANIFEST, BUILD_SOURCES, MIN_PYTHON, PROTOCOL_VERSION, SERVER_VERSION } from "./version-info";

export const WORKER_BOOTSTRAP = 'import json,sys; payload=json.loads(sys.stdin.buffer.readline()); exec(compile(payload["sources"]["build_cache.py"],"<neverssh-build-cache>","exec"))';
export type CleanupStatus = "confirmed" | "unconfirmed";

type WorkerMessage =
  | { type: "hello"; protocol: number; version: string; build_id: string; archive_format: number; python_version: string; home: string }
  | { type: "startup_error"; code: string; message: string }
  | { type: "bye"; cleanup_confirmed: boolean }
  | { type: "stdout" | "stderr"; id: string; base64: string }
  | { type: "close"; id: string; code: number };

/** Name each lifecycle promise instead of storing unrelated resolver callbacks on connections. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Bound active requests and queue admission independently from SSH transport channels. */
class RequestSlots {
  private active = 0;
  private waiters: Array<() => void> = [];

  /** Transfer a released slot directly to the next waiter; release is idempotent. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.active < 8) {
      this.active++;
    } else {
      if (this.waiters.length >= 64) {
        throw new ToolError("CONNECTION_BUSY", "Too many queued operations");
      }
      await this.waitForSlot(signal);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }

  /** Cancel only this waiter, preserving the order of other queued requests. */
  private waitForSlot(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const remove = (error: Error) => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        cleanup();
        reject(error);
      };
      const abort = () => remove(signal.reason instanceof ToolError
        ? signal.reason
        : new ToolError("OPERATION_CANCELLED", "Operation cancelled while queued"));
      const timer = setTimeout(() => {
        remove(new ToolError("CONNECTION_BUSY", "Timed out waiting for an operation slot"));
      }, 30000);

      this.waiters.push(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

export class WorkerClient {
  home = "~";
  private initialized = false;
  private accepting = true;
  private cleanup: CleanupStatus = "unconfirmed";
  private diagnostics = "";
  private sequence = 0;
  private requests = new Map<string, RemoteChannel>();
  private slots = new RequestSlots();
  private lifetime = new AbortController();
  private hello = deferred<void>();
  private goodbye = deferred<void>();
  private exited = deferred<void>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connectionId: string,
    private readonly onDisconnect: (diagnostic: string) => void,
  ) {
    this.attach();
  }

  /** Load bundled sources once and wait until the worker confirms its protocol and home directory. */
  async initialize(config: Pick<Config, "maxFileBytes" | "maxTaskOutputBytes" | "maxArchiveBytes">, signal: AbortSignal): Promise<void> {
    const { maxFileBytes, maxTaskOutputBytes, maxArchiveBytes } = config;
    this.child.stdin.write(JSON.stringify({
      buildId: BUILD_ID, manifest: BUILD_MANIFEST, sources: BUILD_SOURCES,
      serverVersion: SERVER_VERSION, protocol: PROTOCOL_VERSION, archiveFormat: ARCHIVE_FORMAT,
      minPython: MIN_PYTHON, connectionId: this.connectionId,
      maxFileBytes, maxTaskOutputBytes, maxArchiveBytes,
    }) + "\n");
    await bounded(this.hello.promise, 30000, "CONNECT_TIMEOUT", "Remote worker handshake timed out", signal);
  }

  /** Route complete records; transport loss retires requests rather than replaying them. */
  private attach(): void {
    const records = new JsonLines(65536);
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = (this.diagnostics + chunk.toString()).slice(-8192);
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      try {
        records.push(chunk, (record) => this.receive(record as WorkerMessage));
      } catch (error) {
        this.hello.reject(error instanceof Error ? error : new Error(String(error)));
        this.onDisconnect("Remote worker protocol failed");
        this.child.kill("SIGTERM");
      }
    });
    this.child.once("error", (error) => {
      this.hello.reject(new ToolError("WORKER_START_FAILED", error.message));
    });
    this.child.once("close", (code) => {
      this.exited.resolve();
      if (!this.initialized) this.hello.reject(this.startupFailure(code));
      this.onDisconnect("Remote worker disconnected");
    });
  }

  /** Keep handshake, control, and per-request messages visibly separate. */
  private receive(message: WorkerMessage): void {
    switch (message.type) {
      case "hello":
        if (this.initialized) throw new Error("Unexpected worker protocol record");
        if (message.protocol !== PROTOCOL_VERSION) {
          throw new ToolError("PROTOCOL_INCOMPATIBLE", "Remote worker protocol is incompatible");
        }
        if (message.build_id !== BUILD_ID) {
          throw new ToolError("BUILD_MISMATCH", "Remote worker build does not match this MCP bundle");
        }
        if (typeof message.home !== "string") throw new Error("Invalid worker hello");
        this.home = message.home;
        this.initialized = true;
        this.hello.resolve();
        return;
      case "startup_error":
        this.hello.reject(new ToolError(String(message.code), String(message.message)));
        return;
      case "bye":
        if (message.cleanup_confirmed === true) this.cleanup = "confirmed";
        this.goodbye.resolve();
        return;
      case "stdout":
      case "stderr":
        if (typeof message.base64 !== "string") throw new Error("Invalid worker stream record");
        this.requests.get(message.id)?.[message.type].write(Buffer.from(message.base64, "base64"));
        return;
      case "close":
        if (!Number.isInteger(message.code)) throw new Error("Invalid worker exit record");
        this.requests.get(message.id)?.finish(message.code);
        return;
      default:
        throw new Error("Unexpected worker protocol record");
    }
  }

  /** Preserve a generic startup failure when diagnostics do not identify a missing interpreter. */
  private startupFailure(code: number | null): ToolError {
    const missingPython = code === 127 || /python.*(not found|no such file)/i.test(this.diagnostics);
    return new ToolError(
      code === 2 || missingPython ? "RUNTIME_UNSUPPORTED" : code === 3 ? "BUILD_UNAVAILABLE" : "WORKER_START_FAILED",
      this.diagnostics.trim() || "Worker exited before completing its handshake",
    );
  }

  /** Send data through stdin; destination selection belongs to the owning SSH connection. */
  private send(message: RemoteResult): void {
    if (this.child.stdin.destroyed || this.child.exitCode !== null) {
      throw new ToolError("CONNECTION_LOST", "Remote worker is unavailable", { connection_id: this.connectionId });
    }
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  /** Admit one request, rechecking shutdown after waiting for capacity. */
  async open(operation: string, args: RemoteResult, cwd: string, signal?: AbortSignal): Promise<RemoteChannel> {
    this.assertAccepting();
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    let release: (() => void) | undefined;
    try {
      release = await this.slots.acquire(combined);
      this.assertAccepting();
      checkAbort(combined);

      const id = String(++this.sequence);
      const channel = new RemoteChannel((message) => this.send({ ...message, id }));
      this.requests.set(id, channel);
      channel.once("close", () => {
        this.requests.delete(id);
        release?.();
      });
      this.send({ type: "request", id, op: operation, args, cwd });
      return channel;
    } catch (error) {
      release?.();
      throw error;
    }
  }

  /** Closing workers never admit queued work after their active requests finish. */
  private assertAccepting(): void {
    if (!this.accepting) {
      throw new ToolError("CONNECTION_LOST", "Connection is closing or lost", { connection_id: this.connectionId });
    }
  }

  /** Confirm cleanup after acknowledgement and exit; disconnected workers remain unconfirmed. */
  async shutdown(timeout: number): Promise<CleanupStatus> {
    if (this.lifetime.signal.aborted) return "unconfirmed";
    this.accepting = false;
    try {
      this.send({ type: "shutdown" });
      await bounded(Promise.all([this.goodbye.promise, this.exited.promise]), timeout, "SHUTDOWN_TIMEOUT", "Worker cleanup timed out");
      return this.cleanup;
    } catch {
      return "unconfirmed";
    }
  }

  /** Settle local requests and waiters before releasing the worker's SSH process. */
  disconnect(diagnostic: string): void {
    this.accepting = false;
    this.lifetime.abort(new ToolError("CONNECTION_LOST", diagnostic));
    for (const channel of [...this.requests.values()]) channel.finish(255, diagnostic);
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

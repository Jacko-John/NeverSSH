/** Manage connection identities, shared startup, and the lifetime of owned OpenSSH processes. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { connectSchema, targetAllowed, type Config, type SshTarget } from "../config";
import type { RemoteChannel, RemoteResult } from "./request-channel";
import { checkAbort, ToolError } from "../errors";
import { ShortIds } from "../ids";
import { resolveTarget, sftpOptions, sshEnvironment, sshFailure, sshOptions, type ResolvedTarget } from "./openssh";
import { WorkerClient, WORKER_BOOTSTRAP, type CleanupStatus } from "./worker-client";
import { SharedOperation } from "./shared-operation";
import { WaitBudget } from "./wait-queue";

export type { RemoteResult } from "./request-channel";

/** Internal connection metadata for lifecycle management and the session-list formatter. */
type ConnectionSummary = { connection_id: string; host: string; user: string; port: number };

const MAX_CONNECTIONS = 64;
const CLOSE_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 6_000;
const SFTP_STOP_TIMEOUT_MS = 2_000;

type Connection = ResolvedTarget & {
  id: string;
  state: "ready" | "lost" | "closing" | "closed";
  socket: string;
  master: ChildProcess;
  worker: WorkerClient;
  waitBudget: WaitBudget;
  cleanup: CleanupStatus;
  sftpLifetime: AbortController;
  sftpRequests: Set<Promise<void>>;
  sftpProbe?: SharedOperation<void> | true;
  closing?: Promise<void>;
};

/** Quote the fixed Python bootstrap for the remote POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Keep ready connections without idle expiry until explicit close, transport loss, or MCP shutdown. */
export class SshTransport {
  private connections = new Map<string, Connection>();
  private reusable = new Map<string, Connection>();
  private pending = new Map<string, SharedOperation<Connection>>();
  private readonly ids = new ShortIds();
  private directory = mkdtemp("/tmp/neverssh-");
  private lifetime = new AbortController();
  private closed = false;

  constructor(readonly config: Config) {}

  /** Retain lost/closed handles for explicit cleanup and previously collected job output. */
  get(id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection) {
      throw new ToolError("CONNECTION_NOT_FOUND", "Connection does not exist in this MCP instance");
    }
    return connection;
  }

  /** Check one handle without constructing a summary of every ready connection. */
  isReady(id: string): boolean {
    return !this.closed && this.connections.get(id)?.state === "ready";
  }

  /** Require an existing ready handle; an operation never reconnects implicitly. */
  private ready(id: string): Connection {
    const connection = this.get(id);
    if (this.closed) {
      throw new ToolError("CONNECTION_LOST", "SSH transport is shutting down");
    }
    if (connection.state !== "ready") {
      throw new ToolError("CONNECTION_LOST", `Connection is ${connection.state}; call ssh_connect to obtain a ready handle`);
    }
    return connection;
  }

  /** Give each caller its own total deadline, including configuration resolution and shared startup. */
  async connect(target: SshTarget, timeoutSeconds = 60, signal?: AbortSignal): Promise<RemoteResult> {
    connectSchema.parse({ ...target, timeout_seconds: timeoutSeconds });
    const timeout = timeoutSeconds * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new ToolError("CONNECT_TIMEOUT", "Connection preparation exceeded timeout_seconds"));
    }, timeout);
    const combined = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);

    try {
      return await this.connectTarget(target, combined);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Authorize the effective destination before reusing or starting its connection. */
  private async connectTarget(target: SshTarget, signal: AbortSignal): Promise<RemoteResult> {
    if (this.closed) throw new ToolError("CONNECTION_LOST", "SSH transport is closed");
    checkAbort(signal);

    const resolved = await resolveTarget(this.config, target, signal);
    if (!targetAllowed(this.config, target, resolved.endpoint)) {
      throw new ToolError("TARGET_DENIED", "Target is outside the configured SSH access policy");
    }
    const existing = this.reusable.get(resolved.key);
    if (existing?.state === "ready") return { connection_id: existing.id };

    const { key } = resolved;
    let startup = this.pending.get(key);
    if (!startup) {
      startup = new SharedOperation(signal => this.create(resolved, signal).finally(() => this.pending.delete(key)));
      this.pending.set(key, startup);
    }
    const connection = await startup.wait(signal);
    return { connection_id: connection.id };
  }

  /** Evict only closed records; issued IDs remain reserved for this process's lifetime. */
  private allocateId(): string {
    for (const [id, connection] of this.connections) {
      if (connection.state === "closed" && this.connections.size >= MAX_CONNECTIONS) {
        this.connections.delete(id);
      }
    }
    if (this.connections.size + this.pending.size >= MAX_CONNECTIONS) {
      throw new ToolError("CONNECTION_BUSY", "Connection registry is full; close unused connections");
    }

    return this.ids.next();
  }

  /** Publish a handle only after its master and worker have completed startup. */
  private async create(resolved: ResolvedTarget, signal: AbortSignal, attempt = 0): Promise<Connection> {
    const { target, key, supportedOptions } = resolved;
    const id = this.allocateId();
    const socket = `${await this.directory}/${id}`;
    let master: ChildProcess | undefined;
    let worker: WorkerClient | undefined;
    const abort = () => {
      worker?.disconnect("Connection preparation cancelled");
      master?.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      checkAbort(signal);
      master = await this.startMaster(resolved, socket, signal);
      const child = spawn("ssh", [
        ...sshOptions(this.config, target, socket, false, supportedOptions),
        target.host,
        `exec python3 -I -B -u -c ${shellQuote(WORKER_BOOTSTRAP)}`,
      ], { stdio: ["pipe", "pipe", "pipe"], env: sshEnvironment() });

      const waitBudget = new WaitBudget();
      worker = new WorkerClient(child, id, (diagnostic) => this.lost(connection, diagnostic), waitBudget);
      const connection: Connection = {
        ...resolved, id, socket, master, worker, waitBudget,
        state: "ready",
        cleanup: "unconfirmed",
        sftpLifetime: new AbortController(),
        sftpRequests: new Set(),
      };
      master.once("exit", () => this.lost(connection, "SSH transport disconnected"));
      await worker.initialize(this.config, signal);
      checkAbort(signal);
      if (this.closed || connection.state !== "ready") {
        throw new ToolError("CONNECTION_LOST", "Connection closed while preparing the worker");
      }

      this.connections.set(id, connection);
      this.reusable.set(key, connection);
      return connection;
    } catch (error) {
      abort();
      await rm(socket, { force: true });
      // No connection handle has been published, so an archived-ID collision can safely retry.
      if (error instanceof ToolError && error.code === "SESSION_ID_EXISTS" && attempt < 8) {
        return this.create(resolved, signal, attempt + 1);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** Wait for the private control socket, retaining bounded native SSH diagnostics on failure. */
  private async startMaster({ target, supportedOptions }: ResolvedTarget, socket: string, signal: AbortSignal): Promise<ChildProcess> {
    const child = spawn("ssh", [...sshOptions(this.config, target, socket, true, supportedOptions), target.host], {
      stdio: ["ignore", "ignore", "pipe"], env: sshEnvironment(),
    });
    let diagnostic = "";
    let failure: Error | undefined;
    let ended = false;
    child.stderr!.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    child.on("error", (error) => {
      failure = new ToolError("SSH_UNAVAILABLE", error.message);
      ended = true;
    });
    child.once("exit", () => { ended = true; });

    try {
      const deadline = Date.now() + 20000;
      while (!ended && Date.now() < deadline) {
        checkAbort(signal);
        const socketReady = await stat(socket).then((info) => info.isSocket()).catch(() => false);
        if (socketReady) return child;
        await delay(20);
      }
      throw failure ?? sshFailure(diagnostic.trim() || "SSH connection timed out");
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  /** Stop owned SFTP processes and retire reuse without displacing a newer connection. */
  private retire(connection: Connection): void {
    connection.sftpLifetime.abort(new ToolError("CONNECTION_LOST", `Connection is ${connection.state}; SFTP stopped`));
    delete connection.sftpProbe;
    if (this.reusable.get(connection.key) === connection) this.reusable.delete(connection.key);
  }

  /** Fail attached requests and release owned processes while retaining the handle for later cleanup. */
  private lost(connection: Connection, diagnostic: string): void {
    if (connection.state === "closed") return;
    if (connection.state !== "closing") {
      connection.state = "lost";
      connection.master.kill("SIGTERM");
    }
    this.retire(connection);
    connection.worker.disconnect(diagnostic);
  }

  /** Open a request within an existing connection; worker admission handles concurrent shutdown. */
  async open(id: string, operation: string, args: RemoteResult, cwd?: string, signal?: AbortSignal): Promise<RemoteChannel> {
    const { worker } = this.ready(id);
    return worker.open(operation, args, cwd ?? worker.home, signal);
  }

  /** One-shot requests return one result; command callers consume their channel directly. */
  async run(id: string, operation: string, args: RemoteResult = {}, cwd?: string, signal?: AbortSignal, timeoutMs = 30000): Promise<RemoteResult> {
    const channel = await this.open(id, operation, args, cwd, signal);
    return channel.collect(this.config.maxFileBytes, signal, timeoutMs);
  }

  /** Return the default directory captured during the worker handshake. */
  cwd(id: string): string {
    return this.get(id).worker.home;
  }

  /** Share subsystem discovery while each caller cancels only its own wait. */
  async prepareSftp(id: string, signal?: AbortSignal): Promise<void> {
    const connection = this.ready(id);
    checkAbort(signal);
    let probe = connection.sftpProbe;
    if (probe === true) return;
    if (!probe || probe.controller.signal.aborted) {
      probe = new SharedOperation(signal => this.sftp(id, ["pwd"], signal).then(
        () => { if (connection.sftpProbe === probe) connection.sftpProbe = true; },
        (error) => {
          if (connection.sftpProbe === probe) delete connection.sftpProbe;
          if (error instanceof ToolError &&
              ["SFTP_UNAVAILABLE", "SFTP_TIMEOUT", "OPERATION_CANCELLED", "CONNECTION_LOST"].includes(error.code)) {
            throw error;
          }
          throw new ToolError("SFTP_UNAVAILABLE",
            "SFTP is unavailable on this connection; enable the remote SFTP subsystem");
        },
      ));
      connection.sftpProbe = probe;
    }

    try {
      await probe.wait(signal);
    } finally {
      // SFTP cancellation returns after its subprocess and process group have been reaped.
      if (probe.controller.signal.aborted) await probe.promise.catch(() => {});
    }
  }

  /** Run a batch of SFTP commands over the existing ControlMaster instead of the worker protocol. */
  async sftp(id: string, commands: string[], signal?: AbortSignal, timeoutMs = 120000): Promise<void> {
    const connection = this.ready(id);
    const combined = AbortSignal.any([this.lifetime.signal, connection.sftpLifetime.signal, ...(signal ? [signal] : [])]);
    checkAbort(combined);
    const child = spawn("sftp", [
      ...sftpOptions(this.config, connection.target, connection.socket, connection.supportedOptions),
      "-q", "-b", "-", connection.target.host,
    ], { stdio: ["pipe", "pipe", "pipe"], env: sshEnvironment(), detached: true });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.stdout!.on("data", () => {});
    child.stdin!.on("error", () => {});

    const completion = new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (kind: NodeJS.Signals) => {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, kind); return; }
          catch { /* The process may have exited before receiving the signal. */ }
        }
        child.kill(kind);
      };
      const stop = (error: Error) => {
        if (settled || failure) return;
        failure = error;
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), SFTP_STOP_TIMEOUT_MS);
      };
      const abort = () => {
        try { checkAbort(combined); }
        catch (error) { stop(error instanceof Error ? error : new ToolError("OPERATION_CANCELLED", "SFTP transfer cancelled")); }
      };
      const timer = setTimeout(() => stop(new ToolError("SFTP_TIMEOUT", "SFTP transfer exceeded its time limit")), timeoutMs);
      child.once("error", (error) => { failure ??= new ToolError("SFTP_UNAVAILABLE", error.message); });
      child.once("close", (code) => {
        settled = true;
        // A failed parent may exit before its SSH child; do not leave that process group running.
        if (failure || code !== 0) kill("SIGKILL");
        clearTimeout(timer);
        clearTimeout(escalation);
        combined.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new ToolError("SFTP_FAILED", stderr.trim() || `sftp exited with code ${code}`));
      });
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
      child.stdin!.end(commands.join("\n") + "\n");
    });
    connection.sftpRequests.add(completion);
    try { await completion; }
    finally { connection.sftpRequests.delete(completion); }
  }

  /** Expose the compact public identity, keeping process and protocol details internal. */
  private summary(connection: Connection): ConnectionSummary {
    return {
      connection_id: connection.id,
      host: connection.target.host,
      user: connection.endpoint.user,
      port: connection.endpoint.port,
    };
  }

  /** List ready connections using local records; unavailable handles remain internal for cleanup. */
  sessions(): { sessions: ConnectionSummary[] } {
    if (this.closed) return { sessions: [] };
    const sessions = [...this.connections.values()]
      .filter((connection) => connection.state === "ready")
      .map((connection) => this.summary(connection));
    return { sessions };
  }

  /** Close a connection and cancel its active work, sharing cleanup with repeated callers. */
  async closeConnection(id: string): Promise<RemoteResult> {
    const connection = this.get(id);
    await this.beginClose(connection, CLOSE_TIMEOUT_MS);
    return { connection_id: id, remote_cleanup: connection.cleanup };
  }

  /** Stop admission once and share the cleanup operation with explicit close and process shutdown. */
  private beginClose(connection: Connection, timeout: number): Promise<void> {
    if (!connection.closing) {
      connection.state = "closing";
      this.retire(connection);
      connection.closing = this.finishConnection(connection, timeout);
    }
    return connection.closing;
  }

  /** Release local resources even when the peer cannot confirm its own cleanup. */
  private async finishConnection(connection: Connection, timeout: number): Promise<void> {
    try {
      connection.cleanup = await connection.worker.shutdown(timeout);
    } finally {
      await Promise.allSettled([...connection.sftpRequests]);
      connection.worker.disconnect("Connection closed");
      connection.master.kill("SIGTERM");
      connection.state = "closed";
      await rm(connection.socket, { force: true });
    }
  }

  /** Stop admission, abort unfinished startups, then close every retained connection. */
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    for (const pending of this.pending.values()) pending.controller.abort();
    await Promise.allSettled([...this.pending.values()].map((pending) => pending.promise));
    await Promise.allSettled([...this.connections.values()].map((connection) => this.beginClose(connection, SHUTDOWN_TIMEOUT_MS)));
    await rm(await this.directory, { recursive: true, force: true });
  }
}

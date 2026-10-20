/** Manage connection identities, shared startup, and the lifetime of owned OpenSSH processes. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { targetAllowed, type Config, type Endpoint, type SshTarget } from "./config";
import { connectionContracts, type ConnectionSummary } from "./contracts";
import type { RemoteChannel, RemoteResult } from "./channel";
import { bounded, checkAbort, ToolError } from "./errors";
import { ShortIds } from "./ids";
import { resolveTarget, sftpOptions, sshEnvironment, sshFailure, sshOptions } from "./openssh";
import { WorkerClient, WORKER_BOOTSTRAP, type CleanupStatus } from "./worker-client";

export type { RemoteResult } from "./channel";

const MAX_CONNECTIONS = 64;
const CLOSE_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 6_000;

type Connection = {
  id: string;
  key: string;
  target: SshTarget;
  endpoint: Endpoint;
  state: "ready" | "lost" | "closing" | "closed";
  socket: string;
  master: ChildProcess;
  worker: WorkerClient;
  cleanup: CleanupStatus;
  closing?: Promise<void>;
};

type PendingConnection = {
  promise: Promise<Connection>;
  controller: AbortController;
  waiters: number;
  done: boolean;
};

/** Quote the fixed Python bootstrap for the remote POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Keep ready connections without idle expiry until explicit close, transport loss, or MCP shutdown. */
export class SshTransport {
  private connections = new Map<string, Connection>();
  private reusable = new Map<string, Connection>();
  private pending = new Map<string, PendingConnection>();
  private readonly sftpChecks = new Map<string, Promise<void>>();
  private readonly ids = new ShortIds();
  private directory = mkdtemp("/tmp/neverssh-");
  private lifetime = new AbortController();
  private closed = false;

  constructor(readonly config: Config) {}

  /** Retain lost/closed handles for explicit cleanup and previously collected job output. */
  get(id: string): Connection {
    const connection = this.connections.get(id);
    if (!connection) {
      throw new ToolError("CONNECTION_NOT_FOUND", "Connection does not exist in this MCP instance", { connection_id: id });
    }
    return connection;
  }

  /** Require an existing ready handle; an operation never reconnects implicitly. */
  private ready(id: string): Connection {
    const connection = this.get(id);
    if (this.closed) {
      throw new ToolError("CONNECTION_LOST", "SSH transport is shutting down", { connection_id: id });
    }
    if (connection.state !== "ready") {
      throw new ToolError("CONNECTION_LOST", `Connection is ${connection.state}; call ssh_connect to obtain a ready handle`, { connection_id: id });
    }
    return connection;
  }

  /** Give each caller its own total deadline, including configuration resolution and shared startup. */
  async connect(target: SshTarget, timeoutSeconds = 60, signal?: AbortSignal): Promise<RemoteResult> {
    connectionContracts.ssh_connect.input.parse({ ...target, timeout_seconds: timeoutSeconds });
    const timeout = timeoutSeconds * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new ToolError("CONNECT_TIMEOUT", "Connection preparation exceeded timeout_seconds"));
    }, timeout);
    const combined = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);

    try {
      return await this.connectTarget(target, timeout, combined);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Authorize the effective destination before reusing or starting its connection. */
  private async connectTarget(target: SshTarget, timeout: number, signal: AbortSignal): Promise<RemoteResult> {
    const started = Date.now();
    if (this.closed) throw new ToolError("CONNECTION_LOST", "SSH transport is closed");
    checkAbort(signal);

    const resolved = await resolveTarget(this.config, target, signal);
    if (!targetAllowed(this.config, target, resolved.endpoint)) {
      throw new ToolError("TARGET_DENIED", "Target is outside the configured SSH access policy", { host: target.host });
    }
    const existing = this.reusable.get(resolved.key);
    if (existing?.state === "ready") return { connection_id: existing.id };

    const pending = this.sharedStartup(target, resolved.endpoint, resolved.key);
    pending.waiters++;
    try {
      const remaining = Math.max(1, timeout - (Date.now() - started));
      const connection = await bounded(pending.promise, remaining, "CONNECT_TIMEOUT", "Connection preparation exceeded timeout_seconds", signal);
      return { connection_id: connection.id };
    } finally {
      pending.waiters--;
      if (!pending.waiters && !pending.done) pending.controller.abort();
    }
  }

  /** Keep one startup per effective SSH configuration until it settles or its final waiter leaves. */
  private sharedStartup(target: SshTarget, endpoint: Endpoint, key: string): PendingConnection {
    const existing = this.pending.get(key);
    if (existing) return existing;

    const controller = new AbortController();
    const pending: PendingConnection = {
      promise: this.create(target, endpoint, key, controller.signal),
      controller,
      waiters: 0,
      done: false,
    };
    this.pending.set(key, pending);
    void pending.promise.finally(() => {
      pending.done = true;
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }).catch(() => {});
    return pending;
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
  private async create(target: SshTarget, endpoint: Endpoint, key: string, signal: AbortSignal, attempt = 0): Promise<Connection> {
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
      master = await this.startMaster(target, socket, signal);
      const child = spawn("ssh", [
        ...sshOptions(this.config, target, socket, false),
        target.host,
        `exec python3 -I -B -u -c ${shellQuote(WORKER_BOOTSTRAP)}`,
      ], { stdio: ["pipe", "pipe", "pipe"], env: sshEnvironment() });

      worker = new WorkerClient(child, id, (diagnostic) => this.lost(connection, diagnostic));
      const connection: Connection = {
        id, key, target, endpoint, socket, master, worker,
        state: "ready",
        cleanup: "unconfirmed",
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
        return this.create(target, endpoint, key, signal, attempt + 1);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** Wait for the private control socket, retaining bounded native SSH diagnostics on failure. */
  private async startMaster(target: SshTarget, socket: string, signal: AbortSignal): Promise<ChildProcess> {
    const child = spawn("ssh", [...sshOptions(this.config, target, socket, true), target.host], {
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
      throw failure ?? sshFailure(diagnostic.trim() || "SSH connection timed out", { host: target.host });
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  /** Remove a connection from reuse without displacing a newer connection with the same key. */
  private retire(connection: Connection): void {
    this.sftpChecks.delete(connection.id);
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
    return channel.collect(id, this.config.maxFileBytes, signal, timeoutMs);
  }

  /** Return the default directory captured during the worker handshake. */
  cwd(id: string): string {
    return this.get(id).worker.home;
  }

  /** Probe the SFTP subsystem once per connection so transfers fail fast and clearly. */
  async prepareSftp(id: string, signal?: AbortSignal): Promise<void> {
    const existing = this.sftpChecks.get(id);
    if (existing) return existing;
    const check = this.sftp(id, ["pwd"], signal).then(() => undefined).catch((error) => {
      this.sftpChecks.delete(id);
      if (error instanceof ToolError &&
          ["SFTP_UNAVAILABLE", "SFTP_TIMEOUT", "OPERATION_CANCELLED"].includes(error.code)) {
        throw error;
      }
      throw new ToolError("SFTP_UNAVAILABLE",
        "SFTP is unavailable on this connection; enable the remote SFTP subsystem", { connection_id: id });
    });
    this.sftpChecks.set(id, check);
    return check;
  }

  /** Run a batch of SFTP commands over the existing ControlMaster instead of the worker protocol. */
  async sftp(id: string, commands: string[], signal?: AbortSignal, timeoutMs = 120000): Promise<void> {
    const connection = this.ready(id);
    checkAbort(signal);
    const child = spawn("sftp", [
      ...sftpOptions(this.config, connection.target, connection.socket),
      "-q", "-b", "-", connection.target.host,
    ], { stdio: ["pipe", "pipe", "pipe"], env: sshEnvironment() });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.stdout!.on("data", () => {});
    child.stdin!.on("error", () => {});

    child.stdin!.end(commands.join("\n") + "\n");
    let settled = false;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => {
        child.kill("SIGTERM");
        finish(new ToolError("OPERATION_CANCELLED", "SFTP transfer cancelled"));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new ToolError("SFTP_TIMEOUT", "SFTP transfer exceeded its time limit"));
      }, timeoutMs);
      child.once("error", (error) => finish(new ToolError("SFTP_UNAVAILABLE", error.message)));
      child.once("close", (code) => finish(code === 0
        ? undefined
        : new ToolError("SFTP_FAILED", stderr.trim() || `sftp exited with code ${code}`)));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
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
    return { connection_id: id, closed: true, remote_cleanup: connection.cleanup };
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

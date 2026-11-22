/** Native OpenSSH argument construction and configuration resolution, without a local shell. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Config, Endpoint, SshTarget } from "../config";
import { bounded, ToolError } from "../errors";

export type ResolvedTarget = {
  target: SshTarget; endpoint: Endpoint; key: string; supportedOptions: ReadonlySet<string>;
};

/** Apply the same non-interactive security and connection policy to SSH and SFTP. */
function connectionOptions(config: Config, supportedOptions?: ReadonlySet<string>): string[] {
  return [
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no", "-o", "CheckHostIP=no", "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
    "-o", "ConnectTimeout=15", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2", "-o", "LogLevel=ERROR", "-o", "RequestTTY=no", "-o", "RemoteCommand=none",
    // ssh -G lists these settings only on clients that support them. Older clients
    // already run in the foreground with stdin attached when neither -f nor -n is used.
    ...(supportedOptions?.has("forkafterauthentication") ? ["-o", "ForkAfterAuthentication=no"] : []),
    ...(supportedOptions?.has("stdinnull") ? ["-o", "StdinNull=no"] : []),
    ...(config.compression ? ["-o", "Compression=yes"] : []),
  ];
}

/** Pin transport behavior while inheriting trusted identity, proxy, and host matching configuration. */
export function sshOptions(config: Config, target: SshTarget, socket: string, master: boolean, supportedOptions?: ReadonlySet<string>): string[] {
  return [
    ...(config.sshConfig ? ["-F", config.sshConfig] : []),
    ...(target.user ? ["-l", target.user] : []), ...(target.port ? ["-p", String(target.port)] : []),
    ...(master ? ["-N"] : []), "-S", socket, "-o", `ControlMaster=${master ? "yes" : "no"}`,
    "-o", "ControlPersist=no", ...connectionOptions(config, supportedOptions),
    ...(!master && supportedOptions?.has("sessiontype") ? ["-o", "SessionType=default"] : []),
  ];
}

/** Reuse the existing ControlMaster for batch SFTP data transfer instead of the worker JSON path. */
export function sftpOptions(config: Config, target: SshTarget, socket: string, supportedOptions: ReadonlySet<string>): string[] {
  return [
    ...(config.sshConfig ? ["-F", config.sshConfig] : []),
    "-o", `ControlPath=${socket}`, "-o", "ControlMaster=no",
    ...connectionOptions(config, supportedOptions),
    ...(target.port ? ["-P", String(target.port)] : []),
    ...(target.user ? ["-o", `User=${target.user}`] : []),
  ];
}

export const sshEnvironment = () => ({ ...process.env, SSH_ASKPASS_REQUIRE: "never", LC_ALL: "C" });

/** Classify known OpenSSH diagnostics, retaining a fallback for versions with different wording. */
export function sshFailure(message: string): ToolError {
  const code = /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(message) ? "SSH_HOST_KEY_ERROR"
    : /permission denied|authentication failed/i.test(message) ? "SSH_AUTH_FAILED"
    : /timed out/i.test(message) ? "SSH_TIMEOUT" : "SSH_FAILED";
  return new ToolError(code, message || "SSH connection failed");
}

/** Ask OpenSSH to resolve a specific target, including Include/Match and command-line overrides. */
export async function resolveTarget(config: Config, target: SshTarget, signal?: AbortSignal): Promise<ResolvedTarget> {
  const child = spawn("ssh", ["-G", ...sshOptions(config, target, "none", true), target.host], {
    stdio: ["ignore", "pipe", "pipe"], env: sshEnvironment(),
  });
  let stdout = "";
  let stderr = "";
  let failure: Error | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.length > 1024 * 1024) { failure = new ToolError("SSH_FAILED", "Resolved SSH configuration exceeds its size limit"); child.kill("SIGKILL"); }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.on("error", (error) => { failure = new ToolError("SSH_UNAVAILABLE", error.message); });
  const completion = new Promise<ResolvedTarget>((resolve, reject) => child.once("close", (code) => {
    if (failure) return reject(failure);
    if (code !== 0) return reject(sshFailure(stderr.trim()));
    // Hash the full effective configuration for reuse, but retain only the settings we consume.
    let host: string | undefined;
    let user: string | undefined;
    let port = 0;
    const supportedOptions = new Set<string>();
    for (const match of stdout.matchAll(/^(hostname|user|port|sessiontype|forkafterauthentication|stdinnull) (.*)$/gm)) {
      const name = match[1]!;
      if (name === "hostname") host = match[2];
      else if (name === "user") user = match[2];
      else if (name === "port") port = Number(match[2]);
      else supportedOptions.add(name);
    }
    if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535) return reject(new ToolError("SSH_FAILED", "OpenSSH returned an invalid destination"));
    resolve({ target, endpoint: { host, user, port }, key: createHash("sha256").update(stdout).digest("hex"), supportedOptions });
  }));
  try { return await bounded(completion, 10000, "SSH_TIMEOUT", "SSH configuration resolution timed out", signal); }
  finally { if (child.exitCode === null) child.kill("SIGKILL"); }
}

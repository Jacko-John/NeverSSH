/** An authenticated loopback SSH server, exercised by the real system OpenSSH client. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, open, readFile, readdir, rename, rmdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server as TcpServer, type Socket } from "node:net";
import { Server, utils, type Connection, type SFTPWrapper } from "ssh2";
import type { Config } from "../src/config";

/** Run fixture setup commands through Bun without touching the user's SSH configuration. */
async function command(argv: string[]): Promise<void> {
  const result = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(result.stderr).text();
  if (await result.exited !== 0) throw new Error(`${argv[0]}: ${error}`);
}

/** A test-only remote filesystem and SSH endpoint; all generated keys and files are temporary. */
export class SshFixture {
  root = "";
  workspace = "";
  transfers = "";
  configPath = "";
  config!: Config;
  authentications = 0;
  workerStarts = 0;
  port = 0;
  connections = new Set<Connection>();
  commands = new Set<ChildProcessWithoutNullStreams>();
  private server?: Server;
  private listener?: TcpServer;
  private sockets = new Set<Socket>();

  /** Create keys, a pinned known_hosts file, interpreter wrappers, and a real TCP SSH listener. */
  async start(): Promise<void> {
    this.root = await realpath(await mkdtemp("/tmp/neverssh-test-"));
    this.workspace = join(this.root, "remote");
    this.transfers = join(this.root, "transfers");
    const bin = join(this.root, "bin");
    const noBashBin = join(this.root, "no-bash-bin");
    for (const directory of [this.workspace, this.transfers, bin, noBashBin]) await mkdir(directory);
    const hostKey = join(this.root, "host");
    const userKey = join(this.root, "identity");
    await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", userKey]);
    const publicKey = utils.parseKey(await readFile(`${userKey}.pub`));
    if (publicKey instanceof Error || Array.isArray(publicKey)) throw new Error("Could not parse test key");
    const uv = Bun.which("uv");
    if (!uv) throw new Error("Integration tests require uv for the Python fixture");
    const python = Bun.which("python3");
    if (!python) throw new Error("Integration tests require an existing Python 3 interpreter");
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    for (const directory of [bin, noBashBin]) {
      const wrapper = join(directory, "python3");
      const path = directory === noBashBin ? directory : `${directory}:/usr/bin:/bin`;
      await writeFile(wrapper, `#!/bin/sh\nexport PATH=${quote(path)}\nexec ${quote(uv)} --quiet run --no-config --python ${quote(python)} python "$@"\n`);
      await chmod(wrapper, 0o700);
    }
    const rg = Bun.which("rg");
    if (rg) await symlink(rg, join(bin, "rg"));
    this.server = new Server({ hostKeys: [await readFile(hostKey)] }, (connection) => {
      let username = "";
      this.connections.add(connection);
      connection.on("error", () => {});
      connection.once("close", () => this.connections.delete(connection));
      connection.on("authentication", (context) => {
        if (context.method === "publickey" && context.key.data.equals(publicKey.getPublicSSH()) &&
            (!context.signature || publicKey.verify(context.blob!, context.signature, context.hashAlgo) === true)) {
          username = context.username;
          context.accept();
        } else context.reject();
      });
      connection.on("ready", () => {
        this.authentications++;
        connection.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptCommand, _reject, info) => {
            const channel = acceptCommand();
            this.workerStarts++;
            const remoteCommand = username === "missing-python" ? info.command.replace("exec python3 ", "exec /no-such-python ")
              : username === "slow" ? `sleep 2; ${info.command}` : info.command;
            const child = spawn("/bin/sh", ["-c", remoteCommand], {
              cwd: this.workspace, env: { ...process.env, HOME: this.workspace,
                PATH: username === "missing-bash" ? noBashBin : `${bin}:/usr/bin:/bin` },
              stdio: ["pipe", "pipe", "pipe"],
            });
            this.commands.add(child);
            child.stdin.on("error", () => {});
            channel.on("error", () => {});
            channel.pipe(child.stdin);
            child.stdout.pipe(channel, { end: false });
            child.stderr.pipe(channel.stderr, { end: false });
            channel.once("close", () => { child.stdin.end(); });
            child.once("close", (code) => {
              this.commands.delete(child);
              channel.exit(code ?? 255);
              channel.end();
            });
          });
          session.on("sftp", (acceptSftp) => this.serveSftp(acceptSftp()));
        });
      });
    });
    this.listener = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      this.server!.injectSocket(socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.listener!.once("error", reject);
      this.listener!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.listener.address();
    if (typeof address === "string" || !address) throw new Error("Missing test SSH port");
    this.port = address.port;
    const knownHosts = join(this.root, "known_hosts");
    await writeFile(knownHosts, `[127.0.0.1]:${address.port} ${(await readFile(`${hostKey}.pub`, "utf8")).trim()}\n`);
    const sshConfig = join(this.root, "ssh_config");
    await writeFile(join(this.root, "empty_known_hosts"), "");
    await writeFile(sshConfig, `Host untrusted\n  UserKnownHostsFile ${join(this.root, "empty_known_hosts")}\nHost missing-python\n  User missing-python\nHost slow slow-cancel\n  User slow\nHost fixture untrusted missing-python slow slow-cancel\n  HostName 127.0.0.1\n  Port ${address.port}\n  User fixture\nHost *\n  IdentityFile ${userKey}\n  IdentitiesOnly yes\n  GlobalKnownHostsFile /dev/null\n  UserKnownHostsFile ${knownHosts}\n`);
    this.config = {
      version: 1, sshConfig, compression: false, maxFileBytes: 4 * 1024 * 1024,
      maxTaskOutputBytes: 64 * 1024 * 1024, maxArchiveBytes: 1024 * 1024 * 1024,
      localTransferRoots: [this.transfers],
      access: { deny: [] },
    };
    this.configPath = join(this.root, "config.json");
    await writeFile(this.configPath, JSON.stringify(this.config));
  }

  /** Minimal in-process SFTP server for the integration fixture's filesystem. */
  private serveSftp(sftp: SFTPWrapper): void {
    const { OK, EOF, NO_SUCH_FILE, PERMISSION_DENIED, FAILURE, OP_UNSUPPORTED } = utils.sftp.STATUS_CODE;
    const openFiles = new Map<number, FileHandle>();
    const directories = new Map<number, { path: string; entries: string[]; sent: boolean }>();
    let nextHandle = 1;
    const local = (name: string) => {
      const value = name === "~" ? this.workspace : name.startsWith("~/") ? join(this.workspace, name.slice(2)) : name;
      return isAbsolute(value) ? resolve(value) : resolve(this.workspace, value);
    };
    const failure = (reqid: number, error: NodeJS.ErrnoException) => {
      const code = error.code === "ENOENT" ? NO_SUCH_FILE : error.code === "EACCES" || error.code === "EPERM" ? PERMISSION_DENIED : FAILURE;
      sftp.status(reqid, code, error.message);
    };
    const run = (reqid: number, action: () => Promise<void>) => {
      void action().catch((error: NodeJS.ErrnoException) => failure(reqid, error));
    };
    const attrs = (info: { mode: number; uid: number; gid: number; size: number; atimeMs: number; mtimeMs: number }) => ({
      mode: info.mode, uid: info.uid, gid: info.gid, size: info.size,
      atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000),
    });
    const fileFor = (handle: Buffer): FileHandle | undefined =>
      handle.length === 4 ? openFiles.get(handle.readUInt32BE(0)) : undefined;

    sftp.on("OPEN", (reqid, filename, flags) => run(reqid, async () => {
      const mode = utils.sftp.flagsToString(flags);
      if (!mode) return sftp.status(reqid, OP_UNSUPPORTED);
      const file = await open(local(filename), mode);
      const handle = Buffer.alloc(4);
      const id = nextHandle++;
      handle.writeUInt32BE(id, 0);
      openFiles.set(id, file);
      sftp.handle(reqid, handle);
    }));
    sftp.on("READ", (reqid, handle, offset, length) => run(reqid, async () => {
      const file = fileFor(handle);
      if (!file) return sftp.status(reqid, FAILURE);
      const buffer = Buffer.alloc(length);
      const result = await file.read(buffer, 0, length, offset);
      if (result.bytesRead === 0) return sftp.status(reqid, EOF);
      sftp.data(reqid, buffer.subarray(0, result.bytesRead));
    }));
    sftp.on("WRITE", (reqid, handle, offset, data) => run(reqid, async () => {
      const file = fileFor(handle);
      if (!file) return sftp.status(reqid, FAILURE);
      await file.write(data, 0, data.length, offset);
      sftp.status(reqid, OK);
    }));
    sftp.on("CLOSE", (reqid, handle) => run(reqid, async () => {
      const id = handle.length === 4 ? handle.readUInt32BE(0) : undefined;
      const file = id === undefined ? undefined : openFiles.get(id);
      if (!file) return sftp.status(reqid, FAILURE);
      openFiles.delete(id!);
      await file.close();
      sftp.status(reqid, OK);
    }));
    sftp.on("FSTAT", (reqid, handle) => run(reqid, async () => {
      const file = fileFor(handle);
      if (!file) return sftp.status(reqid, FAILURE);
      sftp.attrs(reqid, attrs(await file.stat()));
    }));
    sftp.on("STAT", (reqid, filename) => run(reqid, async () => {
      sftp.attrs(reqid, attrs(await stat(local(filename))));
    }));
    sftp.on("LSTAT", (reqid, filename) => run(reqid, async () => {
      sftp.attrs(reqid, attrs(await lstat(local(filename))));
    }));
    sftp.on("REALPATH", (reqid, filename) => {
      const resolved = local(filename);
      sftp.name(reqid, [{ filename: resolved, longname: resolved,
        attrs: { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }]);
    });
    sftp.on("RENAME", (reqid, oldPath, newPath) => run(reqid, async () => {
      await rename(local(oldPath), local(newPath));
      sftp.status(reqid, OK);
    }));
    sftp.on("REMOVE", (reqid, filename) => run(reqid, async () => {
      await unlink(local(filename));
      sftp.status(reqid, OK);
    }));
    sftp.on("MKDIR", (reqid, filename, attributes) => run(reqid, async () => {
      await mkdir(local(filename), Number(attributes?.mode ?? 0o755));
      sftp.status(reqid, OK);
    }));
    sftp.on("RMDIR", (reqid, filename) => run(reqid, async () => {
      await rmdir(local(filename));
      sftp.status(reqid, OK);
    }));
    sftp.on("SETSTAT", (reqid) => sftp.status(reqid, OK));
    sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, OK));
    sftp.on("EXTENDED", (reqid, name, data) => run(reqid, async () => {
      const string = (offset: number): [string, number] => {
        const length = data.readUInt32BE(offset);
        return [data.toString("utf8", offset + 4, offset + 4 + length), offset + 4 + length];
      };
      if (name === "posix-rename@openssh.com") {
        const [oldPath, afterOld] = string(0);
        const [newPath] = string(afterOld);
        await rename(local(oldPath), local(newPath));
        return sftp.status(reqid, OK);
      }
      if (name === "fsync@openssh.com") return sftp.status(reqid, OK);
      return sftp.status(reqid, OP_UNSUPPORTED);
    }));
    sftp.on("OPENDIR", (reqid, filename) => run(reqid, async () => {
      const path = local(filename);
      const names = await readdir(path);
      const handle = Buffer.alloc(4);
      const id = nextHandle++;
      handle.writeUInt32BE(id, 0);
      directories.set(id, { path, entries: names, sent: false });
      sftp.handle(reqid, handle);
    }));
    sftp.on("READDIR", (reqid, handle) => run(reqid, async () => {
      const id = handle.length === 4 ? handle.readUInt32BE(0) : undefined;
      const directory = id === undefined ? undefined : directories.get(id);
      if (!directory) return sftp.status(reqid, FAILURE);
      if (directory.sent) return sftp.status(reqid, EOF);
      directory.sent = true;
      sftp.name(reqid, directory.entries.map((name) => ({
        filename: name, longname: name,
        attrs: { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 },
      })));
    }));
    sftp.on("CLOSEDIR", (reqid: number, handle: Buffer) => {
      const id = handle.length === 4 ? handle.readUInt32BE(0) : undefined;
      if (id !== undefined) directories.delete(id);
      sftp.status(reqid, OK);
    });
    for (const event of ["READLINK", "SYMLINK"] as const) {
      sftp.on(event, (reqid: number) => sftp.status(reqid, OP_UNSUPPORTED));
    }
    sftp.on("end", () => {
      for (const file of openFiles.values()) void file.close();
      openFiles.clear();
      directories.clear();
      sftp.end();
    });
    sftp.on("close", () => {
      for (const file of openFiles.values()) void file.close();
      openFiles.clear();
      directories.clear();
    });
  }

  /** Simulate a network failure without asking the client or helper to disconnect cleanly. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  /** Reap only processes and files created by this fixture. */
  async close(): Promise<void> {
    this.dropConnections();
    for (const child of this.commands) { child.stdin.end(); child.kill("SIGTERM"); }
    if (this.listener) await new Promise<void>((resolve) => this.listener!.close(() => resolve()));
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}

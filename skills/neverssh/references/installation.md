# Installing and configuring NeverSSH

Read this when the `ssh_*` tools are missing, the server fails to start, or the user wants NeverSSH set up on a new machine.

## Prerequisites

Local machine: macOS or Linux, Bun 1.3+, and an OpenSSH client with `ssh` and `sftp`. The release launcher also needs `curl`.

Remote host: Linux, Python 3.8+, Bash, and a writable home directory. SFTP transfers also require the remote SFTP subsystem. If it is disabled, `ssh_upload` and `ssh_download` fail; there is no alternative transport.

Authentication must already work non-interactively, and the host key must already be verified and recorded. NeverSSH runs SSH with `BatchMode=yes` and `StrictHostKeyChecking=yes`; it does not accept passwords or keys through tool arguments.

Check the local side:

```sh
bun --version
ssh -V
ssh -o BatchMode=yes <host> true
```

If the last command prompts or fails, fix SSH authentication before configuring the MCP server.

## Install the release launcher

```sh
mkdir -p ~/.local/bin
curl -fsSL https://github.com/Jacko-John/NeverSSH/releases/latest/download/neverssh -o ~/.local/bin/neverssh
chmod +x ~/.local/bin/neverssh
```

The launcher resolves the latest GitHub release, caches `neverssh.js` under `${XDG_CACHE_HOME:-$HOME/.cache}/neverssh/<tag>/`, and runs it with Bun. The first start needs network access. Later starts reuse the cache; if release resolution fails, the launcher falls back to the most recently cached tag.

## Register the MCP server

### Claude Code

```sh
claude mcp add neverssh --scope user -- "$HOME/.local/bin/neverssh"
```

`--scope user` makes the server available in all projects. Use `--scope project` for a repository, or `local` for the current project only.

With a custom configuration file:

```sh
claude mcp add neverssh --scope user -- "$HOME/.local/bin/neverssh" --config /absolute/path/neverssh.config.json
```

Verify and restart the session so the tools load:

```sh
claude mcp list
```

Register an absolute path. MCP clients spawn the command directly, without a shell, so `~` is not expanded. A configuration that says `~/.local/bin/neverssh` fails with `ENOENT` even though the file exists.

### JSON configuration for other clients

```json
{
  "mcpServers": {
    "neverssh": {
      "command": "/Users/you/.local/bin/neverssh",
      "args": ["--config", "/absolute/path/neverssh.config.json"]
    }
  }
}
```

Omit `args` when using the default configuration. Use the absolute path in `command`.

GUI clients do not inherit a terminal environment. Make sure the client can find `ssh`, `bun`, and the user's SSH agent through `SSH_AUTH_SOCK`. If Bun is not on the GUI `PATH`, use the source form below with an absolute Bun path.

### From a source checkout

```sh
git clone https://github.com/Jacko-John/NeverSSH.git
cd NeverSSH
bun install --frozen-lockfile
```

```json
{
  "mcpServers": {
    "neverssh": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/NeverSSH/src/index.ts"]
    }
  }
}
```

Add `--config` and the configuration file path to `args` when needed. Restart the client after any configuration change.

## Verify the server

1. In Claude Code, `claude mcp list` reports `neverssh` as connected. A call to `ssh_sessions({})` returns an empty list or the existing connections; either proves the server started.
2. `ssh_discover({})` lists aliases from local SSH configuration that the access policy allows. An empty list is valid, and candidates do not prove reachability.
3. `ssh_connect({host:"<alias>"})` returns an eight-character `connection_id`.
4. A trivial `ssh_bash` command such as `printf 'ready\n'` returns `ready`.

The first connection is slower: the worker source is installed under the remote `~/.neverssh/builds/<buildId>/`. Later connections reuse that build.

## Optional local configuration

The server reads `./neverssh.config.json` by default. `--config <path>` or `NEVERSSH_CONFIG` selects another file; an explicitly selected file must exist.

```json
{
  "version": 1,
  "access": { "deny": [] },
  "localTransferRoots": [],
  "compression": true,
  "maxFileBytes": 4194304,
  "maxTaskOutputBytes": 67108864,
  "maxArchiveBytes": 1073741824
}
```

- `access.allow` and `access.deny`: each rule requires `host` and may include `user` and `port`. Fields within one rule must all match. `deny` wins. Omitting `allow` opens all targets; an empty array closes everything. `host` matching is case-insensitive and `user` matching is case-sensitive; both accept `*` and `?`. Rules match names, not DNS equivalence.
- `localTransferRoots`: empty disables uploads and downloads. Each entry must be an existing dedicated directory; local paths must stay inside it, including through symlinks.
- `compression` defaults to `true` and covers worker and SFTP traffic.
- `maxFileBytes` defaults to 4 MiB with a maximum of 8 MiB. `maxTaskOutputBytes` defaults to 64 MiB and `maxArchiveBytes` to 1 GiB.

Restart the MCP server or session after changing configuration.

## Diagnose without an agent

```sh
~/.local/bin/neverssh doctor
~/.local/bin/neverssh doctor <host>
```

Without a host, the command lists candidates. With a host, it opens a temporary connection and reports the remote Python version, platform, Bash path, and home filesystem type, then cleans up. It uses the same access rules and SSH configuration as the MCP server, which makes it useful for separating local configuration problems from remote environment problems.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `ENOENT ... '~/.local/bin/neverssh'` | Literal `~` in the MCP configuration | Use the absolute path |
| `bun: command not found` at server start | GUI client `PATH` lacks Bun | Add Bun to the client environment, or use the source form with an absolute Bun path |
| `SSH_AUTH_FAILED` | Non-interactive authentication fails, or the client has no agent | Test `ssh -o BatchMode=yes <host> true`; fix keys or agent; expose `SSH_AUTH_SOCK` to the client |
| `SSH_HOST_KEY_ERROR` | Host key is missing or changed | Verify the host out of band and record the correct key locally; NeverSSH does not accept relaxed checking |
| `SSH_UNAVAILABLE` | OpenSSH client is missing | Install `ssh` and `sftp`, and make them visible to the client |
| `TARGET_DENIED` | Access rules | Adjust `access.allow` / `access.deny`, or connect to an allowed entry |
| `RUNTIME_UNSUPPORTED` | Remote Python is older than 3.8 or missing | Install Python 3.8+ on the remote |
| `BUILD_UNAVAILABLE` | Remote home is not writable, or the build cache cannot be installed | Check home permissions and `~/.neverssh/builds` |
| `BUILD_MISMATCH` | Local and remote worker builds differ | Reconnect; if it persists, inspect the affected remote build cache |
| `SFTP_UNAVAILABLE` | SFTP subsystem is disabled | Enable the subsystem, or proceed without transfers |
| `CONNECT_TIMEOUT` | Slow network or SSH setup | Raise `timeout_seconds` on `ssh_connect` (1-180) |
| `CONNECTION_BUSY` | 64 connections are registered | Close unused connections |

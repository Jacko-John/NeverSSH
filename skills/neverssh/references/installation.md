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

The launcher runs the cached `neverssh.js` from `${XDG_CACHE_HOME:-$HOME/.cache}/neverssh/<tag>/` with Bun, and refreshes that cache from the latest GitHub release in the background, so a new tag takes effect on the next start. Only the first start, with an empty cache, waits for the network; a failed refresh leaves the cache as it is.

## Register the MCP server

Set a two-hour tool-call timeout for NeverSSH. When the client exposes a separate idle timeout, allow two hours there too. This gives `ssh_task_output` with `wait_seconds: -1` time to return the final result of a long-running task.

### Claude Code

Substitute the launcher's absolute path in the registration command. The `timeout` field takes milliseconds. For an existing registration, set `"timeout": 7200000` in the server's existing configuration entry. [Claude Code tool-call time limits](https://code.claude.com/docs/en/mcp#time-limits-on-mcp-tool-calls)

```sh
claude mcp add-json neverssh \
  '{"type":"stdio","command":"/absolute/path/to/neverssh","timeout":7200000}' \
  --scope user
```

`--scope user` makes the server available in all projects. Use `--scope project` for a repository, or `--scope local` for the current project only. For a custom NeverSSH configuration, add `"args": ["--config", "/absolute/path/neverssh.config.json"]` to the same JSON object.

To keep long tool calls in the current interactive turn, start the client with automatic backgrounding disabled for that session. [Claude Code backgrounding settings](https://code.claude.com/docs/en/mcp#automatic-backgrounding-of-long-tool-calls)

```sh
CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 claude
```

### Codex

Add the server to `~/.codex/config.toml`, or update its existing table. Codex measures `tool_timeout_sec` in seconds. [Codex MCP configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

```toml
[mcp_servers.neverssh]
command = "/absolute/path/to/neverssh"
tool_timeout_sec = 7200
```

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

Omit `args` when using the default configuration. Use an absolute path in `command` because MCP clients spawn the executable directly. Set the client's tool-call and idle timeouts to two hours using its own settings and units.

GUI clients do not inherit a terminal environment. Make sure the client can find `ssh`, `bun`, and the user's SSH agent through `SSH_AUTH_SOCK`. If Bun is not on the GUI `PATH`, use the source form below with an absolute Bun path.

### From a source checkout

```sh
git clone https://github.com/Jacko-John/NeverSSH.git
cd NeverSSH
bun install --frozen-lockfile
```

For Claude Code, register the source checkout with this configuration.

```json
{
  "mcpServers": {
    "neverssh": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/NeverSSH/src/index.ts"],
      "timeout": 7200000
    }
  }
}
```

Add `--config` and the configuration file path to `args` when needed. For other clients, use the same command and arguments with the two-hour timeout in that client's settings. Restart the client after any configuration change.

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
- `localTransferRoots`: omitted or `[]` leaves local directories unrestricted. Uploads and downloads use each call's absolute `localPath` on the machine running MCP, independently of the remote workspace and `cwd`. A nonempty list restricts canonical local paths to those directories, including through symlinks. Each entry must be an existing directory; relative entries resolve from the configuration file's directory. File type, size, overwrite, atomic commit, and cancellation checks apply in both modes.
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

# Changelog

## 0.2.1

### Fixes

- Tool input schemas no longer publish the JSON Schema `pattern` keyword. Some model providers reject it with HTTP 400 as soon as the tools are attached. Shape checks now use Zod refines, so server-side validation is unchanged.
- Added a regression test that no published tool schema contains `pattern`.

## 0.2.0

### Breaking changes

- Tool surface aligned with Claude Code's default file/shell toolset: `ssh_read_file`, `ssh_write_file`, `ssh_edit_file` use `file_path`, `offset`/`limit`, and `old_string`/`new_string`/`replace_all`.
- Removed `ssh_list_directory`, `ssh_stat`, and `ssh_search`; use `ssh_bash` with `ls`, `find`, and `rg`.
- Task tools use `task_id` alone. Added `ssh_task_list`, which lists tasks with output not yet read by `ssh_task_output`.
- Text writes require a prior read/write revision; `ssh_write_file` no longer has `overwrite`.

### Remote runtime

- File read/write/edit run inside the persistent worker; only Bash uses a command helper.
- Versioned, content-addressed remote build cache at `~/.neverssh/builds/<buildId>/`, with shared leases, A/B coexistence, rollback, and cleanup.
- Added build ID, protocol, server version, Python version, and archive format to the worker handshake.
- Python version is checked before any worker source is loaded.
- Archive metadata carries `format: 1`; unknown/newer formats are never deleted by older builds.
- Worker and Bash helper launch with `python3 -I -B -u`.
- Linux parent-death signals for command helpers and Bash children; atomic writes fsync the parent directory.

### Transfers and compression

- `ssh_upload` / `ssh_download` use SFTP over the existing ControlMaster, with temporary files, atomic commit, and SHA-256 verification.
- SFTP availability is probed once per connection; missing SFTP fails with `SFTP_UNAVAILABLE` and no fallback.
- SSH compression is enabled by default (`compression: true`) for worker and SFTP traffic.

## 0.1.0

- Initial connection, Bash/background task, file, search, and transfer tools.

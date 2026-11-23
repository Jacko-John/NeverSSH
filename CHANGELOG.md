# Changelog

## 0.9.0

- Use `ssh_task_output` with `wait_seconds: -1` to wait for a remote task to finish in one query. Cancelling the query leaves the command running, and the same task ID can be queried again.
- Installation examples set a two-hour tool-call timeout for NeverSSH. Update an existing MCP registration to allow the same window for long waits.

## 0.8.0

- Workspace open, Bash guidance, and paused file calls return one confirmation code per rule version. File calls accept a single code or an array and confirm only the rules that apply to their target. Codes for unchanged rules can be reused across files even after heavy activity in other directories.
- Refreshing a workspace preserves confirmations. Use `reread_rules: true` after losing conversation context. Late Bash results omit superseded guidance. Line-ending conversions and blank instruction files no longer trigger a new rule review.
- A finished foreground command counts as read when `ssh_bash` returns its full result, including a nonzero exit. Clients can still use a returned task ID to query the retained result with `ssh_task_output`.
- When a host has no Bash, `ssh_bash` reports `BASH_UNAVAILABLE` and the connection can still confirm cleanup on close.
- Fixed connections from OpenSSH 8.4 clients. SSH and SFTP now use the session options supported by the local client. SFTP transfers also work with host configurations that force a terminal or disable standard input.
- Reconnecting to a verified worker build skips the source upload. Repeated operations under the same workspace rules reuse their text after the remote checks the current contents. Uploads prepare the destination in one worker request and recheck conflicts at commit.
- File operations wake the worker as soon as their results are ready. Repeated workspace reads can check confirmed rules and read the file in one request.
- Large Bash commands keep their full output in the remote log and send a bounded tail on demand and at completion. Image reads carry existing Base64 data in text frames to avoid encoding it twice.
- A foreground Bash wait returns at its deadline with the output already received. Use `ssh_task_output` to fetch a running command's latest tail.
- Reading a directory as a file releases its descriptor on error. A failed worker source check leaves no newly installed build in the cache.

## 0.7.0

- Workspace reads, writes, edits, uploads, and downloads require explicit rule confirmation. After reviewing `WORKSPACE_RULES_CHANGED`, retry the same call with its `workspace_rules_ack`. Losing the review response leaves the operation paused. Opening a workspace or running Bash can display rules without confirming them for file access.
- Single-file Bash views that return zero bytes on stdout leave the file unread. A search qualifies when its delivered preview shows file text, even if truncated. To record an empty file before overwriting it, use `ssh_read_file`.
- Text reads fail when the selected range exceeds 256 KiB. Choose a smaller `limit` or search with `rg`. An over-budget range through the end of the file gets the whole-file paging hint at any offset.
- On NFS-backed home directories, NeverSSH can now remove unused builds and expired command archives and reinstall a damaged build without failing with “Directory not empty.”

## 0.6.0

### Breaking changes

- Removed PDF rendering and the `pages` parameter from `ssh_read_file`. For PDF text, use an available remote reader through `ssh_bash`.

## 0.5.0

### Upgrade notes

- Read text files over 256 KiB in pages using `offset` and `limit`. Editing or overwriting an existing file requires a complete read of the current revision, a qualifying single-file Bash view, or a prior write.
- Workspace writes, edits, and uploads pause when applicable `AGENTS.md` rules have changed. Review the returned guidance and retry the operation.
- Read clients should display ordered text and image blocks for notebooks and PDFs. PDF rendering requires `pdfinfo` and `pdftoppm` on the remote host.

### Changes

- Display Jupyter cells and saved outputs. Render PDFs up to 10 pages in full or select up to 20 pages per request with `pages`. Reads identify known binary formats and suggest a format-specific reader.
- Show nearby numbered lines after an exact edit. Identical replacements leave the file and its recorded revision untouched. Re-reading externally modified content reports the change.
- Display non-UTF-8 text and allow clean UTF-8 overwrites. Exact edits require UTF-8. Overwrites of non-UTF-8 text reject U+FFFD replacement characters.
- Allow foreground Bash waits up to 600 seconds. Set the MCP client's tool-call timeout to at least 660 seconds to use the full wait. Standalone searches, comparisons, and predicates can return exit code 1 as an ordinary result.
- Show up to 50 Git status entries when opening a workspace, with the omitted count and a command for the full listing.

## 0.4.0

### Breaking changes

- Omitted or empty `localTransferRoots` now allows absolute local transfer paths; `[]` no longer disables transfers. Nonempty lists retain canonical directory restrictions.
- `ssh_read_file` may return native MCP image content. Consumers must accept image blocks as well as text; other tools remain text-only, without `structuredContent` or `outputSchema`.

### Changed

- Make direct remote reads, writes, edits, and code generation the default development workflow. Reserve transfers for concrete needs instead of local temporary files or download-edit-upload round trips.

### Added

- Inspect remote PNG, JPEG, GIF, and WebP files directly with `ssh_read_file`, without SFTP or local downloads. Images retain file and response size checks, with changed workspace rules appended as text. Text pagination remains unchanged.

## 0.3.1

### Breaking changes

- Return readable text from every MCP tool without `structuredContent` or `outputSchema`. Connection, file, and transfer results no longer include a structured copy. Inputs and existing text formats are unchanged; clients that read structured results must read text content instead.

### Maintenance

- Isolate Git inspection tests from machine-wide Git configuration.
- Organize local code by MCP, SSH, task, file, and workspace responsibilities, with runtime ownership separate from MCP registration and remote bundle metadata beside its sources. Consolidate registration and all 15 input contracts, including configuration-dependent file limits.

### Features

- Open remote project workspaces and load scoped `AGENTS.md`, project entry files, Git status, and skill catalogs through text-only MCP tools. Discover skills only from the configured roots, defaulting to the workspace root's `.agents/skills` and `.claude/skills`; target paths do not enable subdirectory skill discovery. Read skill bodies and referenced text resources on demand by their catalogued names, using short source prefixes for collisions.
- Add workspace scope to Bash, file, and transfer tools while preserving connection mode. Return applicable rule changes with operation results without blocking execution for previously unread, added, changed, or removed rules.
- Reopen a workspace to recover root guidance, refresh Git state, and rediscover skills; opening resets rule delivery and rebuilds the skill catalog. Ordinary workspace operations return rule deltas in a separate text block after the original result, without repeating unchanged guidance, skill catalogs, or Git status. Guidance returned after an operation informs subsequent work; it does not establish that the agent understood it before execution.
- Document the remote development workflow, including reading rules and code, making edits, running checks remotely, reviewing Git changes, and recovering context after conversation compaction or reconnecting.

### Fixes

- Share file revisions between symbolic links and their canonical targets, so reading through one spelling permits a fresh edit through another.
- Execute workspace operations against their checked canonical target rather than following a changed entry symlink again.
- Discard obsolete skill reads and rule attachments after a workspace is reopened, while retaining the results of operations that have already run.
- Preserve the existing workspace state when a reopening response fails validation.
- Skip automatic Git status when configured content filters cannot be safely disabled, preserving project guidance and other opening results.
- Stop owned Git subprocesses when inspection completes, is cancelled, times out, or fails.
- Keep download staging private throughout SFTP, bound local snapshot reads, and check cancellation immediately before atomic publication. Failed downloads preserve existing destination files and clean their private staging directories.
- Pin checked upload and download targets, handle missing symlink targets consistently, reject non-regular transfer files and symlink upload staging, and recheck local upload boundaries after subsystem discovery.
- Use short upload staging filenames so valid destination names near filesystem limits remain usable.
- Isolate cancellation between shared SFTP discovery callers, wait for stopped SFTP process groups to exit, and include active transfers in connection cleanup.
- Finalize retained command archives even when process-group cleanup raises an OS error, including Darwin's zombie-group `EPERM` race. Preserve the original error and mark incomplete output instead of omitting terminal metadata.
- Report remote cleanup as unconfirmed after abnormal helper termination; explicit rejections before a command starts remain safe to retry and do not invalidate cleanup confirmation.

## 0.2.3

### Fixes

- Serialize file writes, edits, and upload commits within a worker so concurrent changes cannot silently overwrite each other. Uploads recheck conflicts at commit and atomically refuse an existing destination unless replacement was authorized.
- Resolve `~/` transfer paths against the remote home directory even when `cwd` is supplied.
- Send file responses incrementally under backpressure and account for JSON escaping in response limits, preserving connections during concurrent reads.
- Share file revisions across previously read relative and absolute path spellings.
- Start cached releases immediately and refresh them in the background. Failed or interrupted downloads preserve the last complete bundle; a refreshed release takes effect on the next start.
- Keep the shared runtime alive during MCP protocol negotiation and close it when the actual stdio connection ends, including output errors.
- Publish releases only after all assets have uploaded, with bounded retries for transient upload failures.

## 0.2.2

### Fixes

- Shortened every tool description and the MCP server instructions. Descriptions now total about 1.4 KB (from 3.8 KB) and instructions about 0.7 KB, cutting the text sent with every request. Behavior and parameters are unchanged; details live in the skill and `docs/interfaces.md`.

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

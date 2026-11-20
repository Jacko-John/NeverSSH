# Developing NeverSSH

Read this when changing NeverSSH's implementation, public tools, or development documentation. Paths below are relative to the NeverSSH repository root. Inspect the named implementation and its tests before editing; this reference describes conventions, not a second copy of every contract.

## Public interface and text output

MCP inputs remain strict parameter objects. Every tool result must be text-only: return readable `content` blocks, without `structuredContent` or `outputSchema`. Do not serialize internal objects into the text or wrap them in JSON code fences. Internal result types can still be structured.

`src/mcp/server.ts` uses `textResult(text, isError)` to package every success and failure. Connection, task, file, and transfer handlers share this presentation contract. `src/mcp/contracts.ts` defines every input contract through `createToolContracts(maxFileBytes)`; internal results and types stay separate from the public text. The server uses its active configuration; generated field tables use the default configuration.

This output rule concerns the MCP tool presentation. MCP transport, worker JSON/JSONL, configuration, archive metadata, and build manifests still use JSON. The separate `doctor` CLI also currently prints JSON. A remote command that itself prints JSON must retain its original output.

### Example 1: return the text interface

Good: the single `registerTool` helper in `src/mcp/server.ts` owns registration, annotations, and error packaging. Each handler formats its internal result and returns a `CallToolResult`; the wrapper catches operational errors:

```ts
try {
  return await execute(args, context);
} catch (error) {
  return textResult(errorText(error), true);
}
```

The task-list handler uses the pure formatter in `src/tasks/text.ts` and the same text wrapper as other tools:

```ts
registerTool("ssh_task_list", "List tasks whose output has not been read by ssh_task_output. Optional connection_id filter.",
  contracts.ssh_task_list.input, true,
  (args) => textResult(taskListText(runtime.tasks.list(args.connection_id))));
```

Incorrect:

```ts
return {
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
};
```

The incorrect version makes internal fields the reading interface and duplicates the payload. Adding `outputSchema` to the registration also conflicts with the text-only contract. Reuse `textResult` after formatting the internal value. New tools use the existing registration path and explicit annotations; do not create another wrapper for each return type.

### Example 2: show only what the next action needs

Existing formatters in `src/mcp/operation-text.ts` and `src/tasks/text.ts` produce these forms:

| Operation | Good model-visible output | Incorrect replacement |
| --- | --- | --- |
| Connect | `Connection: 7a2c9d4f` | `{"connection_id":"7a2c9d4f"}` |
| Empty task list | `No tasks.` | `{"tasks":[],"count":0}` |
| Edit | `The file /srv/app/main.ts has been updated successfully.` | A dump of path, hashes, byte counts, and internal flags |
| Partial file read | Numbered lines followed by `PARTIAL view` and the next `offset` | A silently truncated string or a JSON-escaped file body |

For example, `readText` uses a six-character line-number column and a tab before the source. A partial three-line file viewed one line at a time can read:

```text
     1	const ready = true;
PARTIAL view: showing lines 1-1 of 3. Use offset=2 to continue.
```

Good: a short successful Bash command returns its program text, preserving indentation and line endings. `tests/integration.test.ts` checks this exact result:

```text
ready
  indented

stderr:
warning
```

Incorrect: returning `{"stdout":"ready\n  indented\n","stderr":"warning\n","exit_code":0}` instead, trimming the program text, or adding a success banner and task metadata to every short command.

`src/tasks/text.ts` adds `Task:`, status, exit code, and `Log:` only when relevant to the tool and result. Background, failed, truncated, and uncertain results need enough information for follow-up. Keep previews bounded; incomplete previews must point to selective log reading. A lost connection means the remote process state is unknown, not that it exited successfully.

### Example 3: preserve strict, portable input validation

Good, following `src/mcp/contracts.ts`:

```ts
const shortId = z.string().refine(
  (value) => /^[a-f0-9]{8}$/.test(value),
  "Use the short ID returned by ssh_connect",
);
const input = z.strictObject({ connection_id: shortId });
```

Incorrect for a public MCP input:

```ts
const input = z.object({
  connection_id: z.string().regex(/^[a-f0-9]{8}$/),
  ssh_options: z.array(z.string()).optional(),
});
```

The incorrect object accepts unknown fields by stripping them, publishes the `pattern` keyword that some model providers reject, and adds an unsupported SSH-options escape hatch. Reuse `connectionId`, `cleanString`, host/user/port validators, and existing defaults instead of redefining them in handlers. Every tool belongs in `createToolContracts(maxFileBytes)`, including file and transfer inputs; do not add schemas directly in the server. The `pattern` restriction applies to published schemas; private protocol validation can use regex.

Keep the tool surface small. File operations follow Read/Write/Edit names and semantics; listing and searching use `ssh_bash` with `ls`, `find`, or `rg`. Existing public fields are mostly snake_case, with transfer fields such as `localPath` and `remotePath` retained for compatibility. Map them explicitly to internal camelCase fields rather than renaming existing parameters for uniformity.

Bash, file, and transfer inputs require exactly one of `connection_id` and `workspace_id`. Both fields are optional in the portable published object schema; the shared refinement enforces their exclusivity at validation time. Preserve that refinement on every scoped operation rather than treating either field's presence as a fallback priority. Workspace opening uses a connection handle, and skill reading uses a workspace handle; task tools retain their task/connection inputs.

### Example 4: report a failure through the shared formatter

Good, from the edit path in `src/mcp/server.ts`:

```ts
if (!revision) throw new ToolError("FILE_NOT_READ", "Read the file with ssh_read_file before editing it");
```

The text-only handler's catch branch in Example 1 uses `errorText(error)` and sets `isError: true`, producing:

```text
Error: FILE_NOT_READ
Read the file with ssh_read_file before editing it
```

Incorrect:

```ts
catch (error) {
  return { content: [{ type: "text", text: String(error) }] };
}
```

This loses the stable error code and MCP failure flag. Do not expose stacks, full SSH configuration, or raw error objects. Reuse `ToolError` and `errorText` from `src/errors.ts`; unknown exceptions normalize to `OPERATION_FAILED`. Input-schema failures occur before the handler and remain SDK validation errors.

## Code organization and style

Follow these existing responsibility boundaries:

| Module | Responsibility |
| --- | --- |
| `src/index.ts`, `src/runtime.ts` | CLI/stdio lifetime and shared application state; runtime survives temporary MCP negotiation instances |
| `src/mcp/server.ts` | Register tools through one helper, set annotations, delegate execution, package results |
| `src/mcp/contracts.ts` | All 15 public input schemas, including scope validation and active configuration limits, shared by registration, documentation, and tests |
| `src/mcp/operation-text.ts`, `src/tasks/text.ts` | Pure presentation of operation and task results |
| `src/ssh/transport.ts`, `src/ssh/openssh.ts`, `src/ssh/discovery.ts` | Connection identity/lifetime, native OpenSSH arguments, and configured SSH candidates |
| `src/ssh/worker-client.ts`, `src/ssh/request-channel.ts`, `src/ssh/json-lines.ts` | Worker handshake/multiplexing/admission, one request's I/O/cancellation, and bounded protocol framing |
| `src/tasks/manager.ts` | Bash task lifetime, status, and bounded local previews |
| `src/files/revisions.ts`, `src/remote/file_ops.py` | Local revision tracking and remote file validation/atomic commits |
| `src/files/transfers.ts` | SFTP and the allowed local-file boundary |
| `src/workspaces/manager.ts`, `src/workspaces/types.ts`, `src/workspaces/text.ts` | Workspace identities, typed project context and skill records, rule-change tracking, and pure workspace/skill presentation |
| `src/remote/bundle.ts` | Local embedding of Python sources and content-addressed build manifest; this TypeScript module is not executed remotely |
| `src/remote/worker.py`, `src/remote/helper.py`, `src/remote/archive.py`, `src/remote/build_cache.py` | Remote supervision, commands, archives, and verified build installation |
| `src/remote/workspace.py` | Canonical project paths, scoped AGENTS.md, bounded skill/resource discovery, and optional Git inspection |

For example, rendering a task belongs in `src/tasks/text.ts`; adding JSON serialization in `TaskManager` couples execution to presentation. A formatter should consume an already computed result, without reading files, opening connections, or changing task state. SSH and task execution must not import MCP contracts; connection validation also applies to direct CLI callers. Keep modules in these responsibility groups rather than adding generic `utils/` or `services/` directories.

TypeScript uses ESM, `node:` imports, two-space indentation, double quotes, and semicolons. Use camelCase for internal values, PascalCase for types/classes, UPPER_SNAKE_CASE for budget constants, and kebab-case module names. Use `import type` for type-only dependencies. Keep domain types explicit and use `unknown` at uncertain boundaries; existing wire-level `Record<string, unknown>` does not justify using untyped objects everywhere. Respect `strict`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` in `tsconfig.json`.

Python uses four-space indentation, snake_case, UPPER_SNAKE_CASE constants, and Python 3.8-compatible standard-library code. File headers explain module responsibility; function comments/docstrings explain purpose, scope, lifecycle, or failure behavior. Follow the existing English code comments. Keep helpers small, use early rejection, and separate logical steps with blank lines. Do not add a formatter, framework, dependency, or generic abstraction without a concrete need.

## State, side effects, and remote execution

### Example 5: a wait limit does not stop a command

Good: the existing `ssh_bash` registration delegates waiting and cancellation to `TaskManager`:

```ts
async (args, context) => {
  const prepared = await prepareFile(args, args.cwd ?? ".", context);
  const task = await runtime.tasks.execute(prepared.connectionId, args.command, args.workspace_id ? prepared.path : args.cwd,
    args.run_in_background ? 0 : args.wait_seconds * 1000, context.mcpReq.signal);
  const failed = task.finished && (task.reason !== undefined || task.exit_code !== 0);
  return operationResult(prepared, taskText(task, "bash"), failed);
}
```

Incorrect:

```ts
setTimeout(() => channel.cancel(), args.wait_seconds * 1000);
```

The incorrect version turns a foreground wait limit into command termination. Waiting, request cancellation, task stopping, connection loss, and confirmed process exit are different events. Reuse their existing owners rather than introducing another lifecycle in the tool handler.

Keep the following existing invariants when adding a feature:

- Handles and manager state belong to one MCP process. Shared startup has caller-specific deadlines; one cancelled waiter must not cancel other users of the same startup. Close/release paths are idempotent and clean up timers, listeners, descriptors, and temporary files.
- Connection loss or an interrupted mutation can leave the remote outcome unknown. Do not automatically reconnect and replay commands, edits, or uploads. Inspect actual state before retrying. An identifier collision known to precede command execution is a different case.
- Bound growing registries, scans, queues, buffers, and previews. Distinguish bytes from characters and allocation counts. Preserve UTF-8 across stream chunks and apply backpressure; do not hide truncated or unconfirmed output.
- Preserve file revision checks, canonical path aliases, per-path mutation locks, and atomic commit logic. A plain `writeFile` replacement or a new precheck followed by an unlocked write loses concurrency guarantees.
- Use system OpenSSH with argument arrays and the existing access policy. Do not interpolate paths into a local shell, accept model-supplied SSH flags/credentials, weaken host-key checks, or silently replace SFTP with another transport.
- Keep local and remote paths distinct. Only transfer operations access local user payload files, under canonical `localTransferRoots` checks. Remote `cwd` is not a sandbox.
- Workspace file paths stay inside the canonical project root. Ordinary file operations, transfers, and Bash return new, changed, or removed rules with their results; unread or changed guidance must not block execution. The file operation has run or the command has started when guidance is presented, so this does not guarantee prior understanding. Bash discovers rules only for `cwd`; callers can operate in the intended directory or read its `AGENTS.md` explicitly. Connection mode does not load project context. Preserve path and file revision checks.
- Opening a workspace returns complete root guidance and the skill catalog, without traversing subdirectory rules. Ordinary workspace operations load applicable rules and present their changes, updating the server-side snapshot after successful delivery. Reopen with the same connection, canonical root, and skill configuration to recover root context and rediscover skills; a handle may be reused, but rule delivery resets and the catalog is rebuilt. Subdirectory rules are delivered again by subsequent target operations. A concurrent reopen can still invalidate an operation's preparation before execution; keep that lifecycle error separate from rule discovery.
- Preserve the original operation result as the first MCP text block, including task headers and program whitespace. Put rule changes in a separate second block; omit it when unchanged. A started/background Bash delivers guidance with its first result, and nonzero program exits can still deliver rules. Thrown operation errors do not attach or acknowledge collected guidance. Rule collection and path validation still run before execution and may fail for unreadable files or resource limits; exhausted rule history requires reopening, independent of whether guidance was read.
- Keep revision hashes internal for rule-change checks; do not print them in project-rule or skill results. Keep fixed development workflow reminders in the distributed NeverSSH skill instead of appending them to every workspace response. Preserve rule sources, scopes, complete bodies, and the skill's remote resource and script locations.
- Skill discovery provides metadata; full instructions and text resources are read explicitly. Remote skill paths and scripts remain remote, with no automatic dependency installation or script execution. Workspace and skill guidance do not expand user authorization or replace client-owned local skills.
- Skill discovery roots are fixed by `ssh_workspace_open`, defaulting to `.agents/skills` and `.claude/skills` under the workspace root. Resolve all configured relative directories once from that root; explicit absolute and home-relative shared directories remain supported. Do not derive skill roots from operation target paths: subdirectory skill discovery is unsupported. Reopening discovers the catalog again. This does not change scoped `AGENTS.md` collection.
- Skill calls use the catalogued `skill_name`. Resolve collisions with short directory prefixes such as `project@check` and `shared@check`, adding short suffixes when needed and URI-encoding special characters. Build the catalog only when opening; ordinary operations must not discover or register skills. Match registered names exactly, without interpreting them as file paths. An unassigned bare name matching multiple sources fails with `SKILL_AMBIGUOUS`, and an unknown name fails with `SKILL_NOT_FOUND`. Reopening rebuilds the catalog and may assign different names; do not preserve cross-opening alias history. Catalogs list callable names and descriptions without per-item hash IDs or source/scope blocks.
- The remote worker needs Python 3.8+ and the standard library, without uv or third-party packages. New remote sources must be embedded as text in `src/remote/bundle.ts`, included in `BUILD_SOURCES`/hashes/manifest, and wired into bootstrap/dispatch; a source file existing in the checkout does not make it available in the release bundle. Remote source filenames also appear in bootstrap payloads and cache lookups, so renaming them requires checking the complete startup chain.

## Tests and documentation

### Example 6: assert what the model receives

Good: a text-only MCP integration test checks the public response, as `call` and the Bash tests in `tests/integration.test.ts` do:

```ts
const response = await client.callTool({
  name: "ssh_bash", arguments: { connection_id: dev, command: "printf 'ready\\n'" },
});
expect(response.structuredContent).toBeUndefined();
expect(Boolean(response.isError)).toBe(false);
expect(response.content.every((item) => item.type === "text")).toBe(true);
const text = response.content.map((item) => item.type === "text" ? item.text : "").join("\n");
expect(text).toBe("ready\n");
```

Also check `client.listTools()` for the absence of `outputSchema` on every tool. This catches registration mistakes that a handler-only test misses.

Insufficient:

```ts
expect(internalResult.exit_code).toBe(0);
```

That assertion cannot detect a JSON-wrapped public response, lost whitespace, a missing task handle, or an incorrect `isError` flag. Test the relevant observable behavior, including errors, partial results, side effects, and lifecycle boundaries; avoid tests that only mirror implementation details.

### Example 7: reopen a project after context loss

Good: reopen the project after conversation compaction to recover root guidance and rediscover skills:

```json
{"connection_id":"7a2c9d4f","path":"/srv/app"}
```

Use `ssh_workspace_open` for that request, preserving the original skill configuration. Reopening may reuse the handle but resets rule delivery and rebuilds the catalog. Reload active skills using its current names; applicable subdirectory rules arrive with subsequent file operations or commands in those directories. Opening alone does not recover every subdirectory's rules. If a command generates files outside its `cwd`, operate in the intended directory or read the relevant `AGENTS.md` explicitly.

Incorrect: refusing an ordinary operation solely because an applicable rule has not been returned, or treating rules included with an operation result as proof that they were understood before execution. A workspace supplies path defaults and project guidance; it is not a command sandbox or a local editor mount. `WORKSPACE_REOPEN_REQUIRED` rejects invalidated preparation, exhausted rule history, or a skill read from an obsolete catalog. Completed operations retain their result without obsolete rule attachments; unread rules do not gate execution.

Use the isolated `SshFixture` in `tests/fixture.ts`: temporary keys, known_hosts, files, a loopback SSH endpoint, real system OpenSSH, and MCP stdio. Do not use a user's live servers or modify their SSH configuration for regression tests. Python tests run through uv, following the existing Bun wrappers.

Use `bun`/`bunx` for JavaScript/TypeScript and `uv` for local Python operations. Search with `rg -uu`. For implementation changes, run the repository checks appropriate to the change:

```sh
bun run check
bun run docs:check
bun test
bun run build
git diff --check
```

After changing an input in `createToolContracts(maxFileBytes)`, use `bun run docs:sync` to regenerate all 15 parameter tables, then update the handwritten behavior and examples. The sync script uses the default configuration; runtime schemas must still honor the configured file limit. Request examples remain JSON; all result examples use `text` fences. The sync script never generates output-field tables. `tests/contracts.test.ts` checks complete contract coverage, validates requests against the registered input schemas and scope refinements, and checks text examples against formatters. Keep long usage procedures in the distributed NeverSSH skill/reference, and tool descriptions and server instructions concise.

For remote-source or packaging changes, test the built entry point with the relevant integration suite, for example `NEVERSSH_TEST_ENTRYPOINT=dist/index.js bun test tests/integration.test.ts`. Document limitations demonstrated by the tests; the loopback fixture does not certify every Linux/OpenSSH environment. For a documentation-only change, check links, examples, skill metadata, and `git diff --check`; rebuilding or rerunning unrelated integration suites adds little evidence.

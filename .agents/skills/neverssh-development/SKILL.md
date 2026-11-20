---
name: neverssh-development
description: Develop and review NeverSSH using its code conventions, text-only MCP tool results, and remote-runtime boundaries. Use when changing this repository's source, public interfaces, tests, or development documentation.
---

# NeverSSH development

Before changing this repository, read [references/development.md](references/development.md). It records the module boundaries, interface design, code style, and validation workflow, with source-backed examples and incorrect alternatives. Resolve source paths in that reference from the repository root.

## Interface requirements

- MCP inputs remain strict, schema-validated parameter objects. Reuse shared validators and defaults; published schemas must not introduce the JSON Schema `pattern` keyword.
- Define every input in `src/mcp/contracts.ts`; use `createToolContracts(maxFileBytes)` so file limits follow the active configuration. MCP registration, generated field tables, and contract tests share these definitions.
- Every tool result uses concise readable text, without JSON rendering, `structuredContent`, or `outputSchema`. Internal protocols and a remote program's original output retain their own formats.
- Keep execution, lifecycle state, and presentation in their existing modules. Follow the task text formatters for output design and the shared error formatter for failures.
- Preserve program whitespace, actionable handles, continuation hints, and explicit uncertainty. Keep the original operation result in the first text block; append workspace rule changes only as a separate second block when present. A successful short Bash command's original result needs only its program output.

## Development workflow

Inspect the nearest registered tool, formatter, contract, and public integration test before extending an interface. Preserve revision checks, atomic commits, bounded resources, cancellation semantics, and local/remote path boundaries. The reference explains these invariants and how to test them.

Keep interface adapters in `src/mcp/`, connections and request protocols in `src/ssh/`, Bash state and text in `src/tasks/`, revisions and transfers in `src/files/`, and workspace state, types, and text in `src/workspaces/`. `src/remote/` contains Python sources and the local bundle definition. `src/runtime.ts` owns shared state; `src/index.ts` owns CLI and stdio lifetime.

Bash, file, and transfer operations select exactly one of `connection_id` and `workspace_id`. Return new, changed, or removed workspace rules with operation results; unread or changed rules must not gate execution. Preserve path resolution, read-before-edit checks, file revision checks, and explicit remote skill resource loading. A workspace is project context, not a Bash sandbox or local IDE mount. Update `skills/neverssh/SKILL.md` when changing the remote development workflow.

Use `ssh_workspace_open` again for root context recovery or skill rediscovery. Reopening can reuse a handle but resets rule delivery and rebuilds the skill catalog; it returns root guidance, with subdirectory rules delivered by subsequent target operations.

Skills are selected by the catalogued `skill_name`. Use short directory prefixes and, if needed, suffixes for name collisions. Match registered names without interpreting them as paths. The catalog remains fixed until reopening, which rebuilds it and may assign different names.

Discover skills only from configured directories, resolving relative directories once from the workspace root. Defaults are the root's `.agents/skills` and `.claude/skills`. Target-path-based subdirectory skill discovery is unsupported; entering a subdirectory must not add its skills. Continue collecting applicable `AGENTS.md` along target paths.

Use local development tools for a local checkout. Use Bun/Bunx for JavaScript/TypeScript, uv for local Python operations, and `rg -uu` for searches. The shipped remote runtime stays Python 3.8-compatible and standard-library only.

Keep schemas, readable output examples, and interface documentation aligned. Run checks appropriate to the change as described in the reference, then review the diff and remove temporary artifacts.

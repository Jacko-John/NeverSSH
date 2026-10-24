---
name: neverssh-development
description: Develop and review NeverSSH using its code conventions, text-only MCP tool results, and remote-runtime boundaries. Use when changing this repository's source, public interfaces, tests, or development documentation.
---

# NeverSSH development

Before changing this repository, read [references/development.md](references/development.md). It records the module boundaries, interface design, code style, and validation workflow, with source-backed examples and incorrect alternatives. Resolve source paths in that reference from the repository root.

## Interface requirements

- MCP inputs remain strict, schema-validated parameter objects. Reuse shared validators and defaults; published schemas must not introduce the JSON Schema `pattern` keyword.
- Every tool result uses concise readable text, without JSON rendering, `structuredContent`, or `outputSchema`. Internal protocols and a remote program's original output retain their own formats.
- Keep execution, lifecycle state, and presentation in their existing modules. Follow the task text formatters for output design and the shared error formatter for failures.
- Preserve program whitespace, actionable handles, continuation hints, and explicit uncertainty. A successful short Bash command needs only its program output.

## Development workflow

Inspect the nearest registered tool, formatter, contract, and public integration test before extending an interface. Preserve revision checks, atomic commits, bounded resources, cancellation semantics, and local/remote path boundaries. The reference explains these invariants and how to test them.

Use local development tools for a local checkout. Use Bun/Bunx for JavaScript/TypeScript, uv for local Python operations, and `rg -uu` for searches. The shipped remote runtime stays Python 3.8-compatible and standard-library only.

Keep schemas, readable output examples, and interface documentation aligned. Run checks appropriate to the change as described in the reference, then review the diff and remove temporary artifacts.

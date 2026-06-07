# Architecture Decision Records

These ADRs capture the load-bearing decisions behind mikser's shape — *why* the project is built the way it is, not just *what* the code does. Read these before proposing a feature or pushing back on a constraint. Most "should we do X" questions have already been answered here, and the reasoning is often more valuable than the conclusion.

## How to read

Each ADR documents one decision. The format is intentionally short:

- **Status** — whether the decision is live (Accepted), under reconsideration (Proposed), or replaced (Superseded by ADR-XXXX)
- **Context** — the situation and pressures that made this decision necessary
- **Decision** — what we committed to
- **Consequences** — what becomes easier and harder as a result
- **Examples** — concrete places this shows up in the codebase
- **Watch for drift** — the failure mode this decision is protecting against, and the form that drift typically takes

Decisions don't expire. They get **superseded** when we learn enough to change them — but the old decision stays in the folder with its status flipped, so the reasoning is preserved.

## How to add a new one

1. Number it next in sequence (`0005-….md`).
2. Write it short — half a page is plenty. Long ADRs aren't read.
3. Note what it supersedes, if anything (and update the predecessor's Status).
4. Don't write ADRs for implementation details. Write them for decisions you expect to be re-litigated.

## Current decisions

| #   | Title                                                                        | Status   |
| --- | ---------------------------------------------------------------------------- | -------- |
| [0001](./0001-content-layer-not-the-app.md)         | Mikser is the content layer of the application, not the app                | Accepted |
| [0002](./0002-files-as-source-of-truth.md)          | Files are the source of truth for content                                  | Accepted |
| [0003](./0003-plugins-independent-engine-stable.md) | Plugins are independent packages; the engine doesn't grow                  | Accepted |
| [0004](./0004-compose-via-protocols.md) | Compose with external systems via clean protocols, not shared code         | Accepted |
| [0005](./0005-engine-infrastructure-runs-before-plugin-hooks.md) | Engine infrastructure (journal, catalog) is ready before any plugin hook runs; `runtime.update` is upsert; `useSource` codifies the folder-of-files pattern | Accepted |
| [0006](./0006-when-to-add-to-core.md) | The four-test check for adding capability to the engine vs. shipping it as a plugin | Accepted |
| [0007](./0007-references-declaration-and-expansion.md) | Entity references: `$`-prefixed declaration (canonical on disk, normalized for render/SDK) and `expand` resolution (inline, GET-cacheable, engine-level `runtime.refs` drives invalidation + live-expand) | Accepted |
| [0008](./0008-mcp-ui-action-delivery.md) | MCP-UI action delivery: `mikser_preview_ui` becomes awaitable (suspended tool call resolves when the iframe POSTs an action), default is pure-relay (agent receives `{action, entityId, payload}`), optional `handler.url` in layout frontmatter forwards the action to an external webhook | Accepted |

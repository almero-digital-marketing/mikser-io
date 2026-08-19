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
| [0006](./0006-when-to-add-to-core.md) | The five-test check for adding capability to the engine vs. shipping it as a plugin | Accepted |
| [0007](./0007-references-declaration-and-expansion.md) | Entity references: `$`-prefixed declaration (canonical on disk, normalized for render/SDK) and `expand` resolution (inline, GET-cacheable, engine-level `runtime.refs` drives invalidation + live-expand) | Accepted |
| [0008](https://github.com/almero-digital-marketing/mikser-io-mcp/blob/main/documentation/decisions/0008-mcp-ui-action-delivery.md) | MCP-UI rendering + action delivery: static shell resource at `ui://mikser/preview-ui-shell` (declared as `_meta.ui.resourceUri` on `mikser_preview_ui`) hosts the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) protocol; per-call rendered fragments delivered via `structuredContent` and `ui/notifications/tool-result`; the shell exposes `window.sendAction()` so layouts are content-only HTML. Clicks ride `tools/call` against `mikser_ui_action` (`_meta.ui.visibility = ['app']`). Action allow-list is the auth boundary. Optional `mcpUi.handler.url` forwards the action to an external webhook (HMAC-signed if `handler.secret` set); handler failures fall back to pure relay. No HTTP delivery surface. Lives in [`mikser-io-mcp`](https://github.com/almero-digital-marketing/mikser-io-mcp). | Accepted |
| [0009](./0009-database-engine-substrate.md) | Sqlite is the engine's persistence substrate. Single `runtime/mikser.sqlite` file holds catalog/refs/manifest/journal as `mikser_entities` / `mikser_refs` / `mikser_snapshots` / `mikser_journal` tables. Plugins register schemas via `registerSchema(name, sql)` + `useDatabase()`. Sift→SQL translator with indexed pushdown, LRU cache for `findById`, worker-side read-only sqlite for sync template helpers, chunked journal walks + `iterateEntities` streaming, `useJournal` auto-persist (mutate the yielded entity; no explicit `updateEntry` needed), `--resume` after interrupted cycles. Replaces `Map<id, entity>` + NDJSON across every engine subsystem. | Accepted |
| [0010](./0010-plugin-bundles-and-inline-options.md) | Plugin bundles + factory-call form + inline options. Plugins are imported by name and called as factories; `plugins: []` carries factory returns, never strings. Lifecycle plugins are `(options) => (core) => void`; renderers return `{name, options, load?, render?}`; postprocessors return `{name, options, output?, setup?, postprocess, teardown?}`. Per-plugin config moved off `runtime.config.<plugin>` — it arrives as the factory arg and is passed as `config` to `load`/`render`/`setup`/`postprocess`. | Accepted |
| [0011](./0011-served-entities-expose-deployed-urls.md) | File and resource entities expose deployed URLs. References to served files (image/video/PDF) are `$`-keyed **served paths** (`/img/X.jpg`, `/media/clip.mp4` — the path content authors, = the entity's `meta.url`), resolving through a new `refFilter` `{ 'meta.url': … }` clause backed by an indexed `meta_url` column (schema 9.0.1 → 9.0.2). No collection-prefixed ids leak into content. (Id-refs were tried and rejected — gpoint references content by served path and its `/media/**` `resources()` library means the entity only exists because content references `/media/…`.) The `files`/`resources` plugins stamp `meta.url`, the `assets` plugin stamps `meta.presets` — so expanding a ref yields the served entity's URL set instead of a string to reconstruct. Base-relative in the live catalog (host-agnostic; consumer holds `base`), absolute in static renders (baked from `runtime.options.url`, so logic-less consumers — email, RSS, foreign apps — read a whole URL); `lookupUrl` render helper resolves a ref to `meta.url` or a named preset. SDK collapses `assetUrl(source, preset, {ext})` into one `url(ref)` join + a dev-mode SPA-fallback detector. *("Served entity" — file/resource/preset — avoids colliding with the `assets` plugin's own "asset reference" term.)* | Accepted (proven against gpoint) |
| [0012](./0012-auth-seam-in-core-identity-in-plugins.md) | Authentication is an engine seam; identity providers are plugins. Core ships a provider-agnostic verifier contract (`{ name, verify(req), challenge? }`), a constant-time `bearer()`, `resolveAuth()`, `authorize()`/`requireAuth()` and `reachabilityOf()` — replacing the same token+loopback rule hand-copied into `api`, `mcp` and `forms`, where it had already drifted into three behaviours. A configured verifier gates every request (no loopback bypass, WhiteBox posture); a plain `token:` keeps the trusted-local-host model. OAuth, RFC 9728 discovery and identity ship as `mikser-io-auth`; users and groups are Apache-format `htpasswd`/`htgroup` files in the working folder (ADR-0002), never written at runtime. Credentials compose (`anyOf`) and may carry an opaque row `scope` the engine never inspects, `$and`-ed with the endpoint's own query; scoped responses are never cached. No user table, no roles, no permission catalog in core. | Accepted |

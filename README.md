<p align="center">
  <img src="mikser-lockup-stacked.svg" alt="mikser" width="198" />
</p>

# Mikser

**Mikser is the content layer of your application.** Business logic, user accounts, transactions live in their own services; mikser handles the parts that *are* content — pages, docs, the published catalog, multi-format outputs. [Vue](https://github.com/almero-digital-marketing/mikser-io-sdk-vue), [React](https://github.com/almero-digital-marketing/mikser-io-sdk-react), and [Svelte](https://github.com/almero-digital-marketing/mikser-io-sdk-svelte) SDKs are the seam between them — same surface across all three (`useDocument`, `useDocuments`, multilingual `useHref`, live SSE updates), each in its framework's idiomatic shape.

**An AI-native file-based content engine with live graph queries.** Content lives as plain text files you can read, search, and version-control like code. Mikser knows how those files reference each other — who an article's author is, which images a landing page uses, who else mentions a given product. When you fetch an article, you can pull its author and that author's organization along with it in one round-trip. When the author's bio changes, every page subscribed to a reference touching them updates live, without polling. AI agents talk to mikser through the same calls a frontend developer uses — there's no separate "AI API" to keep in sync. The whole graph is queryable from both sides at once.

Built for Node.js around a strict lifecycle and a composable plugin system. Every document, asset, and template flows through the same pipeline; plugins hook in at any phase. The same engine runs a single markdown blog and a multi-language publishing platform with PDF / email / AI-augmented asset pipelines — same lifecycle, more plugins.

It's MIT-licensed, runs on Node 18+, has zero hosted dependencies, and the entire content tree it manages is a folder of `.md` and `.yml` files you can copy, diff, and version-control. **The portability promise is the architecture, not a feature.**

> **New to mikser?** Read the [Architecture Overview](./documentation/overview.md) — one document, end-to-end walkthrough of how a file becomes a deployed page across all twenty lifecycle phases. It's the doc most projects need first.

## Where it fits

Mikser is a focused component, not a backend. Think of it like a database in your stack: defined surface, content-shaped responsibilities, the app code lives separately and reaches in through a small typed interface.

| | Strapi / Payload / Sanity / Contentful | Mikser as content layer |
|---|---|---|
| **Role** | "Be the backend" — content + relationships + sometimes business logic | One component of the app, specifically the content piece |
| **Boundary** | Soft — they invite business logic into the CMS (computed fields, hooks, workflows) | Hard — files in, rendered output out; business logic isn't here |
| **Coupling** | App tied to the CMS vendor | App owns business logic independently; the content source can be swapped |
| **Storage** | Vendor's database, vendor's schema | Plain `.md` / `.yml` files on disk — diffable, portable, takeable on day one and year ten |
| **Migration risk** | High when the vendor reinvents itself (Strapi v3→v4, etc.) | Content is files, business logic is yours — neither is exposed to the other's churn |

Build mikser into the parts of your application that are content-shaped. Keep the rest where it belongs.

## Why mikser

**Your content stays yours.** Source files live on disk as `.md`, `.yml`, `.html` with YAML front-matter. The build output is plain static files. No database lock-in, no proprietary export format. The whole content tree is copyable, diffable, and version-controllable with git — your site is portable on day one and on year ten.

**Static-first with a built-in live channel.** Most content engines pick one side: static-site generators (Hugo, Eleventy, Jekyll) are fast but rebuild-only; headless CMSes (Sanity, Contentful, Strapi) are live but every page is an API round-trip. Mikser composes both — content publishes as static files by default (fast first paint, no API on the happy path), and the live channel arrives on top, so edits show up in connected clients without a refresh and without losing the static advantage.

**Incremental builds that scale.** Mikser tracks every entity in a journal. When a file changes, only the affected entities re-process — not the whole site graph. On 10k+ documents this dramatically outpaces tools that rebuild more on every change.

**Concurrent rendering.** Renders fan out across a worker pool that keeps every CPU core hot. Multi-format outputs (HTML, PDF, MJML email, etc.) generate in parallel from the same source.

**Asset pipelines are whatever Node can do.** Most static frameworks (Astro, Next.js, Hugo) ship image optimization and stop there — video transcoding, AI upscaling, watermarking all need a separate service. Mikser runs user-written modules over binary inputs: ~10 lines around `sharp` resize an image, ~10 around `fluent-ffmpeg` transcode a video, ~30 around the Replicate API upscale with AI. Anything an npm package can do, your pipeline can do — including pulling uploads from a DAM or CDN through the same flow.

**One lifecycle, everything composes.** Plugins hook into 20+ named lifecycle phases. A search-indexing plugin shares the same journal iteration as an email-rendering plugin and a PDF-postprocessing plugin — no glue code, no orchestration layer. The engine doesn't know which plugins are loaded; plugins don't have to know about each other.

**Run anywhere.** The same CLI handles one-shot builds, watch-mode dev loops, and a long-running HTTP server with a shared Express app. `npx mikser` ships a static site; `mikser --watch` is the dev loop; `mikser --server` exposes a live admin/API.

**Outages don't take you down.** Headless CMSes (Contentful, Sanity, Strapi) treat the API as the source of truth — when it blinks, every frontend errors out. Mikser inverts that: reads become static files on disk, the live channel layers on top. A reverse proxy keeps serving the files when mikser blips. Visitors don't notice; live updates pause until mikser returns.

**Library mode.** Mikser is also a library. `useRenderer`, `useCollection`, and direct lifecycle hooks let you embed the engine inside an existing Node app instead of running it as a CLI — plugins like `vector` add their own primitives the same way.

**Open source.** MIT-licensed, on GitHub, no telemetry, no auth wall, no SaaS dependency. What you see is what runs.

## Built for AI-assisted development

Files-as-source isn't just a portability story — it makes the project unusually friendly to AI coding agents. There's a static-time half (the agent reads your tree the way it reads any repo — no DB connection, no schema upload, no sandboxed query layer to learn) and a runtime half (when the agent needs to write or render, mikser ships its own MCP server in core, so it talks to the live engine instead of a parallel REST shim you have to maintain).

**Zero infra friction for discovery.** An agent can `rg "type: product"` across the content tree to find every product doc in a second. No DB connection, no API token, no schema file to parse.

**The schema emerges from examples, not a definition file.** Front-matter shows what fields exist *in the docs that exist*. Markdown + YAML are overwhelmingly well-represented in AI training data, so the model "speaks" them fluently and infers structure from real documents better than from a schema definition.

**Determinism shortens the iteration loop.** Save a file → watcher fires → predictable rebuild. No DB triggers, no surprise cache invalidation, no API quotas. The agent's mental model of "what happens next" can be precise instead of probabilistic.

**The SDK's `.d.ts` is the read-side contract.** When the agent writes frontend query code, the operator subset and envelope shape are right there in types — a step-change for code generation quality versus "go read the REST API docs."

**Plugin-by-example.** Authoring a new plugin? There are 15+ existing ones in the same shape to pattern-match against. Convention is dense enough that new plugins look like the old ones without coaching.

**One-shot bootstrap via Claude Code.** The [`mikser-io-claude-plugin`](https://github.com/almero-digital-marketing/mikser-io-claude-plugin) wraps the whole setup into a single skill. Register the marketplace, install once:

```
/plugin marketplace add almero-digital-marketing/mikser-io-claude-plugin
/plugin install mikser-io-claude-plugin@mikser-io
```

…then in any Vue 3, React, or SvelteKit project — or in a blank directory — say *"add mikser to this app."* It detects the framework (or scaffolds a fresh starter via `create-vite` / `sv create`), wires the matching framework SDK without replacing your router, and optionally drops a `mikser-content/` sibling folder with Zod schemas and starter documents so the backend works on first run.

The runtime half — the agent driving the live engine, not just reading the tree — gets its own section below.

The honest caveat: this advantage is real on **content-shaped work** — adding pages, restructuring collections, generating new layouts, building frontends. It doesn't make mikser better for non-content tasks (concurrency bugs in the worker pool, database tuning elsewhere in your stack); those are plain Node debugging like anywhere else. The visibility advantage also degrades past ~10k documents — at that scale the agent queries via the SDK instead of grepping the tree, which is still good but less "see everything at once."

## Control mikser from your AI agent

Add `--mcp` to your mikser command and any MCP-speaking client — Claude Desktop, Claude Code, ChatGPT, custom agents — connects to the running engine. From inside a chat, your AI can:

- read every entity in the catalog
- write new content files (markdown, layouts, configuration) — writes land on disk and the next cycle picks them up
- render any layout for preview without touching the output folder
- **surface rendered UI inline in the conversation** — `mikser_preview_ui` runs an entity through a layout that declares `mcpUi` frontmatter and returns the HTML as a UI block the host can show; an approve/reject button on that block sends the result straight back to the agent
- watch every build log as it streams past
- introspect engine state — current lifecycle phase, effective config, recent log buffer

Plugins extend the tool surface the same way they mount HTTP routes; install the plugin, the agent gets new verbs. No glue code, no per-project agent wiring.

```bash
mikser --server --mcp           # mounts MCP at /mcp on the same port as --server
```

What that feels like in practice: *"draft three hero-section variants and show me previews"* — three layouts written, three previews returned inline, one chat turn. *"Why did the build break?"* — the agent reads the rolling log buffer and answers from the same view your terminal sees. *"Update this article's tone and show me the preview"* — the agent edits the file and surfaces the rendered article inline; you click Approve or Reject, the agent acts on your choice. Operator, AI, and any observer dashboard share the same engine because mikser is single-tenant by design.

### Editing is the easy part — verification is where it pays off

When an AI agent edits ten files, the next question is: *did it do what I asked?* When it edits two hundred, you can't read them all yourself — and that's exactly the scale where AI editing starts being interesting. Most content systems leave verification to the human (read the diff, check the preview, hope you caught the issues). Mikser turns the questions a reviewer would ask into things the agent can answer for itself:

- **"Did I update every article that needed it?"** — semantic search finds anything that still matches the old tone or phrasing the agent was supposed to change.
- **"What else mentions this person, product, or topic?"** — mikser knows how content references content. "Show me every page that mentions Dick" returns the list instantly, no full-tree scan.
- **"Did anything break?"** — if a reference points at something that no longer exists, mikser surfaces it as a warning. The build either completes cleanly or doesn't.
- **"Can I see what this looks like before publishing?"** — render any single page or section on demand, no full rebuild, no staging deploy.
- **"What changed since I last looked?"** — `git diff`. The catalog is plain files, so the audit trail is the same one your engineers already use for code.
- **"Roll back this batch?"** — `git checkout`. Atomic. No database migration to undo, no version-history-feature to learn.

The shift this enables: AI review stops being *"read every change"* and becomes *"spot-check the agent's confidence."* The agent verifies its own work; the human samples and approves. That's the workflow that lets a content team actually use AI at scale — change the tone across the entire site in a morning, ship it after a coffee.

Full tool reference and twelve worked scenarios in [MCP — talking to mikser from AI](./documentation/mcp.md).

## Plugins on top of the engine

The engine is what stays stable — the lifecycle, the catalog, the file-based content model. Plugins are independent npm packages sitting on the plugin API: some are essential to the SSG workflow, some give external systems HTTP access to the catalog, some are integrations that earn their keep on real projects, and some are probes that test how far the lifecycle stretches without touching the core. Install what a project needs; drop what it doesn't.

**Core — sources, layouts, renderers, postprocessors:**

| Plugin | What it does |
|---|---|
| `documents`, `files`, `resources`, `assets` | Content sources |
| `layouts` | Layout resolution with auto-matching |
| `render-hbs`, `render-eta`, `render-liquid`, `render-markdown` | Template engines |
| `render-resource`, `render-asset`, `render-href` | Resource / asset / link rewriting at render time |
| `post-pdf` | HTML → PDF via headless Chromium |
| `post-mjml` | MJML email markup → inbox-safe HTML |

**HTTP access to the catalog:**

| Plugin | What it does |
|---|---|
| `data` | JSON snapshots of entities / context / catalog, written to disk for static serving |
| `api` | REST endpoints with sift-backed queries, per-endpoint tokens, optional render, opt-in [per-query disk cache](./documentation/caching.md) for reverse-proxy failover |
| `preview` | In-memory render cache + `GET /preview/:filename` route. Companion to the [`mikser_preview`](./documentation/mcp.md) MCP tool — transient render bytes served at a clickable URL, no filesystem footprint |

**Integrations:**

| Plugin | What it does |
|---|---|
| [`mikser-io-vector`](https://github.com/almero-digital-marketing/mikser-io-vector) | OpenAI embeddings + semantic search (sqlite-vec or pgvector) |
| [`mikser-io-plugin-schemas`](https://github.com/almero-digital-marketing/mikser-io-plugin-schemas) | Zod-backed entity validation + auto-generated TypeScript declarations for the SDK. Auto-detects `$`-keyed references and warns on broken ones — see [ADR-0007](./documentation/decisions/0007-references-declaration-and-expansion.md) |
| [`mikser-io-archive`](https://github.com/almero-digital-marketing/mikser-io-archive) | Persist matching entities to YAML — audit trail, versioned content history, downstream export |
| `mapper` | Run config-supplied transforms over matched entities each cycle (in-core, generic transformation layer) |
| [`mikser-io-live`](https://github.com/almero-digital-marketing/mikser-io-live) | Lightweight dev server with browser auto-refresh — pair with `--watch` for the classic save→reload loop |
| [`mikser-io-aml`](https://github.com/almero-digital-marketing/mikser-io-aml) | Parse [ArchieML](https://archieml.org/) (the NYT/ProPublica format) into `entity.meta` for non-technical authors |

**Integration probes** — wrap a substantial external project as a plugin to confirm the lifecycle is open enough to host it without core changes. Treat these as feasibility evidence, not as a statement about where mikser is heading:

| Plugin | What it does |
|---|---|
| `decap` | Mounts [Decap CMS](https://decapcms.org/) inside the same Express server — admin UI + local proxy backend + bake-to-`out/` for static deploys (~150 lines, zero engine changes) |

## Client SDKs

The `api`, `vector`, and `schemas` plugins are paired with client-side SDKs so a frontend (or another Node app) can talk to a running mikser server without rolling its own `fetch` glue or type contracts. Zero dependencies, runs in browsers / Node 18+ / Deno / Bun / Workers.

**Transport-level:**

| Package | For the plugin | What you get |
|---|---|---|
| [`mikser-io-sdk-api`](https://github.com/almero-digital-marketing/mikser-io-sdk-api) | `api` | `entities(name).list / query / urlFor / pages / update / delete / render / live` — Mongo-style filter operators backed by sift, sort, projection, pagination, SSE-driven live subscriptions, and `expand: [...]` to inline-resolve `$`-keyed references in one round-trip (multi-hop chains, `*` array iteration) |
| [`mikser-io-sdk-vector`](https://github.com/almero-digital-marketing/mikser-io-sdk-vector) | `vector` | `vector(storeName).findSimilar(text, { limit })` — semantic search hits with the original mapped object attached |

**Framework integrations** — all three wrap `mikser-io-sdk-api` in framework-idiomatic shapes. Same surface: `useDocument` / `useDocuments` live data, multilingual `useHref` / `useAlternates`, asset resolution via `useAsset`, generic on entity type so `mikser-io-plugin-schemas`-emitted types compose:

| Package | Framework | Notes |
|---|---|---|
| [`mikser-io-sdk-vue`](https://github.com/almero-digital-marketing/mikser-io-sdk-vue) | Vue 3 | Composables, vue-router integration (`useMikserRoutes` to augment an existing router, `generateMikserRoutes` for SSG prerender), provide/inject for the client. |
| [`mikser-io-sdk-react`](https://github.com/almero-digital-marketing/mikser-io-sdk-react) | React 18+ / 19+ | Hooks, `<MikserProvider>` Context, React Router v6+ integration via `useMikserRoutes` → `useRoutes()`. |
| [`mikser-io-sdk-svelte`](https://github.com/almero-digital-marketing/mikser-io-sdk-svelte) | Svelte 5 (runes) | `$state` / `$effect` reactives, SvelteKit-friendly `generateMikserRoutes` for `entries()` prerender, `useMikserPages` for live nav. |

Each SDK ships TypeScript declarations so client projects get autocomplete on filters, envelopes, and the `MikserError` thrown on non-2xx responses. Pair any of the framework SDKs with the `entities.d.ts` emitted by `mikser-io-plugin-schemas` for typed entity meta per layout. Install only the one(s) a project needs.

## Quick Start

```bash
npm install mikser-io
```

```bash
npx mikser              # one-shot build
npx mikser --watch      # incremental dev loop
npx mikser --server     # build + serve at :3001
```

For a working starter — config with a real plugin set, sample `documents/`, expected output — see [Getting Started](./documentation/getting-started.md). Or skip straight to "add mikser to this app" via the [Claude Code plugin](#built-for-ai-assisted-development) above.

## Core Concepts

- **Lifecycle** — Processing runs through fixed phases: initialize → load → import → process → persist → render → finalize. Plugins hook into any phase.
- **Entities** — Everything is an entity (document, file, layout, asset). Entities flow through the journal and are tracked in the catalog.
- **References between entities** — Front-matter keys starting with `$` (e.g. `$author: /authors/dick`) are references. The engine projects them to plain keys (`meta.author`) for templates and SDK consumers; the schemas plugin auto-validates them; the api can `expand` them inline for one-trip graph fetches. The engine also maintains an inverse-reference index at `runtime.refs.*` (graph queries, rename cascade, live-expand subscriptions, MCP tools `mikser_refs_inbound` / `_outbound` / `_broken` / `_rename`). See [ADR-0007](./documentation/decisions/0007-references-declaration-and-expansion.md).
- **Plugins** — Functionality is delivered via plugins. Built-in plugins handle common sources (documents, files, layouts, assets). Custom plugins can be added to any project.
- **Runtime Singleton** — A plain module-level object holds all global state and coordinates the lifecycle. The ES module cache guarantees every importer gets the same instance.
- **Watch Mode** — In watch mode, file changes trigger incremental re-processing without restarting.

## What you can build with it

The shape mikser fits cleanly:

- **Marketing sites with editorial teams** — content authors work in files (via their editor, a Git client, or `mikser-io-decap`), engineers ship features without negotiating with a CMS schema, the site stays portable.
- **Multilingual publishing platforms** — the `useHref()` / `useAlternates()` pattern in `sdk-vue` decouples logical references from per-locale URLs. One source tree, many language deployments.
- **Content-heavy product catalogues** — `documents` + `mikser-io-plugin-schemas` + `data` plugin + a Vue frontend = typed product listings with live updates, semantic search via `vector`, and static-CDN-friendly JSON snapshots all at once.
- **AI-augmented media pipelines** — `assets` plugin presets call out to Replicate / OpenAI / local models to upscale images, transcribe audio, transcode video. The pipeline is JS code, so anything Node can do is in scope.
- **Mixed-output publishing** — the same source document renders to HTML, PDF (via `post-pdf`), MJML email (via `post-mjml`), and JSON snapshots. One catalog, many output formats, all concurrent.
- **Headless backends for static frontends** — pair the `api` plugin with `sdk-api` for SSE-driven live frontends; pair the `data` plugin output with any static host for pre-rendered consumption.

The shape mikser **doesn't** fit cleanly: anything with non-technical content authors who can't or won't work with files, anything with non-content business logic at the core, anything needing multi-tenant / per-user auth. Those aren't bugs — they're outside the design envelope. See [`decisions/0001-content-layer-not-the-app.md`](./documentation/decisions/0001-content-layer-not-the-app.md) for the explicit scope decision.

## Engineering discipline

What you get from how this project is built:

- **Every load-bearing decision has an ADR.** The [`decisions/`](./documentation/decisions/) folder names which choices are structural — files-as-source, journal+catalog split, plugin-as-factory, when something goes in core vs. ships as a plugin — and explains what protects them. When you push against one, there's a written answer waiting instead of folklore.
- **Engine stays small; capability ships in plugins.** The 15+ plugin ecosystem adds features without core changes, so your upgrade cost stays low. Probes like `decap` (a full third-party CMS mounted in ~150 lines, zero engine changes) are deliberate evidence the extension model holds where it counts.
- **Builds are deterministic; no async middleware layer.** The journal is the only synchronization primitive — no event bus, no IoC container, no orchestrator running plugins in surprising order. The lifecycle is a list of named phases; "what ran when?" has an answer you can read off the source.
- **The whole engine is one read.** The [Architecture Overview](./documentation/overview.md) walks the full pipeline top to bottom. Onboarding a new engineer is an afternoon, not a tour through fifteen reference docs.

## Acknowledgments

The earliest version of mikser was inspired by [DocPad](https://github.com/docpad/docpad) (Benjamin Lupton, with Michael Duane Mooring and Rob Loach). DocPad's "freeway, not a box" philosophy — files on disk, any pre-processor or template engine, plugin-by-convention extension — shaped how mikser started.

Mikser itself has a previous chapter: the [legacy 7.x line](https://github.com/almero-digital-marketing/mikser) (last release 2022) introduced the real-time SSG model the current engine still carries forward. The redesign dropped MongoDB (the catalog lives in-process now, not in a database), modernized to Node 18+ ESM with a structured 20-phase lifecycle, added the live SSE channel that powers the framework SDKs, and replaced cluster-based rendering with an async worker pool. Same intent — content as files, real-time previews, multi-format output at scale — clearer foundations.

## Documentation Index

| Document                                              | Audience           | Description                                        |
| ----------------------------------------------------- | ------------------ | -------------------------------------------------- |
| [Architecture Overview](./documentation/overview.md)  | Everyone           | **Start here.** End-to-end walkthrough of how a file becomes a deployed page across all lifecycle phases. |
| [Getting Started](./documentation/getting-started.md) | Users              | Installation, first project, basic usage           |
| [Configuration](./documentation/configuration.md)     | Users              | All CLI options and config file reference          |
| [Lifecycle](./documentation/lifecycle.md)             | Users & Developers | Complete lifecycle phases and hook system          |
| [Plugins](./documentation/plugins.md)                 | Users & Developers | Built-in plugins, writing custom plugins, the assets / resources / AI pipeline |
| [Entities](./documentation/entities.md)               | Users & Developers | Entity model, operations, journal, catalog         |
| [Rendering](./documentation/rendering.md)             | Users & Developers | Render pipeline, render plugins, render modes      |
| [Watch Mode](./documentation/watch-mode.md)           | Users              | File watching, scheduled tasks, incremental builds |
| [MCP](./documentation/mcp.md)                         | Users              | The `--mcp` server — tool surface, `mikser://` resources, twelve worked AI-driven scenarios |
| [Caching](./documentation/caching.md)                 | Users (production) | The `cache: true` disk cache + working nginx config for reverse-proxy failover |
| [Architecture](./documentation/architecture.md)       | Developers         | Module-level reference — what's in each file       |
| [API Reference](./documentation/api-reference.md)     | Developers         | Complete public API reference                      |
| [Decisions (ADRs)](./documentation/decisions/)        | Developers         | Load-bearing architectural choices and what protects them |

## License

MIT — see [LICENSE](./LICENSE).

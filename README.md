<p align="center">
  <img src="mikser-lockup-stacked.svg" alt="mikser" width="198" />
</p>

# Mikser

**Mikser is the content layer of your application.** Business logic, user accounts, transactions live in their own services; mikser handles the parts that *are* content — pages, docs, the published catalog, multi-format outputs. [Vue](https://github.com/almero-digital-marketing/mikser-io-sdk-vue), [React](https://github.com/almero-digital-marketing/mikser-io-sdk-react), and [Svelte](https://github.com/almero-digital-marketing/mikser-io-sdk-svelte) SDKs are the seam between them — same surface across all three (`useDocument`, `useDocuments`, multilingual `useHref`, live SSE updates), each in its framework's idiomatic shape.

Built for Node.js around a strict lifecycle, a composable plugin system, and direct control over every output. Every document, asset, and template flows through the same deterministic pipeline. Plugins hook in at any phase; nothing runs outside the cycle. It scales from a single markdown blog to a multi-language, multi-format publishing platform with image / video / AI pipelines, live SSE-driven editors, semantic search, and typed frontend contracts — and stays predictable in both directions.

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

**Incremental builds that scale.** Mikser tracks every entity in a journal. When a file changes, only the affected entities re-process — not the whole site graph. On 10k+ documents this dramatically outpaces tools that rebuild more on every change.

**Concurrent rendering.** Renders fan out across a worker pool that keeps every CPU core hot. Multi-format outputs (HTML, PDF, MJML email, etc.) generate in parallel from the same source.

**Image, video, and AI pipelines authored as plugins — not configured.** The `assets` plugin runs user-written preset modules over binary inputs. A preset is a plain Node module: ~10 lines around `sharp` resize an image, ~10 lines around `fluent-ffmpeg` transcode a video, ~30 lines around the Replicate API run an AI upscaler. The pipeline isn't a fixed menu of operations — it's whatever Node can call. Most SSGs cap your asset processing at "resize and convert format." Mikser caps it at "what can Node do." Compose with the `resources` plugin and your DAM, CDN, or company content server becomes an upstream input — uploaded files end up transcoded, watermarked, AI-enhanced, and deployed without manual handoff. See [the assets / resources docs](./documentation/plugins.md#assets) for end-to-end examples.

**One lifecycle, everything composes.** Plugins hook into 20+ named lifecycle phases. A search-indexing plugin shares the same journal iteration as an email-rendering plugin and a PDF-postprocessing plugin — no glue code, no orchestration layer. The engine doesn't know which plugins are loaded; plugins don't have to know about each other.

**Run anywhere.** The same CLI handles one-shot builds, watch-mode dev loops, and a long-running HTTP server with a shared Express app. `npx mikser` ships a static site; `mikser --watch` is the dev loop; `mikser --server` exposes a live admin/API.

**Library mode.** Mikser is also a library. `useRenderer`, `useCollection`, `findSimilar`, and direct lifecycle hooks let you embed the engine inside an existing Node app instead of running it as a CLI.

**Open source.** MIT-licensed, on GitHub, no telemetry, no auth wall, no SaaS dependency. What you see is what runs.

## Built for AI-assisted development

Files-as-source isn't just a portability story — it makes the project unusually friendly to AI coding agents. Most setups lose time configuring an agent's access to the data: tokens, schemas, MCP servers, sandboxed query environments. Mikser sidesteps all of it because the content is text files the agent can already read with the tools it already has.

**Zero infra friction for discovery.** An agent can `rg "type: product"` across the content tree to find every product doc in a second. No DB connection, no API token, no schema file to parse.

**The schema emerges from examples, not a definition file.** Front-matter shows what fields exist *in the docs that exist*. Markdown + YAML are overwhelmingly well-represented in AI training data, so the model "speaks" them fluently and infers structure from real documents better than from a schema definition.

**Determinism shortens the iteration loop.** Save a file → watcher fires → predictable rebuild. No DB triggers, no surprise cache invalidation, no API quotas. The agent's mental model of "what happens next" can be precise instead of probabilistic.

**The SDK's `.d.ts` is the read-side contract.** When the agent writes frontend query code, the operator subset and envelope shape are right there in types — a step-change for code generation quality versus "go read the REST API docs."

**Plugin-by-example.** Authoring a new plugin? There are 15+ existing ones in the same shape to pattern-match against. Convention is dense enough that new plugins look like the old ones without coaching.

**One-shot bootstrap via Claude Code.** The [`mikser-io-claude-plugin`](https://github.com/almero-digital-marketing/mikser-io-claude-plugin) wraps the setup story above into a single skill. Run `/plugin add almero-digital-marketing/mikser-io-claude-plugin` once in Claude Code, then in any Vue 3, React, or SvelteKit project — or in a blank directory — say "add mikser to this app." It detects the framework (or scaffolds a fresh starter via `create-vite` / `sv create`), wires the matching framework SDK, composes with your existing router rather than replacing it, and optionally lays down a `mikser-content/` sibling folder with Zod schemas and starter documents so the backend works on first run.

The honest caveat: this advantage is real on **content-shaped work** — adding pages, restructuring collections, generating new layouts, building frontends. It doesn't make mikser better for non-content tasks (concurrency bugs in the worker pool, database tuning elsewhere in your stack); those are plain Node debugging like anywhere else. The visibility advantage also degrades past ~10k documents — at that scale the agent queries via the SDK instead of grepping the tree, which is still good but less "see everything at once."

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
| `api` | REST endpoints with sift-backed queries, per-endpoint tokens, optional render |

**Integrations:**

| Plugin | What it does |
|---|---|
| [`mikser-io-vector`](https://github.com/almero-digital-marketing/mikser-io-vector) | OpenAI embeddings + semantic search (sqlite-vec or pgvector) |
| [`mikser-io-plugin-schemas`](https://github.com/almero-digital-marketing/mikser-io-plugin-schemas) | Zod-backed entity validation + auto-generated TypeScript declarations for the SDK |
| `archive`, `mapper`, `live`, `aml` | Specialty integrations |

**Integration probes** — wrap a substantial external project as a plugin to confirm the lifecycle is open enough to host it without core changes. Treat these as feasibility evidence, not as a statement about where mikser is heading:

| Plugin | What it does |
|---|---|
| `decap` | Mounts [Decap CMS](https://decapcms.org/) inside the same Express server — admin UI + local proxy backend + bake-to-`out/` for static deploys (~150 lines, zero engine changes) |

## Client SDKs

The `api`, `vector`, and `schemas` plugins are paired with client-side SDKs so a frontend (or another Node app) can talk to a running mikser server without rolling its own `fetch` glue or type contracts. Zero dependencies, runs in browsers / Node 18+ / Deno / Bun / Workers.

**Transport-level:**

| Package | For the plugin | What you get |
|---|---|---|
| [`mikser-io-sdk-api`](https://github.com/almero-digital-marketing/mikser-io-sdk-api) | `api` | `entities(name).list / query / urlFor / pages / update / delete / render / live` — Mongo-style filter operators backed by sift, sort, projection, pagination, SSE-driven live subscriptions |
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

```js
// mikser.config.js
export default {
	plugins: ['documents', 'layouts'],
	layouts: {
		cleanUrls: true,
	},
}
```

```bash
npx mikser              # one-shot build
npx mikser --watch      # incremental dev loop
npx mikser --server     # build + serve at :3001
```

## Core Concepts

- **Lifecycle** — Processing runs through fixed phases: initialize → load → import → process → persist → render → finalize. Plugins hook into any phase.
- **Entities** — Everything is an entity (document, file, layout, asset). Entities flow through the journal and are tracked in the catalog.
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

A few things this project takes seriously:

- **ADRs for load-bearing decisions.** The [`decisions/`](./documentation/decisions/) folder names which choices are structural — files-as-source, journal+catalog split, plugin-as-factory, compose-via-protocols — and explains what protects them. Read those before proposing a feature that pushes against one.
- **Engine stability, plugin churn.** The 15+ plugins in the ecosystem add capability without core changes. The integration probes (e.g. `decap`, mounting a third-party CMS in ~150 lines) are deliberate evidence that the extension model holds.
- **Deterministic builds.** The journal is the synchronization primitive. There's no event-passing layer, no IoC container, no plugin orchestrator. The engine knows how to fire phases in order; everything else falls out of that.
- **The mental model is one document.** The [Architecture Overview](./documentation/overview.md) is one read for the full top-to-bottom picture. The reference docs exist for lookup; the overview exists for comprehension.

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
| [Architecture](./documentation/architecture.md)       | Developers         | Module-level reference — what's in each file       |
| [API Reference](./documentation/api-reference.md)     | Developers         | Complete public API reference                      |
| [Decisions (ADRs)](./documentation/decisions/)        | Developers         | Load-bearing architectural choices and what protects them |

## License

MIT — see [LICENSE](./LICENSE).

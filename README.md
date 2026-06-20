<p align="center">
  <img src="mikser-lockup-stacked.svg" alt="mikser" width="198" />
</p>

<p align="center"><strong>The AI-native content engine.</strong></p>

# Mikser

**Mikser is a content mixer.** Pull content from anywhere — markdown files, Google Sheets, your ERP, a CMS, any API — into one live catalog, link it together with references, and ship it to any frontend. Edit a price in your ERP or a cell in a spreadsheet, and every page that uses it updates within seconds — in whatever framework you built the site with.

**Framework-agnostic on both ends.** Headless CMSes (Sanity, Contentful) free you from the database but lock authoring into their UI. Frameworks like Astro let you bring any frontend but lock you into the framework. Mikser frees both: **any source in, any frontend out.** Provider plugins turn external systems into content sources; the catalog is served over plain HTTP, with idiomatic [Vue](https://github.com/almero-digital-marketing/mikser-io-sdk-vue) / [React](https://github.com/almero-digital-marketing/mikser-io-sdk-react) / [Svelte](https://github.com/almero-digital-marketing/mikser-io-sdk-svelte) SDKs on top (`useDocument`, `useDocuments`, multilingual `useHref`, live SSE). It's also AI-native: agents read and write the same catalog over MCP using the same calls a frontend developer uses — there's no separate "AI API" to keep in sync.

**References merge sources into one call.** Mikser tracks how entities reference each other — an article's author, the marketing copy and ERP price behind a product page, the images a landing page uses. Fetch the product and pull its marketing copy, price, and hero image along with it in one round-trip. Change any of them and every page subscribed to a reference touching it re-renders live, without polling — and mikser invalidates *exactly* the pages that depend on it, nothing more.

**Your content stays yours.** Source files live on disk as `.md` / `.yml` — diffable, version-controllable, portable on day one and year ten. No database lock-in, no proprietary export. And it's the content layer, not your whole backend: business logic, accounts, and transactions stay in their own services; mikser handles the part that's actually content — rendered to HTML, PDF, email, and other formats from the same source.

Built for Node.js around a strict lifecycle and a composable plugin system: every document, asset, and template flows through the same pipeline, and plugins hook in at any phase. MIT-licensed, runs on Node, zero hosted dependencies. **The portability promise is the architecture, not a feature.**

> **New to mikser?** Read the [Architecture Overview](./docs/overview.md) — one document, end-to-end walkthrough of how a file becomes a deployed page across all twenty lifecycle phases. It's the doc most projects need first.

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

**Concurrent rendering.** Renders run async by default and CPU-heavy layouts (MJML compile, image processing, custom transforms) opt into a Piscina worker pool per layout via `task: worker` in frontmatter. Multi-format outputs (HTML, PDF, MJML email, etc.) generate from the same source; the pool is lazy — no workers spawn until they're asked for.

**Asset pipelines are whatever Node can do.** Most static frameworks (Astro, Next.js, Hugo) ship image optimization and stop there — video transcoding, AI upscaling, watermarking all need a separate service. Mikser runs user-written modules over binary inputs: ~10 lines around `sharp` resize an image, ~10 around `fluent-ffmpeg` transcode a video, ~30 around the Replicate API upscale with AI. Anything an npm package can do, your pipeline can do — including pulling uploads from a DAM or CDN through the same flow.

**One lifecycle, everything composes.** Plugins hook into 20+ named lifecycle phases. A search-indexing plugin shares the same journal iteration as an email-rendering plugin and a PDF-postprocessing plugin — no glue code, no orchestration layer. The engine doesn't know which plugins are loaded; plugins don't have to know about each other.

**Run anywhere.** The same CLI handles one-shot builds, watch-mode dev loops, and a long-running HTTP server with a shared Express app. `npx mikser` ships a static site; `mikser --watch` is the dev loop; `mikser --server` exposes a live admin/API.

**Outages don't take you down.** Headless CMSes (Contentful, Sanity, Strapi) treat the API as the source of truth — when it blinks, every frontend errors out. Mikser inverts that: reads become static files on disk, the live channel layers on top. A reverse proxy keeps serving the files when mikser blips. Visitors don't notice; live updates pause until mikser returns.

**Library mode.** Mikser is also a library. `useRenderer`, `useCollection`, and direct lifecycle hooks let you embed the engine inside an existing Node app instead of running it as a CLI — plugins like `vector` add their own primitives the same way.

**Open source.** MIT-licensed, on GitHub, no telemetry, no auth wall, no SaaS dependency. What you see is what runs.

## Mix content from anywhere, ship to anywhere

A real content stack pulls from more than one system. Marketing copy lives in a CMS or a spreadsheet. Prices and stock live in an ERP. Hero images live in a DAM. Editorial pages live in markdown files in the repo. Most teams either pick one tool and contort the rest to fit it, or build sync services that copy everything into one database — and then more sync services when things drift out of sync.

Mikser is built around a different bet: **one queryable substrate that any source can pour into, and any frontend can read from.**

**Any source.** Provider plugins let you treat external systems as content sources. A Google Sheet, an ERP feed, a Drive folder, a Notion database, an HTTP webhook, the local repo's `.md` files — each becomes a stream of entities flowing into mikser's catalog with the same shape. The authoring tool doesn't change. The editorial workflow doesn't change. The team writing product copy in Google Sheets keeps writing product copy in Google Sheets — mikser just notices when they save.

**Cross-source composition through references.** Mikser tracks references between entities the way a graph database does. A product page can declare `$marketing` pointing at a row pulled from a spreadsheet, `$pricing` at a record pulled from your ERP, `$hero` at an asset pulled from your DAM. A single API call from your frontend asks for the product page *with* its referenced data — and gets the page, the marketing copy, the price, and the hero image merged into one response. One round trip, not three or four, and no consumer-side join logic to maintain.

**Live updates are uniform across every source.** Edit a cell in the spreadsheet, change a price in the ERP, replace an asset in the DAM — the pages depending on those entities update within seconds, in every frontend connected to mikser's live channel. You don't write per-source invalidation; mikser already knows which pages reference what.

**Your frontend is whatever you want.** Mikser exposes the catalog over HTTP (and over MCP, for AI agents). You query it from React, Vue, Svelte, SvelteKit, Next.js, an iOS app, a kiosk — anything that speaks HTTP. The framework SDKs (`mikser-io-sdk-react`, `mikser-io-sdk-vue`, `mikser-io-sdk-svelte`) make the calls feel native, but they're optional. Headless CMSes free you from the database lock. Frameworks like Astro free you from one kind of authoring lock. Mikser frees you from both at once: **any source on the input side, any framework on the output side.**

What this looks like in practice:

- Marketing edits product copy in Google Sheets, prices come from your ERP, both flow into the same product page in your storefront — changes appear within seconds, without your e-commerce team writing webhook handlers or cache-invalidation logic.
- A SaaS pulls customer-facing release notes from `release-notes/*.md` in the repo and feature flags from LaunchDarkly; both render in a dashboard built in the team's own React stack, not a framework somebody else picked.
- A magazine pulls editorial articles from local markdown, contributor bios from Notion, sponsorship info from Airtable, and renders the same article surface across web, email (MJML), and PDF — one catalog, one set of references, three outputs.

Adding a source is mechanical. See [`mikser-io-csv`](https://github.com/almero-digital-marketing/mikser-io-csv) (any HTTP-served CSV, with live polling), [`mikser-io-provider-gdrive`](https://github.com/almero-digital-marketing/mikser-io-provider-gdrive) (Google Drive), and the built-in `http` provider for the shape. If a system has an API, it can be a mikser source, usually in well under 100 lines.

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

Install the [`mikser-io-mcp`](https://github.com/almero-digital-marketing/mikser-io-mcp) plugin and any MCP-speaking client — Claude Desktop, Claude Code, ChatGPT, custom agents — connects to the running engine. From inside a chat, your AI can:

- read every entity in the catalog
- write new content files (markdown, layouts, configuration) — writes land on disk and the next cycle picks them up
- render any layout for preview without touching the output folder
- **surface interactive UI inline in the conversation** — you author the UI as a normal mikser layout with YAML frontmatter (`mcpUi: { mode, actions }`). The agent reads `mikser://mcp-ui/modes` to discover what UIs your project supports, calls `mikser_preview_ui` to render one against an entity, and the host displays the result as a sandboxed iframe in the chat. Buttons in the UI deliver their click back as a separate MCP tool turn — the iframe sends a JSON-RPC `tools/call` to the host over `postMessage` per the [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps), which the host bridges into a real `mikser_ui_action` invocation. The agent sees a structured `{action, entityId, payload}` result; if you declared `mcpUi.handler.url`, mikser forwards the action to your webhook first and uses its response. No separate UI framework, no glue code; layouts are still just layouts
- watch every build log as it streams past
- introspect engine state — current lifecycle phase, effective config, recent log buffer

Plugins extend the tool surface the same way they mount HTTP routes; install the plugin, the agent gets new verbs. No glue code, no per-project agent wiring.

```js
// mikser.config.js
import { mcp } from 'mikser-io-mcp'

export default {
    plugins: [mcp(), /* … */],
    // mcp({ path: '/mcp', endpoints: { … } }) when options are needed
}
```

```bash
mikser --server                 # MCP mounts at /mcp on the same port
```

What that feels like in practice: *"draft three hero-section variants and show me previews"* — three layouts written, three previews returned inline, one chat turn. *"Why did the build break?"* — the agent reads the rolling log buffer and answers from the same view your terminal sees. *"Update this article's tone and show me the preview"* — the agent edits the file and surfaces the rendered article inline; you click Approve or Reject, the agent acts on your choice. Operator, AI, and any observer dashboard share the same engine because mikser is single-tenant by design.

### Editing is the easy part — verification is where it pays off

When an AI agent edits ten files, the next question is: *did it do what I asked?* When it edits two hundred, you can't read them all yourself — and that's exactly the scale where AI editing starts being interesting. Most content systems leave verification to the human (read the diff, check the preview, hope you caught the issues). Mikser turns the questions a reviewer would ask into things the agent can answer for itself:

- **"Did I update every article that needed it?"** — semantic search finds anything that still matches the old tone or phrasing the agent was supposed to change.
- **"What else mentions this person, product, or topic?"** — mikser knows how content references content. "Show me every page that mentions Dick" returns the list instantly, no full-tree scan.
- **"Did anything break?"** — if a reference points at something that no longer exists, mikser surfaces it as a warning. The build either completes cleanly or doesn't.
- **"Can I see what this looks like before publishing?"** — render any single page or section on demand, no full rebuild, no staging deploy. With an `mcpUi` layout, the agent surfaces the rendered preview *inside the chat* with approve/reject controls; one click sends the result back as the tool response.
- **"What changed since I last looked?"** — `git diff`. The catalog is plain files, so the audit trail is the same one your engineers already use for code.
- **"Roll back this batch?"** — `git checkout`. Atomic. No database migration to undo, no version-history-feature to learn.

The shift this enables: AI review stops being *"read every change"* and becomes *"spot-check the agent's confidence."* The agent verifies its own work; the human samples and approves. That's the workflow that lets a content team actually use AI at scale — change the tone across the entire site in a morning, ship it after a coffee.

Full tool reference and twelve worked scenarios in the [`mikser-io-mcp` plugin docs](https://github.com/almero-digital-marketing/mikser-io-mcp#readme).

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
| `api` | REST endpoints with sift-backed queries, per-endpoint tokens, optional render, opt-in [per-query disk cache](./docs/caching.md) for reverse-proxy failover |
| `preview` | In-memory render cache + `GET /preview/:filename` route. Companion to the `mikser_preview_render` MCP tool (in [`mikser-io-mcp`](https://github.com/almero-digital-marketing/mikser-io-mcp)) — transient render bytes served at a clickable URL, no filesystem footprint |

**Integrations:**

| Plugin | What it does |
|---|---|
| [`mikser-io-vector`](https://github.com/almero-digital-marketing/mikser-io-vector) | OpenAI embeddings + semantic search (sqlite-vec or pgvector) |
| [`mikser-io-schemas`](https://github.com/almero-digital-marketing/mikser-io-schemas) | Zod-backed entity validation + auto-generated TypeScript declarations for the SDK. Auto-detects `$`-keyed references and warns on broken ones — see [ADR-0007](./docs/decisions/0007-references-declaration-and-expansion.md) |
| [`mikser-io-forms`](https://github.com/almero-digital-marketing/mikser-io-forms) | Public form-submission endpoints. POST → captcha + schema validation → write a document file plus uploaded files to disk; the `documents` / `files` plugins pick them up via their normal watch loop. Composes with `mikser-io-schemas` for schema-by-name; built-in captcha providers (Google v2/v3, hCaptcha, Turnstile) plus a custom-verify escape hatch |
| [`mikser-io-archive`](https://github.com/almero-digital-marketing/mikser-io-archive) | Persist matching entities to YAML — audit trail, versioned content history, downstream export |
| `mapper` | Run config-supplied transforms over matched entities each cycle (in-core, generic transformation layer) |
| [`mikser-io-live`](https://github.com/almero-digital-marketing/mikser-io-live) | Lightweight dev server with browser auto-refresh — pair with `--watch` for the classic save→reload loop |
| [`mikser-io-aml`](https://github.com/almero-digital-marketing/mikser-io-aml) | Parse [ArchieML](https://archieml.org/) (the NYT/ProPublica format) into `entity.meta` for non-technical authors |

**Integration probes** — wrap a substantial external project as a plugin to confirm the lifecycle is open enough to host it without core changes. Treat these as feasibility evidence, not as a statement about where mikser is heading:

| Plugin | What it does |
|---|---|
| `decap` | Mounts [Decap CMS](https://decapcms.org/) inside the same Express server — admin UI + local proxy backend + bake-to-`out/` for static deploys (~150 lines, zero engine changes) |

## Client SDKs

The `api`, `vector`, and `schemas` plugins are paired with client-side SDKs so a frontend (or another Node app) can talk to a running mikser server without rolling its own `fetch` glue or type contracts. Zero dependencies, runs in browsers / Node / Deno / Bun / Workers.

**Transport-level:**

| Package | For the plugin | What you get |
|---|---|---|
| [`mikser-io-sdk-api`](https://github.com/almero-digital-marketing/mikser-io-sdk-api) | `api` | `entities(name).list / query / urlFor / pages / update / delete / render / live` — Mongo-style filter operators backed by sift, sort, projection, pagination, SSE-driven live subscriptions, and `expand: [...]` to inline-resolve `$`-keyed references in one round-trip (multi-hop chains, `*` array iteration) |
| [`mikser-io-sdk-vector`](https://github.com/almero-digital-marketing/mikser-io-sdk-vector) | `vector` | `vector(storeName).findSimilar(text, { limit })` — semantic search hits with the original mapped object attached |

**Framework integrations** — all three wrap `mikser-io-sdk-api` in framework-idiomatic shapes. Same surface: `useDocument` / `useDocuments` live data, multilingual `useHref` / `useAlternates`, asset resolution via `useAsset`, generic on entity type so `mikser-io-schemas`-emitted types compose:

| Package | Framework | Notes |
|---|---|---|
| [`mikser-io-sdk-vue`](https://github.com/almero-digital-marketing/mikser-io-sdk-vue) | Vue 3 | Composables, vue-router integration (`useMikserRoutes` to augment an existing router, `generateMikserRoutes` for SSG prerender), provide/inject for the client. |
| [`mikser-io-sdk-react`](https://github.com/almero-digital-marketing/mikser-io-sdk-react) | React 18+ / 19+ | Hooks, `<MikserProvider>` Context, React Router v6+ integration via `useMikserRoutes` → `useRoutes()`. |
| [`mikser-io-sdk-svelte`](https://github.com/almero-digital-marketing/mikser-io-sdk-svelte) | Svelte 5 (runes) | `$state` / `$effect` reactives, SvelteKit-friendly `generateMikserRoutes` for `entries()` prerender, `useMikserPages` for live nav. |

Each SDK ships TypeScript declarations so client projects get autocomplete on filters, envelopes, and the `MikserError` thrown on non-2xx responses. Pair any of the framework SDKs with the `entities.d.ts` emitted by `mikser-io-schemas` for typed entity meta per layout. Install only the one(s) a project needs.

## Quick Start

```bash
npm install mikser-io
```

```bash
npx mikser              # one-shot build
npx mikser --watch      # incremental dev loop
npx mikser --server     # build + serve at :3001
```

For a working starter — config with a real plugin set, sample `documents/`, expected output — see [Getting Started](./docs/getting-started.md). Or skip straight to "add mikser to this app" via the [Claude Code plugin](#built-for-ai-assisted-development) above.

## Core Concepts

- **Lifecycle** — Processing runs through fixed phases: initialize → load → import → process → persist → render → finalize. Plugins hook into any phase.
- **Entities** — Everything is an entity (document, file, layout, asset). Entities flow through the journal and are tracked in the catalog.
- **References between entities** — A front-matter key starting with `$` (e.g. `$author: /authors/dick`) points at another entity. The engine knows the whole graph: templates can follow the links, the schemas plugin checks they resolve, and a single query can pull referenced entities along inline instead of one round trip per link. See [ADR-0007](./docs/decisions/0007-references-declaration-and-expansion.md).
- **Plugins** — Functionality is delivered via plugins. Built-in plugins handle common sources (documents, files, layouts, assets). Custom plugins can be added to any project.
- **Runtime Singleton** — A plain module-level object holds all global state and coordinates the lifecycle. The ES module cache guarantees every importer gets the same instance.
- **Watch Mode** — In watch mode, file changes trigger incremental re-processing without restarting.

## What you can build with it

The shape mikser fits cleanly:

- **Marketing sites with editorial teams** — content authors work in files (via their editor, a Git client, or `mikser-io-decap`), engineers ship features without negotiating with a CMS schema, the site stays portable.
- **Multilingual publishing platforms** — the `useHref()` / `useAlternates()` pattern decouples logical references from per-locale URLs. One source tree, many language deployments.
- **Content-heavy product catalogues** — `documents` + `mikser-io-schemas` + `data` plugin + a Frontend Framework = typed product listings with live updates, semantic search via `vector`, and static-CDN-friendly JSON snapshots all at once.
- **AI-augmented media pipelines** — `assets` plugin presets call out to Replicate / OpenAI / local models to upscale images, transcribe audio, transcode video. The pipeline is JS code, so anything Node can do is in scope.
- **Mixed-output publishing** — the same source document renders to HTML, PDF (via `post-pdf`), MJML email (via `post-mjml`), and JSON snapshots. One catalog, many output formats, all concurrent.
- **Headless backends for static frontends** — pair the `api` plugin with `sdk-api` for SSE-driven live frontends; pair the `data` plugin output with any static host for pre-rendered consumption.

The shape mikser **doesn't** fit cleanly: anything with non-technical content authors who can't or won't work with files, anything with non-content business logic at the core, anything needing multi-tenant / per-user auth. Those aren't bugs — they're outside the design envelope. See [`decisions/0001-content-layer-not-the-app.md`](./docs/decisions/0001-content-layer-not-the-app.md) for the explicit scope decision.

## Engineering discipline

What you get from how this project is built:

- **Every load-bearing decision has an ADR.** The [`decisions/`](./docs/decisions/) folder names which choices are structural — files-as-source, journal+catalog split, plugin-as-factory, when something goes in core vs. ships as a plugin — and explains what protects them. When you push against one, there's a written answer waiting instead of folklore.
- **Engine stays small; capability ships in plugins.** The 15+ plugin ecosystem adds features without core changes, so your upgrade cost stays low. Probes like `decap` (a full third-party CMS mounted in ~150 lines, zero engine changes) are deliberate evidence the extension model holds where it counts.
- **Builds are deterministic; no async middleware layer.** The journal is the only synchronization primitive — no event bus, no IoC container, no orchestrator running plugins in surprising order. The lifecycle is a list of named phases; "what ran when?" has an answer you can read off the source.
- **The whole engine is one read.** The [Architecture Overview](./docs/overview.md) walks the full pipeline top to bottom. Onboarding a new engineer is an afternoon, not a tour through fifteen reference docs.

## Mikser among static site generators

**The only SSG that's both fast enough for daily use and deep enough for AI agents to drive.**

| SSG | Speed | Feature surface | The tradeoff |
|---|---|---|---|
| Hugo | Fastest full rebuild | Minimal | Fast but limited; rebuilds everything every run |
| Eleventy | OK | Broad, no introspection | Flexible but slow at corpus scale |
| Astro | OK | Modern, framework-coupled | Tied to a frontend framework |
| Next.js SSG | meh | Full framework | Framework first, content second |
| **Mikser** | Incremental beats Hugo's full rebuild | Broad, deeply observable, AI-native | None of the speed-vs-features kind |

Every other SSG asks you to trade something — raw speed for features (Hugo), features for framework lock-in (Astro, Next), introspection for any of the above (Eleventy). Mikser doesn't make that trade. Hugo still wins a full cold rebuild — and that's worth knowing — but most cycles aren't full cold rebuilds. CI deploys, watch-mode edits, "ran mikser, nothing changed" — these are the daily case, where Mikser's persistent manifest skips what's still current while Hugo rebuilds everything from scratch. The rest of the feature surface (MCP introspection on every lifecycle phase, files-as-source-of-truth, 20-phase composability, multi-format outputs from one corpus) is what no other "fast" SSG carries.

## Acknowledgments

The earliest version of mikser was inspired by [DocPad](https://github.com/docpad/docpad) (Benjamin Lupton, with Michael Duane Mooring and Rob Loach). DocPad's "freeway, not a box" philosophy — files on disk, any pre-processor or template engine, plugin-by-convention extension — shaped how mikser started.

Mikser itself has a previous chapter: the [legacy 7.x line](https://github.com/almero-digital-marketing/mikser) (last release 2022) introduced the real-time SSG model the current engine still carries forward. The redesign dropped MongoDB for a single in-process sqlite database, modernized to Node ESM with a structured 20-phase lifecycle, added the live SSE channel that powers the framework SDKs, and replaced cluster-based rendering with a lazy worker pool. Same intent — content as files, real-time previews, multi-format output at scale — clearer foundations.

## Documentation Index

| Document                                              | Audience           | Description                                        |
| ----------------------------------------------------- | ------------------ | -------------------------------------------------- |
| [Architecture Overview](./docs/overview.md)  | Everyone           | **Start here.** End-to-end walkthrough of how a file becomes a deployed page across all lifecycle phases. |
| [Getting Started](./docs/getting-started.md) | Users              | Installation, first project, basic usage           |
| [Configuration](./docs/configuration.md)     | Users              | All CLI options and config file reference          |
| [Lifecycle](./docs/lifecycle.md)             | Users & Developers | Complete lifecycle phases and hook system          |
| [Plugins](./docs/plugins.md)                 | Users & Developers | Built-in plugins, writing custom plugins, the assets / resources / AI pipeline |
| [Entities](./docs/entities.md)               | Users & Developers | Entity model, operations, journal, catalog         |
| [Rendering](./docs/rendering.md)             | Users & Developers | Render pipeline, render plugins, render modes      |
| [Watch Mode](./docs/watch-mode.md)           | Users              | File watching, scheduled tasks, incremental builds |
| [MCP](https://github.com/almero-digital-marketing/mikser-io-mcp#readme) | Users              | The `mikser-io-mcp` plugin — tool surface, `mikser://` resources, twelve worked AI-driven scenarios |
| [Caching](./docs/caching.md)                 | Users (production) | The `cache: true` disk cache + working nginx config for reverse-proxy failover |
| [Architecture](./docs/architecture.md)       | Developers         | Module-level reference — what's in each file       |
| [API Reference](./docs/api-reference.md)     | Developers         | Complete public API reference                      |
| [Decisions (ADRs)](./docs/decisions/)        | Developers         | Load-bearing architectural choices and what protects them |

## License

MIT — see [LICENSE](./LICENSE).

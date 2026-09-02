<p align="center">
  <img src="mikser-lockup-stacked.svg" alt="mikser" width="198" />
</p>

<p align="center"><strong>The AI-native content engine.</strong></p>

# Mikser

**Mikser is the AI-native content engine.** It mixes content from anywhere — markdown files, Google Sheets, your ERP, a CMS, any API — into one live index of everything you publish, keeps track of how the pieces point at each other, and ships it to any frontend. Edit a price in your ERP or a cell in a spreadsheet, and every page that uses it updates within seconds — in whatever framework you built the site with.

Two words appear throughout, and they mean what they sound like. The **catalog** is that index: everything mikser currently knows about your content, in one place you can ask questions of. A **reference** is one piece of content pointing at another — an article at its author, a product page at the price behind it, a landing page at the photo it uses. Mikser knowing those links is what makes most of the rest possible.

**Framework-agnostic on both ends.** Headless CMSes (Sanity, Contentful) free you from the database but lock authoring into their UI. Frameworks like Astro let you bring any frontend but lock you into the framework. Mikser frees both: **any source in, any frontend out.** Small adapters turn outside systems into content sources; the catalog is served over ordinary HTTP, with [Vue](https://github.com/almero-digital-marketing/mikser-io-sdk-vue) / [React](https://github.com/almero-digital-marketing/mikser-io-sdk-react) / [Svelte](https://github.com/almero-digital-marketing/mikser-io-sdk-svelte) libraries on top that make it feel native, including live updates pushed to the browser. It's also AI-native: agents read and write that same catalog through MCP — the open standard AI assistants use to talk to outside tools — with the same calls a frontend developer makes. There's no separate "AI API" to keep in sync.

**References merge sources into one call.** Because mikser knows how the pieces point at each other, you can fetch a product page and pull its marketing copy, its price and its hero image along with it in one round-trip — even though those three came from three different systems. Change any one of them and every page that uses it updates by itself, without anything asking repeatedly whether something changed — and only the pages that actually depend on it, nothing more.

**And it can answer for what an agent did.** The reason to hesitate before letting an AI edit a real website isn't that it's hard to set up — it's *it'll break something and nobody will notice until a client calls*. Mikser is built so you don't have to take the agent's word for it: point at any text on the finished site and it tells you which file wrote it, ask before a change and it lists the pages that will be affected, and it refuses the edit outright if someone else touched the file in the meantime. [What an agent can ask](#what-an-agent-can-ask) is the short version.

**Your content stays yours.** Source files live on disk as `.md` / `.yml` — diffable, version-controllable, portable on day one and year ten. No database lock-in, no proprietary export. And it's the content layer, not your whole backend: business logic, accounts, and transactions stay in their own services; mikser handles the part that's actually content — rendered to HTML, PDF, email, and other formats from the same source.

Built for Node.js around a fixed sequence of build steps and a plugin system: every document, image and template goes through the same pipeline, and a plugin can attach to any step in it. MIT-licensed, runs on Node, zero hosted dependencies. **The portability promise is the architecture, not a feature.**

> **New to mikser?** Read the [Architecture Overview](./docs/overview.md) — one document, start to finish, on how a file becomes a published page. It's the doc most projects need first.

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

**Fast pages that still update live.** Most tools make you choose. Site generators (Hugo, Eleventy, Jekyll) produce fast pages but only change when you rebuild them; hosted CMSes (Sanity, Contentful, Strapi) update instantly but every page view waits on their API. Mikser does both: pages are published as real files, so they load fast and don't depend on anything being up, and updates arrive on top of that — an edit shows up in an open browser without a refresh.

**It only rebuilds what changed.** When a file changes, mikser works out what actually depends on it and redoes only that — not the whole site. On a site with ten thousand pages that is the difference between a rebuild you wait for and one you don't notice.

**Heavy work runs in parallel.** Pages render concurrently, and anything genuinely slow — compiling an email template, processing an image — can be moved onto separate CPU cores by adding one line to the template. HTML, PDF and email all come from the same source document.

**Asset pipelines are whatever Node can do.** Most static frameworks (Astro, Next.js, Hugo) ship image optimization and stop there — video transcoding, AI upscaling, watermarking all need a separate service. Mikser runs user-written modules over binary inputs: ~10 lines around `sharp` resize an image, ~10 around `fluent-ffmpeg` transcode a video, ~30 around the Replicate API upscale with AI. Anything an npm package can do, your pipeline can do — including pulling uploads from a DAM or CDN through the same flow.

**Everything composes.** A build is a fixed sequence of named steps, and a plugin attaches to whichever ones it needs. A search-indexing plugin, an email renderer and a PDF generator all see the same run without knowing about each other, and without any glue code holding them together.

**Run anywhere.** The same CLI handles one-shot builds, watch-mode dev loops, and a long-running HTTP server with a shared Express app. `npx mikser` ships a static site; `mikser --watch` is the dev loop; `mikser --server` exposes a live admin/API.

**Outages don't take the site down.** With a hosted CMS, the API *is* the site — when it blinks, every page errors. Mikser publishes real files to disk and layers live updates on top, so if mikser itself stops, the files keep being served. Visitors see nothing; live updates simply resume when it's back.

**Use it as a library.** Mikser doesn't have to be a command you run. You can embed the engine inside an existing Node application and drive it directly.

**Open source.** MIT-licensed, on GitHub, no telemetry, no auth wall, no SaaS dependency. What you see is what runs.

## Mix content from anywhere, ship to anywhere

A real content stack pulls from more than one system. Marketing copy lives in a CMS or a spreadsheet. Prices and stock live in an ERP. Hero images live in a DAM. Editorial pages live in markdown files in the repo. Most teams either pick one tool and contort the rest to fit it, or build sync services that copy everything into one database — and then more sync services when things drift out of sync.

Mikser is built around a different bet: **one place any source can pour into, and any frontend can read from.**

**Any source.** Small adapters let you treat outside systems as content sources. A Google Sheet, an ERP feed, a Drive folder, a Notion database, the `.md` files in your repo — each pours into the catalog in the same shape, so everything downstream treats them alike. The authoring tool doesn't change. The editorial workflow doesn't change. The team writing product copy in Google Sheets keeps writing product copy in Google Sheets — mikser just notices when they save.

**Pieces from different systems, joined.** A product page can point at a row from a spreadsheet for its copy, a record from your ERP for its price, and a photo from your asset library — and one request from your frontend returns all four together. One round trip instead of four, and no stitching code on your side to keep working.

**Live updates work the same way whatever the source.** Edit a cell in the spreadsheet, change a price in the ERP, swap a photo in the asset library — the pages that use them update within seconds, everywhere. You don't write anything to make that happen for each source; mikser already knows which pages use what.

**Your frontend is whatever you want.** The catalog is served over ordinary HTTP (and over MCP, for AI agents). You read it from React, Vue, Svelte, SvelteKit, Next.js, an iOS app, a kiosk — anything that can make a web request. The framework SDKs (`mikser-io-sdk-react`, `mikser-io-sdk-vue`, `mikser-io-sdk-svelte`) make the calls feel native, but they're optional. Headless CMSes free you from the database lock. Frameworks like Astro free you from one kind of authoring lock. Mikser frees you from both at once: **any source on the input side, any framework on the output side.**

What this looks like in practice:

- Marketing edits product copy in Google Sheets, prices come from your ERP, both flow into the same product page in your storefront — changes appear within seconds, without your e-commerce team writing webhook handlers or cache-invalidation logic.
- A SaaS pulls customer-facing release notes from `release-notes/*.md` in the repo and feature flags from LaunchDarkly; both render in a dashboard built in the team's own React stack, not a framework somebody else picked.
- A magazine pulls editorial articles from local markdown, contributor bios from Notion, sponsorship info from Airtable, and renders the same article surface across web, email (MJML), and PDF — one catalog, one set of references, three outputs.

Adding a source is mechanical. See [`mikser-io-csv`](https://github.com/almero-digital-marketing/mikser-io-csv) (any HTTP-served CSV, with live polling), [`mikser-io-provider-gdrive`](https://github.com/almero-digital-marketing/mikser-io-provider-gdrive) (Google Drive), and the built-in `http` provider for the shape. If a system has an API, it can be a mikser source, usually in well under 100 lines.

## Built for AI-assisted development

That last section was about an agent looking after a site that already exists. This one is about building one in the first place — where keeping content in files turns out to matter for a second reason: a coding assistant can read your whole project the way it reads any repository, with no database to connect to and no schema to be told about. And when it needs to write something or render a preview, it talks to the running engine directly rather than through a separate API somebody has to maintain.

**Zero infra friction for discovery.** An agent can `rg "type: product"` across the content tree to find every product doc in a second. No DB connection, no API token, no schema file to parse.

**The schema emerges from examples, not a definition file.** Front-matter shows what fields exist *in the docs that exist*. Markdown + YAML are overwhelmingly well-represented in AI training data, so the model "speaks" them fluently and infers structure from real documents better than from a schema definition.

**What happens next is predictable.** Save a file, the build runs, the output changes — no database triggers firing elsewhere, no cache clearing itself at an awkward moment, no rate limits. An assistant can reason about the result instead of guessing at it.

**The types are the documentation.** When an assistant writes frontend code against mikser, the shape of every query and response is described in TypeScript types it can read directly — which produces markedly better generated code than pointing it at API docs and hoping.

**Plugin-by-example.** Authoring a new plugin? There are 15+ existing ones in the same shape to pattern-match against. Convention is dense enough that new plugins look like the old ones without coaching.

**One-shot bootstrap via Claude Code.** The [`mikser-io-claude-plugin`](https://github.com/almero-digital-marketing/mikser-io-claude-plugin) wraps the whole setup into a single skill. Register the marketplace, install once:

```
/plugin marketplace add almero-digital-marketing/mikser-io-claude-plugin
/plugin install mikser-io-claude-plugin@mikser-io
```

…then in any Vue 3, React, or SvelteKit project — or in a blank directory — say *"add mikser to this app."* It detects the framework (or scaffolds a fresh starter via `create-vite` / `sv create`), wires the matching framework SDK without replacing your router, and optionally drops a `mikser-content/` sibling folder with Zod schemas and starter documents so the backend works on first run.

The runtime half — the agent driving the live engine, not just reading the tree — gets its own section below.

The honest caveat: this helps with **content work** — adding pages, reorganising sections, building frontends. It doesn't make mikser better at everything else in your stack; that's ordinary debugging like anywhere. And the "read the whole project at once" advantage fades past roughly ten thousand documents, where an assistant queries the catalog instead — still good, less panoramic.

## Control mikser from your AI agent

Install the [`mikser-io-mcp`](https://github.com/almero-digital-marketing/mikser-io-mcp) plugin and any MCP-speaking client — Claude Desktop, Claude Code, ChatGPT, custom agents — connects to the running engine. From inside a chat, your AI can:

- read anything in the catalog
- write new content — pages, templates, settings. The file lands on disk and the next build picks it up.
- render a page just to look at it, without publishing anything
- **show you a real interface inside the chat.** Instead of describing a change, the agent can render an actual editable panel — a form, a preview with Approve and Reject buttons — and you click it in the conversation. Pressing a button sends your answer straight back to the agent as its next step.

  You build those panels as ordinary mikser templates; there is no separate UI framework and no glue code. Under the hood they follow the [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps): the panel renders in a sandboxed frame, a click travels back as a real tool call, and if you point it at a webhook of your own, mikser forwards the action there first and uses the reply.

Plugins add to what the agent can do the same way they add web routes: install one, and the agent has new abilities. Nothing to wire up per project.

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

### What an agent can ask

When an agent changes ten files you can read them all. At two hundred you can't — and that's exactly the point where letting AI do the work starts to be worth it. Most systems leave the checking to you. Mikser lets the agent check its own work first, because the engine kept a record of what it did and can be asked about it afterwards.

**"Where did this come from?"** — point at any text on the finished site and get back the file that produced it, and the line in that file. Nothing else needs to happen: the engine noted it while building. Without this, finding which file writes a particular button means opening the site in a browser, poking at the page source and guessing at filenames.

**"What else is using this?"** — before removing a photo, a page or a person, ask what still points at it. The answer is a list, not a search that might have missed something.

**"What will this change touch?"** — ask before writing, not after. You get back the pages that would be rebuilt and why each one — so nobody discovers on Monday that editing a shared snippet quietly changed forty pages.

**"Did it actually work?"** — the site as it really is on disk, compared against what the engine believes it published. "The build said it succeeded" and "the site is actually up to date" are two different claims, and this checks the second one.

Alongside those: search the whole site for anything that still reads the old way, and — because everything is ordinary files — the same change history and one-command rollback your developers already use for code.

What this changes: reviewing AI work stops being *read every single change* and becomes *spot-check where the agent was least sure.*

### What stops an agent breaking your site

The other half is the engine saying no. Not politely stepping aside — actually refusing to do things it can tell are wrong:

- **It won't overwrite somebody else's work.** If a person, or another agent, changed the file since this one read it, the edit is refused rather than quietly replacing what they wrote.
- **Undo takes back one piece of work, not everything since.** Documents added afterwards stay. And if taking a change back would leave a link pointing at a page that no longer exists, it refuses — even though the file change itself would have gone through fine. That broken link is the failure nobody spots until it's live.
- **Nothing is deleted quietly.** A delete first lists what still points at the thing being removed. Uploaded files go to a recycle folder rather than being erased, so a wrong call is recoverable.
- **People only get the parts of the site they should have.** You decide who may change the words, who may change the design, who may do both. When an agent hits that boundary it doesn't just fail — it says which role could do the thing, which is a sentence the person can forward to whoever can. That's the difference between a dead end and a handoff.
- **If something is broken, it says so.** "No results" because a feature has failed and "no results" because there genuinely aren't any look identical everywhere else. Here, the agent can tell which one it's looking at — and so can you.

Full tool reference and twelve worked scenarios in the [`mikser-io-mcp` plugin docs](https://github.com/almero-digital-marketing/mikser-io-mcp#readme).

## The handoff

The shape this is built for: a developer builds the site, hands it to the client, and the client points their own agent at it. From then on changes happen inside the structure that was designed, rather than the agent reinventing it.

What makes that work is that the boundary is real, not a convention everyone agrees to respect. You decide which parts of the site each kind of person may change — the words, the pictures, the design, the templates — and you write the description of each role in your own words. Mikser hands that description to whoever is asking. A site might describe its editor role as:

> Pages, text and images. Can read the templates and styles to see how a page is built, but not change them — so nothing edited here can break the site.

An agent connecting as that role sees exactly that sentence, what it may change, what it may only look at, and what the other roles on the site can do. When it reaches the edge of what it's allowed, it stops and names the role that could do the thing instead — so the answer is *ask your developer about the design system*, not a blank error the agent might try to route around. There is no way for it to ask for more access, and there won't be.

So the developer's structure holds because the engine holds it, the client gets an agent that can genuinely change the content, and when something is out of bounds you get a sentence with a name in it rather than a broken page nobody noticed.

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
- **Multilingual publishing** — link to a page by what it *is*, and each language gets the right URL automatically. One source tree, many language sites.
- **Large product catalogues** — product listings that update live, search by meaning rather than exact words, and pre-built data files a CDN can serve — from the same source.
- **AI-assisted media handling** — upscale images, transcribe audio, transcode video, on the way in. The pipeline is ordinary JavaScript, so anything Node can do is available to it.
- **One source, several formats** — the same document becomes a web page, a PDF and an email, all from one edit.
- **A content backend for a frontend you already have** — serve it live over HTTP, or export flat files for any static host.

The shape mikser **doesn't** fit cleanly: anything with non-technical content authors who can't or won't work with files, anything with non-content business logic at the core, anything needing multi-tenant / per-user auth. Those aren't bugs — they're outside the design envelope. See [`decisions/0001-content-layer-not-the-app.md`](./docs/decisions/0001-content-layer-not-the-app.md) for the explicit scope decision.

## Engineering discipline

What you get from how this project is built:

- **Every load-bearing decision has an ADR.** The [`decisions/`](./docs/decisions/) folder names which choices are structural — files-as-source, journal+catalog split, plugin-as-factory, when something goes in core vs. ships as a plugin — and explains what protects them. When you push against one, there's a written answer waiting instead of folklore.
- **Engine stays small; capability ships in plugins.** The 15+ plugin ecosystem adds features without core changes, so your upgrade cost stays low. Probes like `decap` (a full third-party CMS mounted in ~150 lines, zero engine changes) are deliberate evidence the extension model holds where it counts.
- **Builds are deterministic; no async middleware layer.** The journal is the only synchronization primitive — no event bus, no IoC container, no orchestrator running plugins in surprising order. The lifecycle is a list of named phases; "what ran when?" has an answer you can read off the source.
- **The whole engine is one read.** The [Architecture Overview](./docs/overview.md) walks the full pipeline top to bottom. Onboarding a new engineer is an afternoon, not a tour through fifteen reference docs.

## Mikser among static site generators

Mikser is often evaluated against static site generators, so here is the honest placement. **It does not win on speed** — Hugo does, and that is worth knowing. What mikser has that none of them do is a build the engine can answer questions about afterwards.

| SSG | Speed | Feature surface | The tradeoff |
|---|---|---|---|
| Hugo | Fastest full rebuild | Minimal | Fast but limited; rebuilds everything every run |
| Eleventy | OK | Broad, no introspection | Flexible but slow at corpus scale |
| Astro | OK | Modern, framework-coupled | Tied to a frontend framework |
| Next.js SSG | meh | Full framework | Framework first, content second |
| **Mikser** | Fast enough that watch-mode rebuilds feel instant | Broad, and queryable after the fact | Not the fastest cold build |

Hugo wins a full cold rebuild. Most cycles aren't full cold rebuilds — CI deploys, watch-mode edits, "ran mikser, nothing changed" — and there the persistent manifest skips what is still current. But speed is not the axis worth choosing mikser on, and a reader who evaluates it as a faster SSG will miss what it is for.

**The comparison that actually matters is different.** If you are handing a site to someone whose agent will edit it, the real alternative is a headless CMS with an MCP wrapper: structured content, and no way to check what the agent did to it. That is the gap [What an agent can ask](#what-an-agent-can-ask) describes, and it is not a speed question.

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
| [Diagnostics](./docs/diagnostics.md)         | Users & Developers | **"Why did it do that?"** — `--explain`, `--json`, `--audit-output`, the sqlite tables, and every introspection surface, indexed by the question it answers |
| [MCP](https://github.com/almero-digital-marketing/mikser-io-mcp#readme) | Users              | The `mikser-io-mcp` plugin — tool surface, `mikser://` resources, twelve worked AI-driven scenarios |
| [Caching](./docs/caching.md)                 | Users (production) | The `cache: true` disk cache + working nginx config for reverse-proxy failover |
| [Architecture](./docs/architecture.md)       | Developers         | Module-level reference — what's in each file       |
| [API Reference](./docs/api-reference.md)     | Developers         | Complete public API reference                      |
| [Decisions (ADRs)](./docs/decisions/)        | Developers         | Load-bearing architectural choices and what protects them |

## License

MIT — see [LICENSE](./LICENSE).

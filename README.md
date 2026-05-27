<p align="center">
  <img src="mikser-lockup-stacked.svg" alt="mikser" width="198" />
</p>

# Mikser

Mikser is a content engine for Node.js built around a strict lifecycle, a composable plugin system, and direct control over every output. Every document, asset, and template flows through the same deterministic pipeline. Plugins hook in at any phase; nothing runs outside the cycle. It scales from a single markdown blog to a multi-language, multi-format publishing platform — and stays predictable in both directions.

## Why mikser

**Your content stays yours.** Source files live on disk as `.md`, `.yml`, `.html` with YAML front-matter. The build output is plain static files. No database lock-in, no proprietary export format. The whole content tree is copyable, diffable, and version-controllable with git — your site is portable on day one and on year ten.

**Incremental builds that scale.** Mikser tracks every entity in a journal. When a file changes, only the affected entities re-process — not the whole site graph. On 10k+ documents this dramatically outpaces tools that rebuild more on every change.

**Concurrent rendering.** Renders fan out across a worker pool that keeps every CPU core hot. Multi-format outputs (HTML, PDF, MJML email, etc.) generate in parallel from the same source.

**One lifecycle, everything composes.** Plugins hook into 20+ named lifecycle phases. A search-indexing plugin shares the same journal iteration as a CMS plugin and an email-rendering plugin — no glue code, no orchestration layer.

**Run anywhere.** The same CLI handles one-shot builds, watch-mode dev loops, and a long-running HTTP server with a shared Express app. `npx mikser` ships a static site; `mikser --watch` is the dev loop; `mikser --server` exposes a live admin/API.

**Library mode.** Mikser is also a library. `useRenderer`, `useCollection`, `findSimilar`, and direct lifecycle hooks let you embed the engine inside an existing Node app instead of running it as a CLI.

**Open source.** MIT-licensed, on GitHub, no telemetry, no auth wall, no SaaS dependency. What you see is what runs.

## Plugin ecosystem

Plugins are independent npm packages — install only what a project actually uses.

| Plugin | What it does |
|---|---|
| `documents`, `files`, `resources`, `assets` | Content sources |
| `layouts` | Layout resolution with auto-matching |
| `render-hbs`, `render-eta`, `render-liquid`, `render-markdown` | Template engines |
| `render-resource`, `render-asset`, `render-href` | Resource / asset / link rewriting at render time |
| `post-pdf` | HTML → PDF via headless Chromium |
| `post-mjml` | MJML email markup → inbox-safe HTML |
| `data` | JSON snapshots of entities / context / catalog over HTTP |
| `api` | REST endpoints — list / get / create / update / delete / render |
| `vector` | OpenAI embeddings + semantic search (sqlite-vec or pgvector) |
| `decap` | [Decap CMS](https://decapcms.org/) mounted in the same process |
| `archive`, `mapper`, `live`, `whitebox`, `aml` | Specialty integrations |

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

## Documentation Index

| Document                                              | Audience           | Description                                        |
| ----------------------------------------------------- | ------------------ | -------------------------------------------------- |
| [Getting Started](./documentation/getting-started.md) | Users              | Installation, first project, basic usage           |
| [Configuration](./documentation/configuration.md)     | Users              | All CLI options and config file reference          |
| [Lifecycle](./documentation/lifecycle.md)             | Users & Developers | Complete lifecycle phases and hook system          |
| [Plugins](./documentation/plugins.md)                 | Users & Developers | Built-in plugins, writing custom plugins           |
| [Entities](./documentation/entities.md)               | Users & Developers | Entity model, operations, journal, catalog         |
| [Rendering](./documentation/rendering.md)             | Users & Developers | Render pipeline, render plugins, render modes      |
| [Watch Mode](./documentation/watch-mode.md)           | Users              | File watching, scheduled tasks, incremental builds |
| [Architecture](./documentation/architecture.md)       | Developers         | System design, module structure, extension points  |
| [API Reference](./documentation/api-reference.md)     | Developers         | Complete public API reference                      |

## License

MIT — see [LICENSE](./LICENSE).

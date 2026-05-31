# Architecture Overview

A narrative walkthrough of how content moves through mikser, top to bottom. This is the "read this first" document — companion to [`architecture.md`](./architecture.md) (module-level reference) and [`plugins.md`](./plugins.md) (per-plugin reference). If you've used mikser without quite knowing what's happening inside, this is the doc that answers that.

## A working mental model

Mikser does one thing: it takes **inputs** (files, external resources, API pulls) and produces **outputs** (rendered HTML, JSON snapshots, HTTP endpoints, asset variants) through a strict lifecycle. Every piece of state has a name and a phase that owns it.

Three things to hold in your head:

1. **The catalog** — the persistent registry of every entity that exists. Think: *the truth*. lowdb-backed JSON on disk.
2. **The journal** — the ephemeral log of operations to apply. Think: *what changed since last cycle*. SQLite-backed.
3. **The lifecycle** — twenty-some named phases that fire in order. Plugins hook into phases. The engine doesn't decide what runs; the phases decide when.

The journal feeds the catalog. The catalog feeds rendering. Rendering writes files. Plugins read from the journal at every phase to do their work. Everything else in this document follows from those three.

## A single document, end to end

Walk through what happens when you save `documents/en/articles/launch.md`:

```
editor save
    │
    ▼
chokidar fires           ◄── manager.js
    │
    ▼
onSync hooks resolve     ◄── documents plugin reads file, computes
    │                        checksum, calls updateEntity()
    ▼
UPDATE → journal         ◄── SQLite row written
    │
    ▼
debounce 1000ms          ◄── more saves coalesce into one cycle
    │
    ▼
runtime.process()        ◄── mutex.use() — serialized
    │
    ├── PROCESS phase
    │     • front-matter plugin extracts the YAML block
    │     • layouts plugin matches meta.layout → layout file
    │     • mikser-io-plugin-schemas validates meta against schemas/article.js
    │     • mapper plugin runs user transforms
    │
    ├── PERSIST phase
    │     • catalog.js applies journal entries to lowdb
    │     • the entity is now "official"
    │
    ├── beforeRender phase
    │     • render-href builds the link rewrite index
    │     • render-asset registers asset URLs
    │     • mikser-io-vector embeds the entity, upserts to its store
    │     • data plugin writes its query-based JSON snapshots
    │     • plugins write RENDER entries into the journal
    │
    ├── RENDER phase
    │     • engine reads RENDER entries → dispatches to worker threads
    │     • workers run the matched template (hbs / eta / liquid / markdown)
    │     • output → out/<route>.html
    │
    ├── POSTPROCESS phase
    │     • post-pdf converts HTML → PDF (separate Piscina pool)
    │     • post-mjml converts MJML → inbox-safe HTML
    │
    └── finalize / finalized
          • data plugin writes catalog-wide JSON
          • mikser-io-plugin-schemas re-emits entities.d.ts if anything changed
          • progress bars stop, run timing logged

API (in --server mode)
    │
    ▼
api plugin's Express router
    • /api/<endpoint>/entities          (list / query)
    • /api/<endpoint>/entities/:id      (get one)
    • /api/<endpoint>/entities/subscribe (SSE — pushes the update)
    │
    ▼
sdk-api client.live() callback fires
    │
    ▼
useDocument() in the Vue app updates its ref
    │
    ▼
DOM updates
```

That's the full path from "save in editor" to "DOM updates in browser" — about twenty phases, ten plugins, all coordinated by **one journal**. Nobody pushes events around; the journal is the synchronization primitive.

## What goes where

The most common confusion when starting out is *which artifact lives where, at which phase, owned by what*. The honest answer in one table:

| Concern | Lives in | Read by | Lifecycle owner |
|---|---|---|---|
| Source content | `documents/` as files | `documents` plugin | `onImport` |
| External media | `resources/` (downloaded) | `resources` plugin | `onImport` |
| Asset variants | `assets/<preset>/` (preset outputs) | `assets` plugin | `onRender` |
| Persistent entity registry | `catalog.json` | `catalog.js` | `onPersist` |
| Per-cycle operations | `journal.sqlite` | every plugin | every phase |
| Front-matter schemas | `schemas/` | `mikser-io-plugin-schemas` | `onValidate` |
| Rendered HTML | `out/<route>.html` | post plugins + http server | `onRender` |
| JSON snapshots | `out/api/*.json` (data plugin) | static serving / SDK build mode | `onFinalize` |
| Live HTTP/SSE | `api` plugin's Express router | `sdk-api`, `sdk-vector` clients | `onLoaded` + runtime |
| Vector embeddings | sqlite-vec or pgvector | `sdk-vector` clients | `onBeforeRender` |
| TypeScript declarations | `entities.d.ts` | client projects | `onFinalized` |

If a reader has to assemble this from each plugin's individual docs they spend their first hour confused. This table is the answer.

## Render-time vs query-time vs build-time

A common question when wiring up a frontend: *"My Vue app needs a list of articles — where does the list come from?"* Mikser gives you three options that read the same data from three vantage points. They're not alternatives; they coexist on most projects.

**Build-time JSON (`data` plugin).** Writes static `.json` files at the `finalize` phase. The Vue app fetches them at runtime, but the server doesn't have to be up for them to work — they're just deployment artifacts.
*Right when:* the consuming frontend is itself static (CDN-served, no backend at all). Live updates aren't a requirement.

**Runtime HTTP (`api` plugin).** Express endpoints serve from the catalog on demand. SSE keeps every connected client in sync — `sdk-api`'s `client.live()` is the consumer-side primitive.
*Right when:* the frontend needs live updates, content changes between builds, or different consumers want different filter / projection / token shapes.

**Render-time embedding (templates).** Runtime helpers like `find()`, `findOne()` in Handlebars / Eta inline content directly into the rendered HTML at the `render` phase. The page ships with the content baked in.
*Right when:* the consuming surface doesn't query at all — listing pages, marketing pages, anything that's "snapshot the catalog at render time."

A project can use all three for different views — the data plugin for a CDN-hosted news feed, the API for a logged-in editor view, render-time embedding for the homepage. They all read from the same catalog. The choice is per consumer, not per content.

## Five layers, three SDKs

The architecture stacks cleanly for client consumers:

```
┌──────────────────────────────────────────────┐
│  Vue component                                │
│  uses useDocument(id) from sdk-vue           │
└──────────────────────────────────────────────┘
            │ injects EntitiesClient
┌──────────────────────────────────────────────┐
│  mikser-io-sdk-vue                           │
│  composables, vue-router integration,        │
│  href() / asset() / alternates               │
└──────────────────────────────────────────────┘
            │ peer-deps
┌──────────────────────────────────────────────┐
│  mikser-io-sdk-api                           │
│  client.entities(name).list/query/subscribe/ │
│  render/update/delete                        │
│  Mongo-style filter dialect (sift)           │
└──────────────────────────────────────────────┘
            │ HTTP + SSE
┌──────────────────────────────────────────────┐
│  api plugin (Express router in the engine)  │
│  per-endpoint tokens, operations,            │
│  on-demand rendering                         │
└──────────────────────────────────────────────┘
            │ findEntities()
┌──────────────────────────────────────────────┐
│  catalog + journal                           │
│  the engine                                  │
└──────────────────────────────────────────────┘
```

Two parallel chains layer on top of the same engine:

- **Vector search** — `sdk-vector` → `mikser-io-vector` → embeddings store (sqlite-vec or pgvector).
- **Schemas / types** — `schemas/` Zod modules → `mikser-io-plugin-schemas` → `entities.d.ts` → `sdk-vue`'s `useDocument<T>`.

Each chain is independent. A project that doesn't need semantic search drops `sdk-vector` and pays nothing for it. A project that doesn't type its frontend skips `mikser-io-plugin-schemas` and the engine works identically.

## How extension actually works

When someone says "mikser is plugin-based," what they actually mean is:

1. The engine knows how to fire lifecycle phases in order.
2. Plugins register callbacks on phases via `onXxx` hooks.
3. The engine has **no other coupling** to plugins.

That's the entire extension model. There's no plugin manifest, no service registry, no IoC container. A plugin is a factory function. The factory receives the public API and returns nothing — its registered hooks do all the work.

This is why the Decap CMS integration is ~150 lines. There's no Decap-specific lifecycle phase. There's no "CMS plugin API." Decap is mounted as Express middleware inside the same shared app the `api` plugin uses, scheduled via `setInterval` to bake content to `out/`, with no engine awareness that any of this is happening. The lifecycle was already open enough.

The same is true for every plugin shipped against mikser to date. `mikser-io-plugin-schemas` doesn't extend the lifecycle — it hooks `onValidate` (which existed already), watches a folder via `watch()` (which existed already), and emits a file at `onFinalized` (which existed already). The plugin layer is the seam; the engine is what stays small.

That's why ADR-0003 (*Plugins independent, engine stable*) is load-bearing.

## Watch mode is the same path, just thinner

Watch mode is not a different code path. It's the same `runtime.process()` cycle, fired more often and with cancellation in the mix:

```
chokidar event → onSync hook → journal entry → debounce 1s → process()
                                                              │
                                                  if a previous process()
                                                  is in flight: abort it
                                                  via AbortController,
                                                  then mutex.use() the new run
```

The mutex guarantees only one cycle runs at a time. The AbortController lets a slow cycle (a big PDF generation) be interrupted by a newer edit without leaving partial state. Hooks check `signal.aborted` and throw `AbortError`; the lifecycle catches it cleanly. This is what makes "save → see the change" feel instant even when individual renders are heavy.

## ADRs — the why behind these choices

Some decisions look ordinary on inspection but are load-bearing — change them and a lot breaks downstream. The [`decisions/`](./decisions/) folder documents which choices are load-bearing and what protects them.

| ADR | Decision |
|---|---|
| [0001](./decisions/0001-content-layer-not-the-app.md) | Mikser is the **content layer**, not a backend. Business logic stays in your app. |
| [0002](./decisions/0002-files-as-source-of-truth.md) | Files are the **source of truth**, not a database. Portability and grep-ability are non-negotiable. |
| [0003](./decisions/0003-plugins-independent-engine-stable.md) | The engine stays small; plugins do the work. Adding a plugin must not require changing the engine. |
| [0004](./decisions/0004-compose-via-protocols.md) | Plugins compose via the journal, not via direct calls. Coupling stays loose by design. |

Read the ADRs before proposing a feature that pushes against one. They're short.

## Where to go from here

| Doc | When to read it |
|---|---|
| [`architecture.md`](./architecture.md) | Module-level reference — *what's in each file*. Read after this one. |
| [`lifecycle.md`](./lifecycle.md) | Every phase, every hook, in detail. The phase reference. |
| [`plugins.md`](./plugins.md) | Per-plugin reference — every built-in plugin documented, including the [assets / resources pipeline](./plugins.md#assets) end-to-end example. |
| [`entities.md`](./entities.md) | The entity model — fields, lifecycle, journal vs catalog. |
| [`rendering.md`](./rendering.md) | How the render pipeline works, including worker threads. |
| [`watch-mode.md`](./watch-mode.md) | Watch mode in detail — sync hooks, debounce, cancellation. |
| [`api-reference.md`](./api-reference.md) | The full public API surface. |
| [`getting-started.md`](./getting-started.md) | If you haven't installed mikser yet, start here instead. |

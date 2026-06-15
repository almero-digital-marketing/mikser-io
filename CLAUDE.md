# CLAUDE.md — mikser-io

Read this before proposing changes. Posture, architectural conventions,
and the landmarks that survive across sessions.

## Posture

**Until v10, mikser has no users.** No back-compat. No deprecation
paths. No migration markdown. No `task: pool` legacy aliasing for
`task: inline`. Update READMEs and ADRs in place as source-of-truth
changes; rewrite, don't supersede. The freedom is the point.

**v9 has to pay out before v10 starts.** Not "ship v9 and start v10."
**Use v9 in real daily work until the workflow pays out**, then
v10. The v10 architecture (party-mikser-io) is more fun to design
than v9 documentation is to write — the gate exists because that
asymmetry kills projects. Concrete pass/fail signals in
`10.0-PLAN.md` under "The gate." If a session brings up v10 design
work, check the gate first; if v9 isn't paying out yet, the
question to answer is "what about v9 isn't working in daily use?"
— not "what should v10 look like?"

**mikser is a mixer.** The name is the architecture. It combines
inputs (entities — from files, forms, queries, anywhere) through
configurable rendering pipelines (renderer plugins + task-production
policies) into outputs of any kind. Static-site generation is the
canonical recipe — what mikser ships with and what most projects
use today — but it's a recipe, not the definition. The same
substrate runs:

- HTML SSG via `layouts` + `renderHbs` (the recipe everything else
  is currently shaped around)
- PDFs via `renderHbs` + `post-pdf` (puppeteer-driven)
- Emails via `renderHbs` → `post-mjml` → `post-email` (chain)
- 3D renders by composing a hypothetical `renderBlender` against
  `.blend` entities — same engine, different renderer + recipe
- Video / audio / archives / data-export — same shape

The engine has no opinion on what a renderer produces. `render.js`
and `postprocess.js` are abstract worker entries; `manifest.js`
tracks snapshots of *any* output; refs invalidation re-runs
*any* render task. SSG is the dominant case in v9 because it's
where the dogfooding lives, not because the architecture only
fits there. When proposing changes, hold the broader view: a
change that helps SSG but blocks the Blender/video/audio/archive
cases is constraining the engine's actual reach.

**Position mikser by what it is, not by speed.** Hugo wins the
speed race for SSG specifically; mikser doesn't compete there
(and "fastest mixer" isn't a useful claim because the bottleneck
is the renderer, not the engine). Secondary attributes that
follow from the mixer framing: AI-native, lifecycle-observable,
files-as-source-of-truth, full-cycle introspection. Speed claim
cap: "fast enough that watch-mode rebuilds feel instant." Honest
range: 200–800 docs/sec on the SSG-flavor pipeline depending on
corpus size (see `test/perf/`).

**Direct critique preferred.** Skip "great question," skip "solid but,"
skip softening. When something didn't pay off, say so. Match user
brevity.

## Module map (`src/`)

- `runtime.js` — singleton, holds engine state (`runtime.catalog`,
  `runtime.refs`) and `runtime.options`. Lifecycle hook arrays live
  here.
- `lifecycle.js` — hook registration: `onLoad`/`onLoaded`/`onProcess`/
  `onProcessed`/`onPersist`/`onBeforeRender`/`onRender`/`onAfterRender`/
  `onBeforePostprocess`/`onPostprocess`/`onComplete`/`onFinalize`/
  `onFinalized`/`onCancel`/`onCancelled`. Plus `runtime.create`/
  `.update`/`.delete` (journal helpers).
- `journal.js` — per-cycle queue, persisted to `mikser_journal` rows in
  `runtime/mikser.sqlite`. Drained at onFinalized; survives crashes so
  `--resume` (`-R`) can pick up unfinalized entries on the next start.
  Same public surface: `addEntry`/`addEntries`/`updateEntry`/
  `useJournal`/`clearJournal`. Inserts `JSON.stringify` the row body for
  snapshot isolation (replaces the prior `structuredClone`). Walks are
  chunked (`CHUNK_SIZE=500`) so peak journal memory stays bounded
  regardless of corpus.
  **Auto-persist:** `useJournal` diffs the yielded entity after each
  iteration and UPDATEs the row if it changed. Plugin authors mutate
  the yielded entity and move on — no explicit `updateEntry({id,entity})`
  required. `updateEntry` is still exported for engine-internal writes
  (output, deps) and as a no-op safety valve for plugins that prefer to
  call it; if the entity hasn't drifted, the auto-persist skips.
- `catalog.js` — entity persistence in the `mikser_entities` table of
  `runtime/mikser.sqlite`. Indexed columns: id (PK), collection,
  type, format, name, meta_href, meta_layout, meta_lang, meta_cache,
  time, uri. Full entity body in `data` (JSON TEXT). 10k-entry LRU
  cache in front of `findById`. Public ops: `findEntity`,
  `findEntities`, `iterateEntities` (streaming async generator over the
  same query shape, seek-paginated — use it when results may be
  corpus-scale and the caller doesn't need an array), `queryEntities`,
  `readEntity`, `subscribe`, `assertExpand`. Expand internals
  (`expandLimits`, `expandAndProject`, `findRef`) are PRIVATE.
- `subscriptions.js` — `subscribe()` primitive. Two modes: journal-
  walk dispatch (default) and graph dispatch via
  `runtime.refs.subscribeGraph` (when `expand` is set).
- `refs.js` — inverse-reference graph (`$`-keyed refs per ADR-0007).
  Persisted as `mikser_refs` rows with FK to `mikser_entities`
  (`ON DELETE CASCADE`). Indexed on `target` and `source`. Exposed
  at `runtime.refs.*`: `inboundFor`, `outboundFor`, `allRefs`,
  `size`, `rename`, `subscribeGraph`, `inverseClosureOf`. Plus
  `refExists` module-level. Prepared statements through the shared
  sqlite handle.
- `engine.js` — `setup()`, lifecycle wiring, render + postprocess
  dispatchers, manifest tracking. Owns the Piscina worker pools
  (`renderWorkers`, `postprocessWorkers`); both are lazy
  (`minThreads: 0` + `idleTimeout: 30_000`) so INLINE-only workloads
  pay no worker overhead. `workerSafeOptions(runtime.options)`
  strips plugin-surface functions before TASKS.WORKER dispatch so
  Piscina's structured clone doesn't choke. Renderer / postprocessor
  descriptors in `runtime.options.plugins` are projected to their
  `render-${name}` / `post-${name}` identifier so workers can
  resolve them via dynamic import.
- `database/` — `createSqliteDatabase()`, `registerSchema()`,
  `useDatabase()` (the `mikser_meta` table stamps schema_version).
  `sift-to-sql.js` translates sift filters to SQL WHERE clauses
  against `INDEXED_COLUMNS`; un-pushed clauses fall through to
  JS-side sift. `query-context.js` is the AsyncLocalStorage that
  lets catalog queries auto-report into the render-time `track`.
- `manifest.js` — render snapshots in `mikser_snapshots` table
  (PK `(id, destination)`, `refClosure` as JSON, partial index on
  `parent`). `recordedHashes` aggregates dep hashes via
  `json_each` in C rather than parsing every row in JS.
- `server.js` — Express bring-up: CLI flags (`--server`, `--cors`,
  `--no-cors`), trust-proxy, CORS (with extensible header arrays for
  plugins to push onto), late-binding static mount + listen.
- `logger.js` — pino + pino-pretty (inline) + gauge progress + custom
  Writable for progress coordination + `pino.multistream` for
  third-party shipping. Two registration surfaces for transports:
  - `runtime.config.logging.transports` — declarative; user config.
  - `addLogTransport({ target, options?, level? })` — public export;
    plugins call this from their factory (queues until logger build)
    or any later hook (live-rebuilds the multistream + swaps
    `runtime.engine.logger`). `useLogger()` reads the swap-target
    fresh on each call so new transports start receiving records
    immediately. Both surfaces compose; same `{level, target, options}`
    shape. Enables Better Stack / Datadog / Loki / Axiom / Sentry as
    standard sibling plugins without engine changes per vendor.
- `utils.js` — shared pure helpers: `mimeForEntity`, `isLoopback`,
  `expandEntity`, `projectMeta`, `useCollection`, `useRenderer` (via
  render.js), `isTextEntity`, `readEntityContent`, `extractRefs`,
  `isRefKey`, `writeEntity`, `matchEntity`, `getFormatInfo`,
  `changeExtension`, `checksum`, `normalize`, `formatErrorContext`,
  `formatLogArgs`, `ExpandError`, `AbortError`.
- `render.js` / `postprocess.js` — Piscina worker entry points AND the
  default-export functions the INLINE/SERIAL dispatcher calls directly.
  Each receives entity + options + config + state; the WORKER path also
  receives a MessageChannel `port` that forwards pino records back to
  the engine's logger. Each worker opens its own read-only sqlite
  handle on first task (`ensureWorkerDb` in render.js) so template
  helpers like `runtime.lookupHref` stay sync. Never touch the journal
  directly. Plugin loading: main-thread INLINE dispatch reads
  `runtime.renderers` / `runtime.postprocessors` first (populated by
  plugins.js from descriptor returns); workers see empty registries
  in their separate-process runtime and fall through to dynamic-import
  by `mikser-io-${name}` package name. Per-plugin options flow through
  `descriptor.options` and arrive as the `config` arg to
  `load`/`render`/`setup`/`postprocess`/`teardown`.
- `config.js` — loads `mikser.config.js` at `onLoad` into
  `runtime.config`. v9 holds only engine-level keys (`server`,
  `logging`, `catalog` if tuned) plus the `plugins` array — all
  plugin options moved to the factory call site (ADR-0010).
- `plugins.js` — dispatches v9 plugin entries at `onLoad`. Each
  entry in `plugins: []` is a factory call return; the dispatcher
  duck-types on shape:
  - function → lifecycle plugin; called with `core` so it can
    register hooks.
  - `{ name, options, load?, render? }` → renderer descriptor;
    stored in `runtime.renderers`.
  - `{ name, options, postprocess, output?, setup?, teardown? }` →
    postprocessor descriptor; stored in `runtime.postprocessors`.
  Strings produce a v9 migration error pointing at the new shape.
- `manager.js` — file watching (chokidar) and cron scheduling.
- `source.js` — `useSource` codifies the folder-of-files pattern.
- `constants.js` — `OPERATION` (CREATE/UPDATE/DELETE/RENDER/
  POSTPROCESS), `ACTION` (sync action types), `TASKS` (`INLINE`/
  `SERIAL`/`WORKER` — dispatch modes).

## Canonical sibling plugins

These ship as separate repos but most projects pull them in. They're
not bundled because the engine is renderer-agnostic — each plugin
encodes a particular recipe (SSG, MJML, PDF, email) rather than
substrate.

- **`mikser-io-layouts`** — the canonical SSG-flavor task-production
  policy. Owns multi-match layout assignment (`meta.layout` /
  `meta.layouts` dual key + `autoLayouts` peel ladder), per-layout
  destination Handlebars templates, collision detection, postprocess
  chain parsing (filename `name.html-mjml-email.hbs` → `postprocessors:
  ['mjml','email']` + frontmatter `postprocessor`/`postprocessors`),
  `inspect()` primitive at `runtime.options.layouts.inspect`. The
  engine has no opinion on layouts; this plugin is one way of producing
  render tasks. Other domains (3D rendering, video) would have their
  own task-production plugins.
- **`mikser-io-render-{hbs,liquid,eta,markdown,metatext}`** — renderer
  plugins. `renderHbs` is bundled in core; the rest are siblings.
- **`mikser-io-post-{mjml,pdf,email}`** — postprocessor plugins,
  composable in chains (see `documentation/rendering.md#postprocess`).
- **`mikser-io-mcp`** — AI tooling surface (ADR-0006 test #5).
- **`mikser-io-vector`** — vector index over the catalog.
- **`mikser-io-forms`** — HTTP form receivers → entities.
- **`mikser-io-schemas`** — TypeScript type generation from entity meta.

## Plugin map (`src/plugins/`)

- `documents` — file→entity sync for the documents collection
- `files` — file→entity sync for the files collection
- `assets` — asset references and copy
- `resources` — resource references
- `front-matter` — YAML frontmatter extraction (HTML/MD files)
- `yaml` — YAML format support (.yml/.yaml entities)
- `json` — JSON format support
- `api` — HTTP catalog access. Pure transport — exposes nothing on
  `runtime.options.*`. Per-query disk cache.
- `preview` — in-memory render cache + GET /preview/:filename route.
  Exposed at `runtime.options.preview = { store, get, stats, config }`.
- `data` — JSON snapshots of entities/context/catalog to disk
- `observer` / `mapper` / `validator` / `commands` / `shares` —
  utility plugins

## Built-in content providers (`src/plugins/providers/`)

The substrate-side `readEntityContent(entity)` dispatches by URI
scheme. Two schemes are handled inline by built-in providers
(no separate package required, ships with mikser-io):

- **No scheme / plain path / `file://`** — filesystem read. Lives
  inline in `src/utils.js readEntityContent` because the engine
  already touches the filesystem everywhere.
- **`http://` / `https://`** — `src/plugins/providers/http.js`.
  Conditional GET with ETag + Last-Modified, in-memory response
  cache, inflight coalescing on the same URL, binary mirror to
  `runtime/http-cache/<sha-of-url>.<ext>`, operator-supplied
  headers via `entity.meta.httpHeaders`, configurable timeout via
  `entity.meta.httpTimeoutMs`. Test affordance:
  `__resetHttpCacheForTests()` clears the module-level caches
  between unit tests.

Any other scheme (`gdrive://`, `notion://`, `s3://`, …) routes
through the dynamic-import-by-name path — `mikser-io-provider-<scheme>`
must be installed as a sibling package and export a top-level
`read(entity)` function. See ADR-0010 / the gdrive provider for
the convention.

## Naming conventions

- **Engine state** at `runtime.<name>` — `runtime.refs`, `runtime.catalog`.
- **Plugin surfaces** at `runtime.options.<plugin>` —
  `runtime.options.preview`, `runtime.options.layouts.inspect`.
- **Reachability:** `runtime.options.url` is the engine's resolved
  public URL (from `--url` or `config.url`, trailing slash stripped,
  validated). Plugins that need external reachability — webhook
  receivers, absolute links in emails, MCP preview URLs returned to
  agents, forms share links — read this. Standard gating pattern:
  ```js
  const canPush = runtime.options.url?.startsWith('https://')
  if (canPush) registerWebhookAt(`${runtime.options.url}/api/X/webhook`)
  else         setupPollingFallback()
  ```
  `runtime.options.port` is the internal listener port (kept for
  loopback/dev URL building); `runtime.options.url` is the external
  origin. When in doubt: external = `url`, internal = `port`.
- **Engine functions** as module-level exports from `mikser-io`:
  `import { queryEntities, subscribe, useRenderer, useCollection,
  readEntityContent, isTextEntity } from 'mikser-io'`.
- **Plugin packages**: `mikser-io-<name>` (mikser-io-mcp, mikser-io-vector,
  mikser-io-schemas, etc.). Each exports a v9 named factory in
  camelCase: `import { vector } from 'mikser-io-vector'`,
  `import { renderHbs } from 'mikser-io'`. Consumer uses
  `plugins: [vector({...})]` — never the bare string.
- **MCP tools**: `mikser_<verb>` or `mikser_<subsystem>_<verb>`:
  `mikser_query_entities`, `mikser_read_entity`, `mikser_update_entity`,
  `mikser_delete_entity`, `mikser_render`, `mikser_refs_inbound`,
  `mikser_refs_outbound`, `mikser_refs_broken`, `mikser_refs_rename`,
  `mikser_layouts_inspect`, `mikser_preview_render`,
  `mikser_preview_ui`, `mikser_ui_action`, `mikser_ping`.
  **Never `mikser_api_*`** — that prefix is dead.
- **TASKS constants**: `INLINE` (main-thread async), `SERIAL`
  (p-queue concurrency 1), `WORKER` (Piscina pool). **Not** the old
  `POOL`/`QUEUE`/`WORKER` (which misled readers — `POOL` was actually
  main-thread, not Piscina).

## Code style

- **No historical-narrative comments.** Describe what's there now.
  "Used to live in X, moved in 8.2.0" → git log territory.
- **No separator-line comments** (`// ---- Section -----`).
- **No `_` prefix on engine-managed paths** (`runtimeFolder/foo`,
  not `runtimeFolder/_foo`).
- **Engine-set entity fields under `entity.options`**, not
  `_`-prefixed top-level.
- **No cross-plugin imports.** Plugins compose through lifecycle +
  `runtime.options.*`. Shared pure helpers go in `src/utils.js`.
  Audit: `grep -rEn "from '\./|await import\('\./" src/plugins/*.js`
  should return nothing.
- **Single source of truth fixes.** For cross-plugin bugs, ask
  "what's the canonical copy?" before symptom-site patching.
- **README claims are promises.** Every line in mikser-io's README
  is a commitment — true today or actively being made true. Stale
  claims are bugs.

## ADRs (canonical decisions)

- **0001-0005** — foundational: content-layer-not-the-app,
  files-as-source-of-truth, plugins-independent-engine-stable,
  compose-via-protocols, engine-infrastructure-runs-before-plugin-hooks
- **0006** — five-test framework for adding to core: (1) substrate,
  (2) strengthens strategy, (3) god-plugin check, (4) composability,
  (5) release cadence. Conjunctive. Express passes; MCP failed test
  #5 and ships as mikser-io-mcp.
- **0007** — `$`-prefixed reference declaration + `expand`
  resolution. Implemented in `catalog.js` + `refs.js`. Caps
  configurable under `catalog.expand.{maxDepth,maxPaths,maxResolved}`
  (defaults 5/20/100).
- **0008** — MCP-UI rendering + action delivery. Lives in
  `mikser-io-mcp/documentation/decisions/` (not core — moved with
  MCP).
- **0009** — Sqlite is the engine's persistence substrate. Single
  `runtime/mikser.sqlite` holds `mikser_entities` / `mikser_refs` /
  `mikser_snapshots` / `mikser_journal` (+ `mikser_meta` for the
  schema-version stamp). Sift→SQL pushdown + LRU for findById;
  worker-side read-only sqlite for sync template helpers.
  `registerSchema(name, sql)` + `useDatabase()` is the plugin-side
  persistence pattern. Journal-on-sqlite (Phase 7) enables `--resume`;
  auto-persist (Phase 9) means plugins mutate the yielded entity and
  the journal writes back without an explicit `updateEntry` call.
- **0010** — Plugin bundles + factory-call form + inline options.
  Plugins are imported by name and called as factories;
  `plugins: []` carries factory returns, never strings.
  Lifecycle plugins are `(options) => (core) => void`; renderers
  return `{name, options, load?, render?}`; postprocessors return
  `{name, options, output?, setup?, postprocess, teardown?}`. Per-
  plugin config moved entirely off `runtime.config.<plugin>`; it
  arrives as factory args, gets stashed on the descriptor, and is
  passed as `config` to `load`/`render`/`setup`/`postprocess`.

## MCP

Lives in `mikser-io-mcp` plugin (separate repo). Activate by calling
`mcp()` **first** in your `mikser.config.js` plugins array:

```js
import { mcp } from 'mikser-io-mcp'

export default {
    plugins: [
        mcp({
            // path: '/mcp',          // default '/mcp'
            // endpoints: { ... },    // per-endpoint token + scope
        }),
        /* ...other plugins */
    ],
}
```

Must be first because its factory creates `runtime.options.mcp`
synchronously when its closure runs, and other plugins gate their
MCP tool registration on `if (runtime.options.mcp)` in their own
`onLoaded`.

There is **no `--mcp` CLI flag**. Activation is plugin-presence only.

## Perf

- Rig: `npm run test:perf` (generates 10k corpus, runs render-only
  pipeline). Configurable: `node test/perf/generate.js 50000`.
  `SIZE=realistic node test/perf/generate.js 10000` switches to fat
  entities (full SEO meta, hero/gallery image objects, $-refs to
  author/category/related, longer body — ~7KB per catalog entry
  instead of ~3KB). Add `task: worker` to a layout's frontmatter to
  dispatch its renders + postprocess through Piscina.
- Current honest numbers (Apple Silicon, 4-thread default, INLINE
  dispatch; see ADR-0009 for the substrate the numbers below run on):
  - 14k realistic cold (--clear):   33s,    RSS 1.4GB peak
  - 14k realistic warm clean:       2.6s,   RSS 156MB peak
  - 14k realistic warm + 1 change:  3.0s,   RSS 156MB peak
  - 110k realistic cold (--clear):  5.5 min
  - 110k realistic warm clean:      25s,    RSS 3.2GB
- vs the Map+NDJSON baseline (origin/main 6922b33) at 14k realistic:
  cold ~4× faster, warm ~2× faster, warm RSS ~9× smaller. 110k is a
  workload Map+NDJSON couldn't reach — process OOMed before ADR-0009.
- Catalog scan cost was the 2024-era objection to sqlite. The
  resolution lives in `src/database/sift-to-sql.js`: indexed sift
  clauses ($eq/$in/$lt/$exists/etc. on collection / type / format /
  name / meta_href / meta_layout / meta_lang / meta_cache / time /
  uri) push down to SQL, so layouts.onLoaded and source.sweep don't
  materialize the table per cycle. `findById` is a 10k-entry LRU in
  front of PK lookup. Without those two, sqlite is strictly slower
  than the old Map (we measured it — see ADR-0009).
- Piscina is lazy (`minThreads: 0` + `idleTimeout: 30_000`). INLINE
  dispatch is the default for both render and postprocess; layouts
  that opt into TASKS.WORKER (`task: worker` in frontmatter) get a
  thread per first task. At 14k the lazy init dropped peak RSS
  ~130MB on workloads that never use WORKER (which is most).
- **Profile before optimizing.** `node --cpu-prof app.js
  --working-folder test/perf --clear` produces `.cpuprofile` for
  Chrome DevTools. Intuition has a real miss rate (multiple perf
  hypotheses across this rewrite turned out wrong; the profile
  caught them every time).
- What actually helps when RSS is too high: trim entity weight
  (don't store source `content` in the catalog if the renderer
  re-reads it; don't keep computed fields you can recompute),
  filter your `data.entities` exports so the catalog isn't
  carrying the rendered shape, or drop `--threads` to 1-2 if the
  build is memory-bound and cold time is acceptable.

## When extending

- **New engine capability?** Run through ADR-0006's five tests. Bar
  is high. Express is the only earned addition.
- **New plugin?** Own repo, named `mikser-io-<name>`. Exports a
  named v9 factory (e.g. `export function vector(options = {}) {
  return (core) => { ... } }`). Composes against
  `runtime.options.app` / `runtime.options.mcp` / lifecycle hooks.
  Never imports another plugin's source — and the engine never
  reads `runtime.config.<plugin>` for plugin options; everything
  flows through the factory arg (ADR-0010).
- **New MCP tool?** Add to `mikser-io-mcp/index.js` via
  `mcp.simpleTool(name, description, zodSchema, handler)`. Tool name
  follows `mikser_*` convention.
- **New lifecycle hook?** Almost certainly no. Existing hooks cover
  all known patterns. If you think you need one, post the use case
  to ADR-0006 review.
- **New content source (gdrive, notion, s3, github, …)?** Two
  things ship together:
  - A regular lifecycle plugin (the sync — emits entities into the
    catalog, sets `entity.uri = '<scheme>://...'` so the dispatch
    knows where to route reads).
  - A named export `read(entity)` from the same package, which
    must be named `mikser-io-provider-<scheme>` so the engine can
    find it. `readEntityContent(entity)` parses the scheme out of
    `entity.uri`, dynamic-imports the package, calls its `read`.
    No registry, no descriptor — same package-name convention as
    `mikser-io-render-*` and `mikser-io-post-*`.
  Built-in: plain local paths (no scheme) and `file://` URIs are
  read via `fs.readFile` directly — no provider package needed for
  the canonical local-filesystem case. `entity.content` already
  populated is a fast-path that skips the dispatch entirely (for
  small remote docs eager-fetched at sync time).

## Test suites

- `npm run test:unit` — 363 unit tests across plugins + utilities
- `npm run test:scenarios` — 18 subprocess-spawned end-to-end runs
  (manifest skip, refs replay, watch-mode change/delete). Spawns
  mikser fresh per scenario so module-level catalog/refs/manifest
  state can't leak between tests.
- `npm run test:smoke` — full lifecycle build of `test/fixture/`
  (with vector + decap + post-mjml + post-pdf if env supports).
  Exercises both INLINE postprocess (PDF) and WORKER postprocess
  (MJML via `task: worker` on `welcome.yml`).
- `npm run test:perf` — render-pipeline perf rig (corpus generation
  + clean-build timing). `SIZE=realistic` + entity count knobs
  documented in **Perf**.

## Dev workspace

The siblings live side-by-side under `/Users/dick/Projects/mikser/`
and share an npm workspace declared at the parent's `package.json`:

```json
{
  "private": true,
  "workspaces": ["mikser-io", "mikser-io-*"]
}
```

`npm install` at that root hoists everything: each sibling's
`node_modules/mikser-io` (and any other cross-workspace dep)
becomes a symlink to the working copy. The whole tree runs
against ONE module instance of mikser-io.

**This isn't optional ergonomics — it's correctness.** Plugins
use `AsyncLocalStorage` (currently `queryContext` for sidecar
findEntities tracking; the schema-version meta could grow more).
Without workspace deduplication, npm 7+ auto-installs the peer
dep into each sibling's own `node_modules`. Layouts'
`import { queryContext } from 'mikser-io'` then resolves to its
bundled copy — a different AsyncLocalStorage instance than the
engine uses. Sidecar queries don't get tracked → no `query`
edges in `mikser_snapshots.refClosure` →
`manifest.queryAffected` returns empty → aggregate layouts
(index pages, sitemaps, RSS feeds) never invalidate when new
matching entities land. Silent broken-incremental.

`test/scenarios/_harness.js` also auto-coalesces (replaces any
real `mikser-io-layouts/node_modules/mikser-io` directory with a
symlink to MIKSER_ROOT on every `setupFixture`) as a backstop —
the scenarios pass with or without the workspace, but the
workspace is the canonical setup. Same shape applies to any
future sibling that uses `queryContext` or other module-level
state from mikser-io.

For production consumers (someone `npm install mikser-io
mikser-io-layouts` in their own project), npm resolves both from
the consumer's own project tree — no duplication, no bug.

## Reference

- `documentation/architecture.md` — module map (audit before relying
  on specifics; may have drift)
- `documentation/decisions/` — ADRs
- `documentation/configuration.md` — config reference
- `documentation/api-reference.md` — public API
- `test/perf/` — render-pipeline perf rig
- Sibling repos: `mikser-io-layouts` (canonical SSG-flavor render-task
  production policy), `mikser-io-mcp`, `mikser-io-vector`,
  `mikser-io-schemas`, `mikser-io-forms`, `mikser-io-post-{mjml,pdf,email}`,
  `mikser-io-render-{eta,liquid,markdown,metatext}`,
  `mikser-io-sdk-{api,react,svelte,vue,vector}`, `mikser-io-example-blog`

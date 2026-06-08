# CLAUDE.md — mikser-io

Read this before proposing changes. Posture, architectural conventions,
and the landmarks that survive across sessions.

## Posture

**Until v10, mikser has no users.** No back-compat. No deprecation
paths. No migration markdown. No `task: pool` legacy aliasing for
`task: inline`. Update READMEs and ADRs in place as source-of-truth
changes; rewrite, don't supersede. The freedom is the point.

**Position mikser by what it is, not by speed.** Hugo wins the speed
race; mikser doesn't compete there. Position: AI-native, lifecycle-
observable, files-as-source-of-truth, full-cycle introspection. Speed
claim cap: "fast enough that watch-mode rebuilds feel instant."
Honest range: 200–800 docs/sec depending on corpus size
(see `test/perf/`).

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
- `journal.js` — per-cycle queue. In-memory array + id-Map (NOT
  sqlite). Drained at onFinalized. `addEntry`/`addEntries`/`updateEntry`/
  `useJournal`/`clearJournal`. Entries deep-cloned via `structuredClone`
  on insert for snapshot semantics.
- `catalog.js` — entity persistence via lowdb (`runtime.catalog`,
  JSON at `runtime/catalog.json`). Public ops: `findEntity`,
  `findEntities`, `queryEntities`, `readEntity`, `subscribe`,
  `assertExpand`. Expand internals (`expandLimits`, `expandAndProject`,
  `findRef`) are PRIVATE.
- `subscriptions.js` — `subscribe()` primitive. Two modes: journal-
  walk dispatch (default) and graph dispatch via
  `runtime.refs.subscribeGraph` (when `expand` is set).
- `refs.js` — inverse-reference graph (`$`-keyed refs per ADR-0007).
  Exposed at `runtime.refs.*`: `inboundFor`, `outboundFor`, `allRefs`,
  `size`, `rename`, `subscribeGraph`. Plus `refExists` module-level.
  Rebuilt every cycle in `onPersist`.
- `engine.js` — `setup()`, lifecycle wiring, render + postprocess
  dispatchers, manifest tracking.
- `server.js` — Express bring-up: CLI flags (`--server`, `--cors`,
  `--no-cors`), trust-proxy, CORS (with extensible header arrays for
  plugins to push onto), late-binding static mount + listen.
- `logger.js` — pino + pino-pretty (inline) + gauge progress + custom
  Writable for progress coordination + `pino.multistream` for
  third-party shipping (`runtime.config.logging.transports`).
- `utils.js` — shared pure helpers: `mimeForEntity`, `isLoopback`,
  `expandEntity`, `projectMeta`, `useCollection`, `useRenderer` (via
  render.js), `isTextEntity`, `readEntityContent`, `extractRefs`,
  `isRefKey`, `writeEntity`, `matchEntity`, `getFormatInfo`,
  `changeExtension`, `checksum`, `normalize`, `formatErrorContext`,
  `formatLogArgs`, `ExpandError`, `AbortError`.
- `render.js` / `postprocess.js` — Piscina worker entry points.
  Receive entity + options + config + state via Piscina serialization;
  return result. Never touch the journal directly.
- `config.js` — loads `mikser.config.js` at `onLoad`.
- `plugins.js` — loads user plugins at `onLoad`. Plugin factories
  receive the full `core` exports as their first argument.
- `manager.js` — file watching (chokidar) and cron scheduling.
- `source.js` — `useSource` codifies the folder-of-files pattern.
- `constants.js` — `OPERATION` (CREATE/UPDATE/DELETE/RENDER/
  POSTPROCESS), `ACTION` (sync action types), `TASKS` (`INLINE`/
  `SERIAL`/`WORKER` — dispatch modes).

## Plugin map (`src/plugins/`)

- `documents` — file→entity sync for the documents collection
- `layouts` — layout matching + sitemap + `inspect()` primitive
  (exposed at `runtime.options.layouts.inspect`)
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

## Naming conventions

- **Engine state** at `runtime.<name>` — `runtime.refs`, `runtime.catalog`.
- **Plugin surfaces** at `runtime.options.<plugin>` —
  `runtime.options.preview`, `runtime.options.layouts.inspect`.
- **Engine functions** as module-level exports from `mikser-io`:
  `import { queryEntities, subscribe, useRenderer, useCollection,
  readEntityContent, isTextEntity } from 'mikser-io'`.
- **Plugin packages**: `mikser-io-<name>` (mikser-io-mcp, mikser-io-vector,
  mikser-io-schemas, etc.).
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

## MCP

Lives in `mikser-io-mcp` plugin (separate repo). Activate by listing
`'mcp'` **first** in your `mikser.config.js` plugins array:

```js
export default {
    plugins: ['mcp', /* ...other plugins */],
    mcp: {
        path: '/mcp',          // optional; default '/mcp'
        // endpoints: { ... }  // optional; per-endpoint token + scope
    },
}
```

Must be first because its factory creates `runtime.options.mcp`
synchronously, and other plugins gate their MCP tool registration on
`if (runtime.options.mcp)` in their own `onLoaded`.

There is **no `--mcp` CLI flag**. Activation is plugin-presence only.

## Perf

- Rig: `npm run test:perf` (generates 10k corpus, runs render-only
  pipeline). Configurable: `node test/perf/generate.js 50000`.
  Use `TASK=worker node test/perf/generate.js 10000` to dispatch
  through Piscina.
- Current honest numbers (Apple Silicon, 4-thread default,
  in-memory journal, INLINE dispatch):
  - 1k docs: ~800/sec (~1.25s)
  - 10k docs: ~262/sec (~38s)
- Bottleneck at 10k is dispatcher per-render bookkeeping (fs writes,
  hook iteration, `structuredClone` in journal, options spread).
  Journal itself is no longer the bottleneck.
- **Profile before optimizing.** `node --cpu-prof app.js
  --working-folder test/perf --clear` produces `.cpuprofile` for
  Chrome DevTools. Intuition has a real miss rate (we shipped 3
  perf commits + reverted 1 write-queue attempt — would have caught
  that with a profile).

## When extending

- **New engine capability?** Run through ADR-0006's five tests. Bar
  is high. Express is the only earned addition.
- **New plugin?** Own repo, named `mikser-io-<name>`. Composes
  against `runtime.options.app` / `runtime.options.mcp` / lifecycle
  hooks. Never imports another plugin's source.
- **New MCP tool?** Add to `mikser-io-mcp/index.js` via
  `mcp.simpleTool(name, description, zodSchema, handler)`. Tool name
  follows `mikser_*` convention.
- **New lifecycle hook?** Almost certainly no. Existing hooks cover
  all known patterns. If you think you need one, post the use case
  to ADR-0006 review.

## Test suites

- `npm run test:unit` — 304 unit tests across plugins + utilities
- `npm run test:smoke` — full lifecycle build of `test/fixture/`
  (with vector + decap + post-mjml + post-pdf if env supports)
- `npm run test:perf` — render-pipeline perf rig (corpus generation
  + clean-build timing)

## Reference

- `documentation/architecture.md` — module map (audit before relying
  on specifics; may have drift)
- `documentation/decisions/` — ADRs
- `documentation/configuration.md` — config reference
- `documentation/api-reference.md` — public API
- `test/perf/` — render-pipeline perf rig
- Sibling repos: `mikser-io-mcp`, `mikser-io-vector`, `mikser-io-schemas`,
  `mikser-io-sdk-{api,react,svelte,vue,vector}`, `mikser-io-example-blog`

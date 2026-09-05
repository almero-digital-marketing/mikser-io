# Architecture

For the **why** behind these architectural choices — the load-bearing decisions and the reasoning that protects them — see [`decisions/`](./decisions/). This document describes the *what*; the ADRs describe the *why*. Read the ADRs before proposing a feature that pushes against an established constraint.

## Module Structure

```
mikser-io/
├── app.js                    CLI entry point
├── index.js                  Public API re-exports
│
└── src/
    ├── runtime.js            Singleton object — global state and lifecycle coordination
    ├── engine/               setup() and the lifecycle phases, one file each: boot, dispatch, render-cycle, postprocess-cycle, finalize; plus report-only, checks and workers. index.js wires them in order
    ├── lifecycle.js          Hook registration functions + entity write helpers
    ├── journal.js            Per-cycle queue persisted to mikser_journal (auto-persist on yielded entities; survives crashes so --resume can pick up)
    ├── catalog.js            Persistent entity registry (mikser_entities sqlite table + 10k LRU on findById)
    ├── refs.js               Inverse-reference graph (mikser_refs sqlite table)
    ├── manifest/            schema, snapshot build/parse, sources, prepared statements, the onLoaded/onFinalize cycle; index.js keeps createManifest
    ├── database/             createSqliteDatabase, registerSchema, useDatabase, sift→SQL translator, queryContext (AsyncLocalStorage)
    ├── subscriptions.js      subscribe() primitive (journal-walk + graph-dispatch modes)
    ├── source.js             useSource — folder-of-files import pattern shared by documents/files (and used by sibling mikser-io-layouts)
    ├── server.js             Express bring-up: --server / --cors flags, trust-proxy, late-binding mount + listen
    ├── config.js             Config file loading
    ├── plugins.js            Plugin resolution and loading
    ├── manager.js            File watching and cron scheduling
    ├── logger/               streams.js (pino + pretty + multistream), levels.js (which level is in force), progress.js (the gauge and the records that replace it); index.js is the barrel
    ├── render.js             Render worker function (runs in main or Piscina threads); ensureWorkerDb gives each worker a read-only sqlite handle
    ├── postprocess.js        Postprocess worker function (runs in main or Piscina threads)
    ├── track.js              Render-time dependency tracking (catalog queries auto-report via queryContext)
    ├── utils/               entity, refs, hash, expand, output, errors, junk, net, library; index.js re-exports all 37
    ├── constants.js          OPERATION, ACTION, TASKS enums
    │
    ├── plugins/              Built-in content source and transform plugins
    │   ├── documents.js
    │   ├── files.js
    │   ├── assets.js
    │   ├── resources.js
    │   ├── data.js
    │   ├── api.js
    │   ├── mapper.js
    │   ├── validator.js
    │   ├── commands.js
    │   ├── shares.js
    │   ├── front-matter.js
    │   ├── json.js
    │   └── yaml.js
    │
    ├── plugins/render/       Render-time helper plugins (prefix: render-)
    │   ├── hbs.js            Handlebars renderer
    │   ├── preset.js         Asset preset renderer
    │   ├── href.js           Link resolution
    │   ├── asset.js          Asset path generation
    │   ├── resource.js       CDN resource mapping
    │   └── file.js           File reading utilities
    │
    └── plugins/post/         Postprocess-time helper plugins (prefix: post-)
```

## The Runtime Singleton

`runtime` is a plain object exported from `src/runtime.js`. It holds all global state and coordinates the lifecycle.

```
runtime
├── stamp              Timestamp of current run (Date.now() at start)
├── processTime        Timestamp of current process() call
├── started            boolean — true after first import phase
├── phase              Name of the lifecycle phase currently executing (null between phases)
├── options            Merged CLI + config options
├── config             Loaded from mikser.config.js
├── state              Arbitrary plugin state — catalog/refs/manifest are NOT here; they live as their own sqlite-backed facades below
├── catalog            entity catalog facade (set by catalog.js) — findEntity / findEntities / iterateEntities / queryEntities / readEntity / subscribe / assertExpand. Backed by mikser_entities + 10k LRU on findById.
├── refs               inverse-ref graph facade (set by refs.js) — inboundFor / outboundFor / allRefs / size / rename / subscribeGraph / inverseClosureOf. Backed by mikser_refs.
├── manifest           render snapshot facade (set by manifest/cycle.js) — shouldSkip / record / recordedHashes. Backed by mikser_snapshots.
├── lookupHref         Sync href→entity lookup; available inside Piscina workers (each opens its own read-only sqlite handle on first task)
├── validators[]       Array of validation functions
├── mutex              Semaphore for process() serialisation
├── abortController    Current run's AbortController
│
├── engine             Service objects (set by engine/index.js)
│   ├── logger              pino instance
│   ├── commander           Commander instance
│   ├── renderWorkers       Lazy Piscina pool (minThreads: 0, idleTimeout: 30_000)
│   ├── postprocessWorkers  Lazy Piscina pool (same shape)
│   └── queue               p-queue instance (SERIAL dispatch)
│
└── hooks
    ├── initialize[]
    ├── initialized[]
    ├── load[]
    ├── loaded[]
    ├── import[]
    ├── imported[]
    ├── process[]
    ├── processed[]
    ├── persist[]
    ├── persisted[]
    ├── beforeRender[]
    ├── render[]
    ├── afterRender[]
    ├── beforePostprocess[]
    ├── postprocess[]
    ├── afterPostprocess[]
    ├── cancel[]
    ├── cancelled[]
    ├── finalize[]
    ├── finalized[]
    ├── sync[]
    └── completed[]
```

### Why a plain object module singleton?

ES modules are evaluated once and then cached by Node.js. Every file that does `import runtime from './runtime.js'` receives the same object reference — the module cache provides the singleton guarantee without any class machinery.

This approach is simpler and easier to test than a static class: there are no class-specific concepts (`instanceof`, `prototype`, `constructor`) to reason about, and a test that needs a clean slate can use `vi.resetModules()` to get a fresh evaluation of the module.

## Data Flow

Catalog, refs, manifest, and journal all share one file:
`runtime/mikser.sqlite`. Plugins reach the substrate through the
`runtime.catalog.*` / `runtime.refs.*` / `runtime.manifest.*` facades
and through `useJournal()` — never the file directly.

```
Source files
     │
     ▼
[IMPORT phase]
  plugins glob folders → createEntity() / updateEntity() / deleteEntity()
     │
     ▼
mikser_journal  (CREATE / UPDATE / DELETE rows)
     │
     ▼
[PROCESS phase]
  plugins useJournal() → mutate yielded entity (auto-persisted on next yield)
  (front-matter, mapper, layout matching, resource provisioning)
     │
     ▼
[PERSIST phase]
  catalog.js drains CREATE/UPDATE/DELETE rows → single transaction over
  mikser_entities; refs.js rebuilds inverse rows in mikser_refs for any
  entity whose $-keyed refs changed
     │
     ▼
mikser_entities + mikser_refs
  (current entity catalog + inverse-ref graph)
     │
  [also] plugins write RENDER rows in onBeforeRender
     │
     ▼
mikser_journal  (RENDER rows)
     │
     ▼
[RENDER phase]
  engine/render-cycle.js dispatches RENDER rows → render() per row, dispatch mode
  picked per row from { INLINE, SERIAL, WORKER }
     │
     ▼
render.js
  loads renderer + helper plugins → renderer.render() → writes output
  → manifest.record() in mikser_snapshots
     │
     ▼
Output files
     │
  [also] plugins write POSTPROCESS rows in onBeforePostprocess
     │
     ▼
mikser_journal  (POSTPROCESS rows)
     │
     ▼
[POSTPROCESS phase]
  engine/render-cycle.js dispatches POSTPROCESS rows → postprocess() per row
  (same INLINE/SERIAL/WORKER dispatch model as render)
     │
     ▼
Converted output files
  (e.g. HTML → PDF, minified HTML, image transforms)
     │
     ▼
[FINALIZE phase]
  catalog/refs/manifest commit their per-cycle transaction; journal is
  cleared with DELETE FROM mikser_journal. Anything left when the
  process exits is fair game for the next `--resume` run.
```

## Plugin Architecture

Plugins follow a **factory function pattern**:

```js
// A plugin is a module exporting a default function
export default (coreAPI) => {
  // Register lifecycle hooks
  coreAPI.onLoaded(async () => { ... })
  coreAPI.onImport(async () => { ... })
  coreAPI.onSync('name', async (op) => { ... })

  // Return plugin exports (optional)
  return { collection, type }
}
```

The `coreAPI` passed to the factory is `import * as core from '../index.js'` — the full public API of Mikser. This means plugins have access to every exported function, including the runtime singleton, all hook registrations, entity operations, and utilities.

Plugins publish their public surface at `runtime.options.<plugin>` — e.g. `runtime.options.preview = { store, get, stats, config }`, `runtime.options.layouts.inspect`. Engine state stays at `runtime.<name>` (`runtime.catalog`, `runtime.refs`, `runtime.manifest`). Plugins never import another plugin's source — they compose through lifecycle hooks and `runtime.options.*`.

## Render Architecture

The render system is designed to run both in the main process and in Piscina worker threads. The same `render()` function (`src/render.js`) is used in both cases.

```
main process
  │
  ├── INLINE mode: render() called directly, concurrent via p-map (default)
  │
  ├── SERIAL mode: render() called via p-queue (concurrency 1)
  │
  └── WORKER mode:
        │
        ▼
    Piscina worker thread (lazy pool: minThreads: 0, idleTimeout: 30_000)
        │
        ├── ensureWorkerDb opens a read-only sqlite handle on first task
        │   so runtime.lookupHref and other catalog reads stay sync
        ├── render() called in worker
        ├── Logger messages sent back via MessagePort
        └── Result returned to main thread
```

Worker threads receive a serializable copy of the render options (entity, options, config, context, state) — no live references. `workerSafeOptions(runtime.options)` strips non-cloneable plugin functions before structured clone. The logger proxy in worker mode sends log messages through the `MessagePort` to be emitted in the main process. INLINE-only workloads (no layout opts into `task: worker`) never spin up a worker — the lazy pool keeps `minThreads: 0`.

## Postprocess Architecture

The postprocess system mirrors render exactly, but uses `src/postprocess.js` and a separate lazy Piscina pool (`runtime.engine.postprocessWorkers`, same `minThreads: 0` + `idleTimeout: 30_000` shape).

```
main process
  │
  ├── INLINE mode: postprocess() called directly, concurrent via p-map (default)
  │
  ├── SERIAL mode: postprocess() called via p-queue (concurrency 1)
  │
  └── WORKER mode:
        │
        ▼
    Piscina worker thread (postprocessWorkers pool)
        │
        ├── postprocess() called in worker
        ├── Logger messages sent back via MessagePort
        └── Result returned to main thread
```

Layouts opt into worker dispatch via `task: worker` in frontmatter; the test fixture uses this for MJML postprocess (`welcome.yml`).

Postprocess plugins use the `post-` prefix and live in `src/plugins/post/` (built-in) or `plugins/post-<name>.js` (project-level) or `node_modules/mikser-io-post-<name>/` (npm). A postprocess plugin exports a `postprocess()` function (and optionally `load()`):

```js
// plugins/post-pdf.js
export async function load({ entity, options, config, state, logger }) {
  // one-time setup per job
}

export async function postprocess({ entity, options, config, context, plugins, runtime, state, logger }) {
  // read entity.source or entity.destination, write converted output
}
```

## Incremental Builds (Watch Mode)

```
File system event
      │
      ▼
chokidar watcher
      │
      ▼
sync hooks   ← plugins decide what changed and update the journal
      │
      ▼
debounce (1s)
      │
      ▼
runtime.process()   ← only if a sync hook returned true
      │
      ├── If already running → cancel() + wait + restart
      │
      └── mutex.use(() => { process → render → finalize })
```

The mutex ensures only one `process()` cycle runs at a time. The AbortController propagates cancellation through the signal parameter to all hooks, allowing graceful interruption.

## Error Handling

- **Render errors**: Caught per job. Failed renders are logged and the journal entry is marked `{ success: false }`. The run continues.
- **Validation errors**: Entities that fail validation are not added to the journal. A warning is logged.
- **Plugin errors**: Caught in the plugin loader. A failed plugin logs an error and is skipped.
- **AbortError**: Expected in watch mode. Hooks should throw `AbortError` when `signal.aborted` is true.
- **Unhandled errors in hooks**: Propagate up and terminate the current `process()` call.

## Concurrency Model

| Concern | Mechanism |
|---------|-----------|
| Single process() at a time | `Mutex` from `await-semaphore` |
| Parallel render jobs | `p-map` with `concurrency: runtime.options.threads` |
| Sequential render queue | `p-queue` with `concurrency: 1` |
| CPU-bound rendering | Piscina worker thread pool |
| Cancellation | `AbortController` / `AbortSignal` threaded through hooks |
| File change debounce | `setTimeout` 1000ms, cleared on each new event |

## Public API Exports (`index.js`)

```js
// Runtime singleton
export { default as runtime } from './src/runtime.js'

// Constants
export * as constants from './src/constants.js'

// Utilities
export * from './src/utils/index.js'         // checksum(), normalize(), matchEntity(), AbortError, etc.

// Lifecycle hooks and entity operations
export * from './src/lifecycle.js'     // onXxx(), createEntity(), updateEntity(), deleteEntity(), renderEntity(), etc.

// Sqlite substrate
export * from './src/database/index.js' // useDatabase, registerSchema
export * from './src/journal.js'        // addEntry, addEntries, updateEntry, useJournal, clearJournal
export * from './src/catalog.js'        // findEntity, findEntities, iterateEntities, queryEntities, readEntity, assertExpand
export * from './src/refs.js'           // refExists (runtime.refs.* is the main surface)
export * from './src/manifest/index.js'       // (runtime.manifest.* is the main surface)

// Dependency tracking + subscriptions
export * from './src/track.js'
export * from './src/subscriptions.js'  // subscribe()

// Config + plugin loading
export * from './src/config.js'
export * from './src/plugins.js'

// Manager
export * from './src/manager.js'        // watch(), schedule(), createdHook/updatedHook/deletedHook/triggeredHook

// Logger / progress
export * from './src/logger/index.js'   // trackProgress, stopProgress, updateProgress, setLogLevel, etc.

// setup() and render dispatcher entry
export * from './src/engine/index.js'         // setup()
export * from './src/render.js'         // useRenderer

// Folder-of-files import helper
export * from './src/source.js'         // useSource
```

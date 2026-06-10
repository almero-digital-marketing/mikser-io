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
    ├── engine.js             setup() function, CLI option parsing, useLogger()
    ├── lifecycle.js          Hook registration functions + entity write helpers
    ├── journal.js            In-memory per-cycle operation queue
    ├── catalog.js            Persistent entity registry (mikser_entities sqlite table + LRU)
    ├── refs.js               Inverse-reference graph (mikser_refs sqlite table)
    ├── manifest.js           Render snapshots (mikser_snapshots sqlite table)
    ├── database/             Sqlite handle, registerSchema, sift→SQL translator, queryContext
    ├── config.js             Config file loading
    ├── plugins.js            Plugin resolution and loading
    ├── manager.js            File watching and cron scheduling
    ├── logger.js             Progress bars and log formatting (wraps pino so progress lines don't get mangled)
    ├── render.js             Render worker function (runs in main or Piscina threads)
    ├── postprocess.js        Postprocess worker function (runs in main or Piscina threads)
    ├── utils.js              Checksum, normalize, matchEntity, changeExtension, AbortError
    ├── constants.js          OPERATION, ACTION, TASKS enums
    │
    ├── plugins/              Built-in content source and transform plugins
    │   ├── documents.js
    │   ├── files.js
    │   ├── layouts.js
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
├── options            Merged CLI + config options
├── config             Loaded from mikser.config.js
├── state              Arbitrary plugin state (runtime.state.layouts, etc.)
├── catalog            entity registry (set by catalog.js)
├── validators[]       Array of validation functions
├── mutex              Semaphore for process() serialisation
├── abortController    Current run's AbortController
│
├── mikser             Service objects (set by engine.js)
│   ├── logger         pino instance
│   ├── commander      Commander instance
│   ├── workers        Piscina thread pool
│   └── queue          p-queue instance
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

```
Source files
     │
     ▼
[IMPORT phase]
  plugins glob folders → createEntity() / updateEntity() / deleteEntity()
     │
     ▼
Journal (SQLite)
  operations: CREATE, UPDATE, DELETE
     │
     ▼
[PROCESS phase]
  plugins read journal → transform entities → updateEntity()
  (front-matter, mapper, layout matching, resource provisioning)
     │
     ▼
[PERSIST phase]
  catalog.js reads journal → applies to entity catalog
     │
     ▼
Catalog (JSON)
  current entity registry
     │
  [also] plugins write RENDER entries
     │
     ▼
Journal (SQLite)
  operations: RENDER
     │
     ▼
[RENDER phase]
  engine.js reads RENDER entries → dispatches to render()
     │
     ▼
render.js
  loads plugins → calls plugin.load() → calls renderer.render()
     │
     ▼
Output files
     │
  [also] plugins write POSTPROCESS entries in onBeforePostprocess
     │
     ▼
Journal (SQLite)
  operations: POSTPROCESS
     │
     ▼
[POSTPROCESS phase]
  engine.js reads POSTPROCESS entries → dispatches to render()
  (same POOL/QUEUE/WORKER concurrency model)
     │
     ▼
Converted output files
  (e.g. HTML → PDF, minified HTML, image transforms)
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

Plugin exports are stored in `runtime.engine[pluginName]` and are accessible to other plugins and to render templates via the `plugins` object.

## Render Architecture

The render system is designed to run both in the main process and in Piscina worker threads. The same `render()` function (`src/render.js`) is used in both cases.

```
main process
  │
  ├── POOL mode: render() called directly, concurrent via p-map
  │
  ├── QUEUE mode: render() called via p-queue (sequential)
  │
  └── WORKER mode:
        │
        ▼
    Piscina worker thread
        │
        ├── render() called in worker
        ├── Logger messages sent back via MessagePort
        └── Result returned to main thread
```

Worker threads receive a serializable copy of the render options (entity, options, config, context, state) — no live references. The logger proxy in worker mode sends log messages through the `MessagePort` to be emitted in the main process.

## Postprocess Architecture

The postprocess system mirrors render exactly, but uses `src/postprocess.js` and a separate Piscina pool (`runtime.engine.postprocessWorkers`).

```
main process
  │
  ├── POOL mode: postprocess() called directly, concurrent via p-map
  │
  ├── QUEUE mode: postprocess() called via p-queue (sequential)
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

// Setup and logger
export * from './src/engine.js'        // setup(), useLogger()

// Lifecycle hooks and entity operations
export * from './src/lifecycle.js'     // onXxx(), createEntity(), etc.

// Journal
export * from './src/journal.js'       // addEntry(), useJournal(), etc.

// Catalog
export * from './src/catalog.js'       // findEntity(), findEntities()

// Config
export * from './src/config.js'        // (internal, no public exports)

// Plugin loading
export * from './src/plugins.js'       // loadPlugin()

// Logger / progress
export * from './src/logger.js'        // trackProgress(), stopProgress(), updateProgress(), etc.

// Manager
export * from './src/manager.js'       // watch(), schedule(), xHook()

// Constants
export * as constants from './src/constants.js'

// Utilities
export * from './src/utils.js'         // checksum(), normalize(), matchEntity(), etc.
```

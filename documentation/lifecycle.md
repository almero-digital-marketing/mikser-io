# Lifecycle

Mikser processes content through a fixed sequence of phases. Each phase is implemented as a set of hooks — arrays of async functions that are called in registration order.

## Phase Overview

```
runtime.start()
│
├── [INITIALIZE]   Parse CLI options, set logger levels, register journal schema
├── [INITIALIZED]  Resolve folder paths, create directories, clear if requested
├── [LOAD]         Load config file and plugins
├── [LOADED]       Plugins have loaded; runtime/mikser.sqlite is open and every
│                  registered schema applied (mikser_entities, mikser_refs,
│                  mikser_snapshots, mikser_journal, mikser_meta, plus any
│                  plugin schemas). Catalog/refs/manifest/journal have their
│                  prepared statements ready.
├── [IMPORT]       Scan source folders, populate journal with CREATE/UPDATE/DELETE rows
│                  (skipped on --resume — picks up leftover journal rows instead)
├── [IMPORTED]     All source entities are in the journal
│
└── runtime.process()   ← repeated on every change in watch mode
    │
    ├── [PROCESS]    Transform entities (map, validate, front-matter, json, yaml)
    ├── [PROCESSED]  Match layouts, provision resources
    ├── [PERSIST]    Drain CREATE/UPDATE/DELETE journal rows into mikser_entities;
    │                rebuild mikser_refs inverse rows for any entity whose
    │                $-keyed refs changed
    ├── [PERSISTED]  Catalog and refs graph are up to date
    │
    └── runtime.render(signal)
        │
        ├── [BEFORE_RENDER]      Expand paginated entities, queue render rows
        ├── [RENDER]             Execute render rows (INLINE / SERIAL / WORKER)
        ├── [AFTER_RENDER]       Render snapshots recorded in mikser_snapshots
        │
        ├── [BEFORE_POSTPROCESS] Queue postprocess rows
        ├── [POSTPROCESS]        Execute postprocess rows (same dispatch model)
        ├── [AFTER_POSTPROCESS]
        │
        └── runtime.finalize(signal)
            │
            ├── [FINALIZE]   catalog/refs/manifest commit their per-cycle
            │                transaction against mikser.sqlite; clean broken symlinks
            └── [FINALIZED]  DELETE FROM mikser_journal; log completion; start cron tasks
```

After `finalize`, if `--watch` is enabled, Mikser waits for file system events and calls `runtime.process()` again when a change is detected.

---

## Hook Registration

All hook registration functions are exported from `mikser-io`:

```js
import {
  onInitialize, onInitialized,
  onLoad, onLoaded,
  onImport, onImported,
  onProcess, onProcessed,
  onPersist, onPersisted,
  onBeforeRender, onRender, onAfterRender,
  onBeforePostprocess, onPostprocess, onAfterPostprocess,
  onCancel, onCancelled,
  onFinalize, onFinalized,
  onSync, onValidate, onComplete
} from 'mikser-io'
```

Hooks are registered before `setup()` is called or inside a plugin's factory function.

---

## Phases in Detail

### Initialize / Initialized

The initialization phase runs once at startup. Use it to set up resources that need to be ready before any config or plugins are loaded.

```js
onInitialize(async () => {
  // Runs before CLI args are parsed
})

onInitialized(async () => {
  // Runs after folders are resolved and created
  // runtime.options.workingFolder, outputFolder, runtimeFolder are available
})
```

**What Mikser does here:**
- Parses CLI arguments and merges into `runtime.options`
- Sets logger level based on `--debug` / `--trace` flags
- Resolves absolute paths for `workingFolder`, `outputFolder`, `runtimeFolder`
- Creates the `runtimeFolder` directory
- Clears `outputFolder` and `runtimeFolder` if `--clear` was set

---

### Load / Loaded

Config loading and plugin instantiation happen here.

```js
import { myPlugin } from 'mikser-io-my-plugin'

onLoad(async () => {
  // config.js has not yet been read
  // Useful for adding plugins programmatically — push factory returns,
  // never strings (ADR-0010).
  runtime.options.plugins.push(myPlugin({ /* options */ }))
})

onLoaded(async () => {
  // runtime.config holds engine-level keys + the plugins array
  // The engine sqlite database is open at runtime/mikser.sqlite
  // All plugins have been loaded and their hooks registered
})
```

**What Mikser does here:**
- Loads and evaluates `mikser.config.js` (and `config/*.config.js` files)
- Dispatches each entry in `runtime.options.plugins` by shape — function
  entries are lifecycle plugins (called with `core`), descriptor objects
  are renderers or postprocessors stashed in `runtime.renderers` /
  `runtime.postprocessors`
- Opens `runtime/mikser.sqlite` and applies every registered schema
  (`mikser_entities`, `mikser_refs`, `mikser_snapshots`, plus any
  plugin-registered tables)
- Stamps `mikser_meta.schema_version` so subsequent runs can detect
  schema drift

---

### Import / Imported

Plugins scan their source folders and populate the journal with CREATE, UPDATE, and DELETE operations.

```js
onImport(async () => {
  // Scan a source and add entities to the journal
  const paths = await globby('**/*.md', { cwd: myFolder })
  for (const rel of paths) {
    await createEntity({
      id: `/content/${rel}`,
      uri: path.join(myFolder, rel),
      collection: 'posts',
      type: 'post',
      format: path.extname(rel).slice(1)
    })
  }
})

onImported(async () => {
  // All sources have been scanned
})
```

**What built-in plugins do here:**
- `documents`: globs the documents folder, creates or updates document entities
- `files`: globs the files folder, creates file entities
- `layouts`: globs the layouts folder, creates layout entities
- `assets`: loads preset JS modules from the presets folder
- `resources`: scans entities for CDN URLs and provisions local copies

---

### Process / Processed

Entities in the journal are transformed. This is where mappers, validators, front-matter parsing, and layout matching run.

```js
onProcess(async (signal) => {
  // Transform entities in the journal — mutate the yielded entity and move on.
  // useJournal auto-persists drift after each yield; no explicit updateEntry
  // call required.
  for await (const { entity, operation } of useJournal('My transform', ['CREATE', 'UPDATE'], signal)) {
    if (entity.collection !== 'posts') continue
    entity.meta.slug = entity.name.split('/').pop()
  }
})

onProcessed(async (signal) => {
  // All transformations complete
})
```

The `signal` argument is an `AbortSignal` — check `signal.aborted` when doing long work and throw `AbortError` to cancel cleanly. This is important in watch mode where a new file change can interrupt an in-progress run.

**What built-in plugins do here:**
- Front-matter / JSON / YAML plugins parse `entity.content` and populate `entity.meta`
- `mapper`: runs custom entity transforms
- `layouts`: matches entities to layout files, sets `entity.layout`
- `resources`: maps CDN URLs in entity content to local paths

---

### Persist / Persisted

Journal operations are flushed into the catalog.

```js
onPersist(async () => {
  // Sync journal entries into your own persistent store
})

onPersisted(async () => {
  // runtime.catalog is up to date
})
```

**What Mikser does here:**
- Reads CREATE/UPDATE/DELETE operations from the journal
- Applies them to the `mikser_entities` table inside a single
  transaction (10k-entry LRU is invalidated for affected ids)
- Rebuilds the inverse-reference rows in `mikser_refs` for any
  entities whose `$`-keyed refs changed

---

### BeforeRender / Render / AfterRender

The render phase executes render jobs. Each RENDER operation in the journal becomes a render job.

```js
onBeforeRender(async (signal) => {
  // Queue up render jobs
  // Layouts plugin expands paginated entities here
  await renderEntity(entity, { renderer: 'hbs' })
})

onRender(async (signal) => {
  // Mikser's own onRender handler processes the RENDER journal entries
  // Each entry calls the render worker/queue/pool
})

onAfterRender(async () => {
  // All render jobs finished
})
```

---

### BeforePostprocess / Postprocess / AfterPostprocess

Mirrors the render phase. Queue postprocess jobs in `onBeforePostprocess`
by calling `postprocessEntity()`; `onPostprocess` dispatches the
`POSTPROCESS` journal rows using the same INLINE/SERIAL/WORKER dispatch
model as render. The engine owns a separate lazy Piscina pool
(`runtime.engine.postprocessWorkers`) so worker-routed postprocessors
(layouts that opt in via `task: worker` in frontmatter) don't share the
render pool.

```js
onBeforePostprocess(async (signal) => {
  for await (const { entity } of useJournal('Queue PDFs', ['CREATE', 'UPDATE'], signal)) {
    if (entity.format !== 'html') continue
    await postprocessEntity(
      { ...entity, destination: changeExtension(entity.destination, 'pdf') },
      { postprocessor: 'puppeteer-pdf', tasks: TASKS.WORKER }
    )
  }
})

onAfterPostprocess(async () => {
  // All postprocess jobs finished
})
```

---

### Finalize / Finalized

Cleanup and wrap-up after rendering.

```js
onFinalize(async (signal) => {
  // Write additional output files, compress, etc.
})

onFinalized(async () => {
  // Everything is done
  // Good place to trigger deployment
})
```

**What Mikser does here:**
- `catalog.js` / `refs.js` / `manifest.js` commit their per-cycle
  transaction against `mikser.sqlite` (skipped if no changes)
- `engine.js` cleans up broken symlinks in the output folder
- `journal.js` clears the per-cycle queue: `DELETE FROM mikser_journal`.
  Anything still in the table when the process exits is left for the
  next `--resume` run.
- `manager.js` starts scheduled cron tasks (if any)

---

### Cancel / Cancelled

In watch mode, when a new file change arrives while processing is in progress, Mikser cancels the current run.

```js
onCancel(async () => {
  // Abort any long-running work
  // (called before the abort signal is sent)
})

onCancelled(async () => {
  // Cleanup after a cancelled run
  // A new process() call will follow immediately
})
```

---

## One-Shot Hooks

Most hooks accept a `once` flag. When `true`, the callback runs only on the first invocation:

```js
onProcess(async (signal) => {
  // This runs every time process() is called
})

onProcess(async (signal) => {
  // This runs only once, even in watch mode
}, true)
```

---

## Sync Hook

The sync hook is how plugins decide whether a file system event should trigger a rebuild:

```js
import { onSync } from 'mikser-io'

onSync('documents', async (operation) => {
  const { action, name, context } = operation
  // action: CREATE | UPDATE | DELETE | TRIGGER
  // name: collection name (e.g. 'documents')
  // context: { relativePath }

  if (context.relativePath.endsWith('.md')) {
    // Handle the change and return true to trigger process()
    if (action === 'DELETE') {
      await deleteEntity({ id: `/content/${context.relativePath}`, collection: 'documents' })
    } else {
      const entity = await buildEntity(context.relativePath)
      await createEntity(entity)
    }
    return true  // triggers runtime.process()
  }
  return false  // ignore this event
})
```

Return values:
- `true` → event was handled, trigger a `process()` cycle
- `false` → event was explicitly ignored
- `undefined` → event was not handled by this hook (other hooks decide)

---

## Validate Hook

Validates entities before they are written to the journal. Return a string message if invalid; return nothing (or `true`) if valid.

```js
import { onValidate } from 'mikser-io'

onValidate(['CREATE', 'UPDATE'], async (entry) => {
  const { entity, operation } = entry

  if (entity.collection !== 'posts') return  // only validate posts

  if (!entity.meta?.title) {
    return 'Post is missing a title'  // logs warning and skips the entity
  }
})
```

---

## Complete Hook

Called after each entity finishes rendering (regardless of success or failure).

```js
import { onComplete } from 'mikser-io'

onComplete(async (entry) => {
  const { entity, output } = entry
  if (output.success) {
    // entity was rendered successfully
  }
})
```

---

## Error Handling and Abort

When working with `signal` in long-running hooks, always check for abort:

```js
onRender(async (signal) => {
  for await (const entry of useJournal('Rendering', ['RENDER'], signal)) {
    if (signal?.aborted) throw new AbortError()
    // ... do work
  }
})
```

`AbortError` is exported from `mikser-io` and is the expected way to exit a hook cleanly when cancelled.

# API Reference

Complete reference for all functions and values exported from `mikser-io`.

---

## Setup

### `setup(options?)`

Initializes the runtime and registers all built-in hooks. Returns the `runtime` singleton after setup is complete.

Must be called before `runtime.start()`.

```js
import { setup } from 'mikser-io'

const runtime = await setup({
  workingFolder: './my-project',
  plugins: ['documents', 'layouts'],
  outputFolder: 'dist',
  mode: 'production',
  threads: 8,
  clear: true
})

await runtime.start()
```

**Parameters:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workingFolder` | string | `'./'` | Root folder of the project |
| `outputFolder` | string | `'out'` | Output folder |
| `runtimeFolder` | string | `'runtime'` | Temp files folder |
| `plugins` | string[] | `[]` | Plugin names to load |
| `config` | string | `'./mikser.config.js'` | Config file path |
| `mode` | string | `'development'` | Runtime mode |
| `clear` | boolean | `false` | Clear output before run |
| `watch` | boolean | `false` | Watch mode |
| `debug` | boolean | `false` | Debug logging |
| `trace` | boolean | `false` | Trace logging |
| `threads` | number | `4` | Worker thread count |

**Returns:** `Promise<runtime>` — the runtime singleton

---

### `useLogger()`

Returns the current pino logger instance, or `undefined` if the engine isn't initialised yet (notably in render-worker contexts). Available after `onInitialized` fires in the main thread.

```js
import { useLogger } from 'mikser-io'

const logger = useLogger()
logger.info('Hello %s', 'world')
logger.debug({ data }, 'Debug message')
logger.warn('Something might be wrong')
logger.error('Something failed: %s', err.message)
logger.notice('Completion message')  // styled green in info mode
```

---

## Runtime Singleton

### `runtime`

The singleton object. Import directly:

```js
import { runtime } from 'mikser-io'
```

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `runtime.stamp` | number | `Date.now()` at start of current run |
| `runtime.processTime` | number | `Date.now()` at start of current `process()` |
| `runtime.started` | boolean | `true` after the import phase completes |
| `runtime.options` | object | Merged CLI + programmatic options |
| `runtime.config` | object | Loaded from `mikser.config.js` |
| `runtime.state` | object | Arbitrary state set by plugins (e.g. `state.layouts` holds the layout index keyed by uri). Catalog, refs, and manifest are sqlite-backed — not in `runtime.state`. |
| `runtime.catalog` | object | The entity catalog facade — call methods on it (`findEntity`, `findEntities`, `queryEntities`, …). Backed by `mikser_entities` in `runtime/mikser.sqlite` with a 10k-entry LRU in front of `findById`. |
| `runtime.refs` | object | Inverse-reference graph facade — `inboundFor`, `outboundFor`, `allRefs`, `size`, `rename`, `subscribeGraph`, `inverseClosureOf`. Backed by `mikser_refs`. |
| `runtime.manifest` | object | Render snapshot facade — `shouldSkip`, `record`, `recordedHashes`. Backed by `mikser_snapshots`. |
| `runtime.lookupHref` | function | Sync href→entity lookup; available inside workers too (each worker opens its own read-only sqlite handle on first task). |
| `runtime.validators` | function[] | Registered validation functions |
| `runtime.engine` | object | Runtime services (logger, renderWorkers, postprocessWorkers, queue, commander) |
| `runtime.engine.logger` | object | pino logger |
| `runtime.engine.renderWorkers` | object | Lazy Piscina pool for render jobs (`minThreads: 0`, `idleTimeout: 30_000`) |
| `runtime.engine.postprocessWorkers` | object | Lazy Piscina pool for postprocess jobs (same shape as renderWorkers) |
| `runtime.engine.queue` | object | p-queue instance |
| `runtime.engine.commander` | object | Commander CLI instance |
| `runtime.hooks` | object | Hook arrays (read-only; use `onXxx()` to register) |

#### Methods

| Method | Description |
|--------|-------------|
| `runtime.start()` | Run full lifecycle |
| `runtime.process()` | Run process → render → finalize cycle |
| `runtime.cancel()` | Abort current run |
| `runtime.sync(operation)` | Run sync hooks for an operation |
| `runtime.validate(entry)` | Run all validators for an entry |
| `runtime.complete(entry)` | Run completion hooks for an entry |
| `runtime.addHook(name, fn)` | Register a hook callback dynamically; returns the function for later removal |
| `runtime.removeHook(name, fn)` | Remove a previously registered hook callback |

`addHook` / `removeHook` are useful when you need a **one-shot** hook that cleans itself up, or when you need to wire hooks from outside the normal plugin lifecycle (e.g. the API plugin registers a `completed` hook per render request and removes it when the promise settles):

```js
const hook = runtime.addHook('completed', async (entry) => {
    if (entry.entity._correlationId !== correlationId) return
    runtime.removeHook('completed', hook)
    resolve(entry.output)
})
```

All hook names in `runtime.hooks` are valid: `initialize`, `initialized`, `load`, `loaded`, `import`, `imported`, `process`, `processed`, `persist`, `persisted`, `beforeRender`, `render`, `afterRender`, `beforePostprocess`, `postprocess`, `afterPostprocess`, `cancel`, `cancelled`, `finalize`, `finalized`, `sync`, `completed`.

---

## Lifecycle Hooks

All hook functions are `async` and accept an optional `once` boolean (defaults to `false`).

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

### `onInitialize(callback)`
Runs before CLI arguments are parsed.

### `onInitialized(callback)`
Runs after folders are resolved. `runtime.options.workingFolder`, `outputFolder`, `runtimeFolder` are available.

### `onLoad(callback)`
Runs before the config file is read. Use to programmatically add plugins.

### `onLoaded(callback)`
Runs after config and plugins are loaded. Journal and catalog are open.

### `onImport(callback)`
Runs during the import phase. Use to scan sources and call `createEntity()`.

### `onImported(callback)`
Runs after all import hooks complete.

### `onProcess(callback, once?)`
Runs during the process phase on every `process()` call. Receives `signal: AbortSignal`.

### `onProcessed(callback, once?)`
Runs after all process hooks. Receives `signal`.

### `onPersist(callback, once?)`
Runs during the persist phase. Receives `signal`.

### `onPersisted(callback, once?)`
Runs after persist completes. Receives `signal`.

### `onBeforeRender(callback, once?)`
Runs before the render phase. Use to queue render jobs. Receives `signal`.

### `onRender(callback, once?)`
Runs during the render phase. Receives `signal`.

### `onAfterRender(callback, once?)`
Runs after all render jobs complete.

### `onBeforePostprocess(callback, once?)`
Runs before the postprocess phase. Use to queue postprocess jobs by calling `postprocessEntity()`. Receives `signal`.

### `onPostprocess(callback, once?)`
Runs during the postprocess phase. Dispatches `POSTPROCESS` journal entries using the same POOL/QUEUE/WORKER concurrency model as render. Receives `signal`.

### `onAfterPostprocess(callback, once?)`
Runs after all postprocess jobs complete. Receives `signal`.

### `onFinalize(callback, once?)`
Runs during finalization. Receives `signal`.

### `onFinalized(callback, once?)`
Runs after finalization completes.

### `onCancel(callback)`
Runs when the current run is being cancelled (before abort signal is sent).

### `onCancelled(callback)`
Runs after cancellation cleanup.

### `onSync(name, callback)`

Registers a handler for file system or scheduled events.

```js
onSync('documents', async ({ action, name, context }) => {
  // action: ACTION.CREATE | UPDATE | DELETE | TRIGGER
  // name: collection name
  // context: { relativePath } or custom context from schedule()
  return true   // triggers process()
  return false  // ignore
  // return undefined → not handled
})
```

### `onValidate(operations, callback)`

Registers a validator. Return a message string if invalid; return nothing or `undefined` if valid.

```js
onValidate(['CREATE', 'UPDATE'], async (entry) => {
  if (!entry.entity.meta?.title) return 'Missing title'
})
```

### `onComplete(callback)`

Runs after each entity finishes rendering (success or failure).

```js
onComplete(async (entry) => {
  // entry.output.success: boolean
  // entry.entity: the entity
})
```

---

## Entity Operations

```js
import {
  createEntity, updateEntity, deleteEntity,
  renderEntity, renderEntities,
  postprocessEntity, postprocessEntities
} from 'mikser-io'
```

### `createEntity(entity)`

Validates and adds a CREATE operation to the journal. Sets `entity.stamp` and `entity.time`.

```js
await createEntity({
  id: '/documents/post.md',
  uri: '/project/content/post.md',
  source: '/project/content/post.md',
  collection: 'documents',
  type: 'document',
  format: 'md',
  name: 'post',
  checksum: 'abc123'
})
```

### `updateEntity(entity)`

Validates and adds an UPDATE operation to the journal. Sets `entity.stamp` and `entity.time`.

### `deleteEntity({ id, collection, type })`

Validates and adds a DELETE operation to the journal.

### `renderEntity(entity, options?, context?)`

Adds a RENDER operation to the journal.

```js
await renderEntity(
  entity,
  { renderer: 'hbs', tasks: 'POOL' },
  { data: { nav: buildNav() } }
)
```

### `renderEntities(tasks)`

Batch-adds multiple RENDER operations.

```js
await renderEntities([
  { entity: e1, options: { renderer: 'hbs' }, context: {} },
  { entity: e2, options: { renderer: 'hbs' }, context: {} }
])
```

### `postprocessEntity(entity, options?, context?)`

Adds a POSTPROCESS operation to the journal. Call inside `onBeforePostprocess`.

```js
await postprocessEntity(
  { ...entity, destination: changeExtension(entity.destination, 'pdf') },
  { postprocessor: 'puppeteer-pdf', tasks: TASKS.WORKER }
)
```

### `postprocessEntities(tasks)`

Batch-adds multiple POSTPROCESS operations.

```js
await postprocessEntities([
  { entity: e1, options: { postprocessor: 'minify-html' }, context: {} },
  { entity: e2, options: { postprocessor: 'minify-html' }, context: {} }
])
```

---

## Journal

```js
import { addEntry, addEntries, updateEntry, useJournal, clearJournal } from 'mikser-io'
```

### `useJournal(name, operations?, signal?)`

Async generator that yields journal entries with progress tracking.

```js
for await (const { id, entity, operation, context, options, output } of useJournal(
  'Processing',
  ['CREATE', 'UPDATE'],  // omit to iterate all
  signal
)) {
  // id: journal row id
  // entity, context, options, output: parsed objects
}
```

### `addEntry({ entity, operation, context, options })`

Low-level insert of a single journal entry. Does not validate or set timestamps.

### `addEntries(entries)`

Low-level batch insert (chunks of 10).

### `updateEntry({ id, entity?, output? })`

Update an existing journal entry's entity or output fields.

### `clearJournal(aborted)`

Delete all journal entries. Closes the database connection if not in watch mode.

---

## Catalog

```js
import { findEntity, findEntities } from 'mikser-io'
```

### `findEntity(query?)`

Returns the first entity matching the query, or `undefined`.

```js
const entity = await findEntity({ id: '/documents/post.md' })
const entity = await findEntity(e => e.meta?.featured === true)
```

### `findEntities(query?)`

Returns all entities matching the query. Returns all entities if no query is provided.

```js
const posts = await findEntities({ collection: 'documents' })
const published = await findEntities(e => e.meta?.draft !== true)
const all = await findEntities()
```

Query types: function, lodash match object, or `undefined` for all.

---

## Manager

```js
import { watch, schedule, createdHook, updatedHook, deletedHook, triggeredHook } from 'mikser-io'
```

### `watch(name, folder, options?)`

Watch a folder for file changes. Only active when `runtime.options.watch === true`.

```js
watch('documents', runtime.options.documentsFolder, {
  interval: 1000,
  binaryInterval: 3000,
  ignored: /[\/\\]\./,
  ignoreInitial: true
})
```

### `schedule(name, expression, context?)`

Schedule a recurring task using a cron expression. Only active in watch mode.

```js
schedule('api-refresh', '0 * * * *', { source: 'remote' })
```

### `createdHook(name, context)` / `updatedHook` / `deletedHook` / `triggeredHook`

Manually fire a sync event. Useful for external triggers.

```js
await createdHook('documents', { relativePath: 'new-post.md' })
```

---

## Utilities

```js
import { checksum, normalize, matchEntity, changeExtension, formatErrorContext, AbortError } from 'mikser-io'
```

### `checksum(uri)`

Computes an MD5 checksum of a file. For files smaller than 300KB, hashes the full content. For larger files, uses `fileSize + MD5(first300KB)` for speed.

```js
const hash = await checksum('/path/to/file.jpg')
```

### `normalize(object)`

Removes all `null`, `undefined`, `NaN`, and empty-string values from an object (deeply), using lodash `omitBy`.

```js
const clean = normalize({ title: 'Hello', draft: null, tags: undefined })
// → { title: 'Hello' }
```

### `matchEntity(entity, match)`

Tests whether an entity matches a pattern.

```js
matchEntity(entity, '@/blog/*')           // minimatch on entity.name
matchEntity(entity, '/documents/**')      // minimatch on entity.id
matchEntity(entity, { collection: 'documents' })  // lodash isMatch
matchEntity(entity, e => e.format === 'md')       // function
```

### `changeExtension(file, format)`

Returns the file path with the extension replaced.

```js
changeExtension('/out/page.html', 'md')  // → '/out/page.md'
changeExtension('post.md', 'html')       // → 'post.html'
```

### `formatErrorContext(entity, err, options)`

Builds the `[layouts/foo.hbs:12:4]` suffix used by the central render and postprocess error logs. Reads `err.layoutUri`, `err.line`/`err.lineNumber`, `err.column`/`err.col`. The `options` argument is the runtime options object — `options.workingFolder` is used to relativize the layout path.

```js
const suffix = formatErrorContext(entity, err, runtime.options)
logger.error('Render error: %s%s %s', entity.id, suffix, err.message)
```

Render plugins that wrap an underlying template engine should set these properties on the thrown error before rethrowing so the central logger has something to format.

### `AbortError`

Custom error class used for clean cancellation. Throw this (not a regular Error) when `signal.aborted` is true.

```js
if (signal?.aborted) throw new AbortError()
```

---

## Tracking

```js
import { trackProgress, updateProgress, stopProgress, updateProgressDetails } from 'mikser-io'
```

### `trackProgress(name, total)`

Start a named progress bar with a total count.

```js
trackProgress('Processing documents', items.length)
```

### `updateProgress()`

Increment the progress counter by one. Automatically stops the bar when the count reaches total.

### `stopProgress()`

Immediately stop the progress bar and log the elapsed time.

### `updateProgressDetails(details)`

Update the detail text shown on the progress bar (also logs at debug level).

---

## Constants

```js
import { constants } from 'mikser-io'

const { OPERATION, ACTION, TASKS } = constants
```

### `OPERATION`

| Key | Value | Description |
|-----|-------|-------------|
| `OPERATION.CREATE` | `'create'` | Entity was created |
| `OPERATION.UPDATE` | `'update'` | Entity was updated |
| `OPERATION.DELETE` | `'delete'` | Entity was deleted |
| `OPERATION.RENDER` | `'render'` | Entity should be rendered |
| `OPERATION.POSTPROCESS` | `'postprocess'` | Entity should be postprocessed |

### `ACTION`

| Key | Value | Description |
|-----|-------|-------------|
| `ACTION.CREATE` | `'create'` | File was added |
| `ACTION.UPDATE` | `'update'` | File was modified |
| `ACTION.DELETE` | `'delete'` | File was removed |
| `ACTION.TRIGGER` | `'trigger'` | Scheduled task fired |

### `TASKS`

| Key | Value | Description |
|-----|-------|-------------|
| `TASKS.POOL` | `'POOL'` | Main process, concurrent via p-map |
| `TASKS.QUEUE` | `'QUEUE'` | Sequential via p-queue |
| `TASKS.WORKER` | `'WORKER'` | Piscina worker thread |

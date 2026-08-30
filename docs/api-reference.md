# API Reference

Complete reference for all functions and values exported from `mikser-io`.

---

## Setup

### `setup(options?)`

Initializes the runtime and registers all built-in hooks. Returns the `runtime` singleton after setup is complete.

Must be called before `runtime.start()`.

```js
import { setup, documents, layouts } from 'mikser-io'

const runtime = await setup({
  workingFolder: './my-project',
  plugins: [documents(), layouts()],
  outputFolder: 'dist',
  mode: 'production',
  threads: 8,
  clear: true,
})

await runtime.start()
```

**Parameters:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workingFolder` | string | `'./'` | Root folder of the project |
| `outputFolder` | string | `'out'` | Output folder |
| `runtimeFolder` | string | `'runtime'` | Temp files folder (engine sqlite lives here) |
| `plugins` | factory-call[] | `[]` | Factory-return values: lifecycle plugin closures and renderer / postprocessor descriptors. Import the factory by name and call it (ADR-0010). |
| `config` | string | `'./mikser.config.js'` | Config file path |
| `mode` | string | `'development'` | Runtime mode |
| `clear` | boolean | `false` | Clear output before run |
| `watch` | boolean | `false` | Watch mode |
| `force` | boolean | `false` | Rebuild everything; disable incremental dispatch |
| `resume` | boolean | `false` | Continue from journal left by a previous interrupted run; skip the initial filesystem scan |
| `verify` | boolean | `false` | Verify output folder against manifest; report drift instead of building |
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
Runs during the postprocess phase. Dispatches `POSTPROCESS` journal entries using the same INLINE/SERIAL/WORKER concurrency model as render. Receives `signal`.

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
  { renderer: 'hbs', tasks: TASKS.INLINE },
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

Async generator that yields journal entries with progress tracking. Walks the
`mikser_journal` table chunk-by-chunk (chunk size 500) so peak memory stays
bounded regardless of corpus size. Snapshot semantics: rows inserted during
iteration are not visible to the walk that's already in progress.

```js
for await (const { id, entity, operation, context, options, output } of useJournal(
  'Processing',
  ['CREATE', 'UPDATE'],  // omit to iterate all
  signal
)) {
  // id: journal row id
  // entity, context, options, output: parsed objects

  // Auto-persist: mutate the yielded entity and move on — the diff is
  // detected after each iteration and UPDATE'd back to the row.
  entity.meta.slug = entity.name.split('/').pop()
}
```

**Auto-persist.** `useJournal` diffs the yielded entity after each iteration
and UPDATEs the journal row if it changed. Plugin authors don't need to call
`updateEntry({ id, entity })` after mutating — just mutate and the next loop
turn writes back. `updateEntry` is still exported for engine-internal output /
deps writes and as an explicit no-op safety valve for plugins that prefer to
call it.

### `addEntry({ entity, operation, context, options })`

Low-level insert of a single journal entry. Does not validate or set timestamps.

### `addEntries(entries)`

Low-level batch insert (chunks of 10).

### `updateEntry({ id, entity?, output? })`

Update an existing journal entry's entity or output fields.

### `clearJournal()`

`DELETE FROM mikser_journal` — clear all journal rows. Called at `onFinalized`.
Anything still in the table when the process exits will be picked up by a
later `--resume` run.

---

## Catalog

```js
import {
  findEntity, findEntities, iterateEntities,
  queryEntities, readEntity, subscribe
} from 'mikser-io'
```

The catalog is backed by the `mikser_entities` table inside
`runtime/mikser.sqlite`. Sift filters that touch indexed columns
(`id`, `collection`, `type`, `format`, `name`, `meta.href`, `meta.layout`,
`meta.lang`, `meta.cache`, `time`, `uri`) push down to SQL WHERE clauses
via `src/database/sift-to-sql.js`; un-pushed clauses fall through to
JS-side sift on the materialized subset. `findById` is fronted by a
10k-entry LRU + prepared statement.

### `findEntity(query?)`

Returns the first entity matching the query, or `undefined`.

```js
const entity = await findEntity({ id: '/documents/post.md' })
const entity = await findEntity(e => e.meta?.featured === true)
```

### `findEntities(query?)`

Returns an array of all entities matching the query. Returns all entities
if no query is provided. Materializes the full result set — for
corpus-scale walks where you don't need an array, prefer
`iterateEntities`.

```js
const posts = await findEntities({ collection: 'documents' })
const published = await findEntities(e => e.meta?.draft !== true)
const all = await findEntities()
```

### `iterateEntities(query?)`

Async generator over the same query shape as `findEntities`. Yields
entities one at a time, seek-paginated chunk-by-chunk so memory stays
bounded regardless of corpus size. Use it when results may be large and
the caller doesn't need an array (no `.filter()` chains, no
`JSON.stringify` of the whole set).

```js
for await (const entity of iterateEntities({ collection: 'documents' })) {
  // process one at a time
}
```

### `queryEntities(query, options?)`

Sift filter with sort, pagination, projection, and `$`-ref expansion
(see ADR-0007).

```js
const result = await queryEntities(
  { collection: 'documents' },
  {
    sort: { 'meta.date': -1 },
    skip: 0,
    limit: 20,
    project: ['id', 'name', 'meta.title'],
    expand: ['$author', '$category'],
  }
)
// result.entities — array
// result.total — full match count before skip/limit
```

### `readEntity({ id, expand? })`

Load a single entity by id, optionally with `$`-ref expansion.

```js
const post = await readEntity({
  id: '/documents/blog/post.md',
  expand: ['$author'],
})
```

### `subscribe(filter, handler, options?)`

Subscribe to catalog changes. Two dispatch modes (see
`src/subscriptions.js`): journal-walk dispatch by default; graph
dispatch via `runtime.refs.subscribeGraph` when `options.expand` is set
so the handler fires whenever a referenced entity changes.

```js
const unsubscribe = subscribe(
  { collection: 'documents' },
  ({ operation, entity }) => { /* ... */ },
)
```

Query types throughout: function, lodash match object, or `undefined` for all.

---

## Writing source files

`updateEntity` is a catalog operation. `writeEntitySource` writes the FILE, with
the checks that make a whole-file rewrite safe to perform without having watched
the file the whole time.

### `writeEntitySource(options)`

```js
import { writeEntitySource } from 'mikser-io'

const preview = await writeEntitySource({
    id: '/documents/about.md',
    content: next,
    dryRun: true,          // writes nothing; reports what it would re-render
})

const result = await writeEntitySource({
    id: '/documents/about.md',
    content: next,
    ifChecksum: preview.currentChecksum,
})
```

| Option | Meaning |
| --- | --- |
| `id` | Catalog id of an existing entity. Alternative to the pair below. |
| `collection` + `relativePath` | Where to write. Required unless `id` is given. |
| `content` | The COMPLETE file. Anything omitted is deleted — there is no patch mode. |
| `ifChecksum` | Only write if the file's current DISK checksum equals this. |
| `dryRun` | Write nothing; return the blast radius and any advisory. |
| `awaitCycle` | Resolve once the cycle that picks the write up finishes, with its build report attached as `report`. |

**Never throws for an expected outcome.** A bad id, a path that escapes the
collection, a checksum that no longer matches — each returns
`{ ok: false, refused }` with the facts needed to retry, because those are
answers rather than faults. `refused` is one of `unresolvable-id`,
`collection-mismatch`, `incomplete-target`, `invalid-target`,
`checksum-mismatch`.

**Containment.** `relativePath` cannot leave the collection folder. This
matters because the path often comes from a request body or a CMS form, and
`path.join(folder, '../../x')` resolves outside the folder and writes there. It
is resolved and then contained rather than rejected on a literal `..`, so
`blog/../about.md` still works. The refusal happens before anything stats the
file — reporting a checksum for an out-of-tree path is a disclosure on its own.

**The precondition is not a lock.** A writer landing between the check and the
write still wins. It closes the window that matters in practice: read, think,
write back a whole file built from a copy that is now stale.

`ifChecksum` is compared against the DISK. `readEntity`'s `checksum` is the
catalog's, which lags between builds — pass `diskChecksum`, or the
`currentChecksum` a refusal hands back.

### `deleteEntitySource(options)`

Removes a source file with the same guards, plus the one only removal needs.

```js
const preview = await deleteEntitySource({ id: '/documents/old.md', dryRun: true })
// preview.referencedBy → [{ id: '/documents/page.md', field: 'hero' }]
```

Takes the same addressing, `ifChecksum` and `dryRun` as the write. `referencedBy`
reports everything still pointing at the entity — asked of the reference index
through `lookupKeys`, so a ref by served path counts exactly as invalidation
counts it, not just a ref by id. A delete is the one write with no content to
inspect afterwards, which makes the preview the only chance to see its cost.

### Change sets

Both take `changeSet` and `summary`, grouping several writes into one unit a
consumer can commit together and later take back together. See
[Change sets](#change-sets-1) below.

### Advisories

`contentAdvisories(entity, content)` names files a caller must not edit blind,
from `meta.specLocked` / `meta.generated` or from a header in the first 40
lines. Two kinds, kept apart because the instruction differs: `spec-locked`
means the bytes answer to a document outside the repo, `generated` means
editing the file is pointless because the next build overwrites it.
`advisoryWarning(advisories)` renders one line of prose for a response meant to
be read rather than parsed. Both are reported by `writeEntitySource` — on the
dry run and again on the way out, since a caller that never read the file is
exactly the one that needs telling.

`siblingDestinations(folder, relativePath)` reports files differing only by
extension, which may render to the same destination.
`locateEntityFile(id)` resolves a catalog id to its `{ collection, relativePath }`,
or `{ error }` — taken from the entity rather than by splitting the id, since the
prefix is configurable and the extension may have been stripped.

## Change sets

Which writes belong together, and who asked for them.

The engine does not otherwise care who wrote a file — a write is a write. That
holds until something wants to undo one request without touching everything
around it, and then it is the wrong resolution: an agent's three edits and a
document created through the API a second later are indistinguishable, so
removing one removes the other.

```js
await writeEntitySource({ id, content, changeSet: 'req-42', summary: 'Rewrite the hero copy' })
await deleteEntitySource({ id: other, changeSet: 'req-42' })

pendingChangeSets()
// [{ id: 'req-42', summary: 'Rewrite the hero copy', paths: [...], deletions: [...] }]
clearChangeSets(['req-42'])
```

| Export | Does |
| --- | --- |
| `withChangeSet({ changeSet, summary, principal }, fn)` | run `fn` with a set in effect |
| `currentChangeSet()` | the set in effect, or null |
| `recordChangeSetWrite({ changeSet, summary, principal, uri, operation, undoOf })` | attach one path to a set |
| `listChangeSets({ limit })` | the log, newest first |
| `findChangeSet(id)` | resolve one id |
| `pendingChangeSets()` | sets no consumer has recorded yet, oldest first |
| `markChangeSetsRecorded(ids, recordedAs)` | mark recorded, and say what as |
| `closeChangeSet(id)` | the writer is finished with this set |

`withChangeSet` takes `closeOnReturn` for the case where the call IS the whole
request — true whenever the id was minted for it rather than supplied. That is
exact, not a heuristic: an id nobody else can name cannot grow after the call
that owns it returns, so a consumer can act on it at once instead of waiting to
see whether more writes arrive. A caller-supplied id exists so several calls
can join one set, so it stays open and closes on going quiet. Closing happens
even when the request throws — work that landed before the failure is real, and
a set left open forever holds it out of reach.

The log is **durable** and survives a restart: nothing else can reconstruct
which writes belonged to one request. Not the files, which show the result and
not the grouping — and not a consumer's own history, which may not exist yet,
or at all. It keeps the most recent 200 sets.

`recordedAs` is what a consumer recorded the set as — a commit sha. Its absence
is meaningful: the set is real and listable, but there is nothing to revert
from yet. `mikser_undo` reports that as `not-yet-committed`, which is a
different answer from `unknown-change-set` and sends a reader somewhere
different.

### Ambient, not threaded

Passing an id through every write is fine for one API and hopeless across a
plugin ecosystem — `mikser-io-drive` writes with `fs.writeFile`, a rename
cascade goes through `writeEntity`, and every new mutating tool would have to
remember. `withChangeSet` puts one in scope instead, and the write primitives
attribute themselves:

```js
await withChangeSet({ changeSet: 'req-42', summary: 'Rewrite the hero copy' }, async () => {
    await useCollection(runtime, 'documents').write('hero.md', text)   // attributed
    await writeEntity({ uri }, { title })                             // attributed
})
```

`useCollection().write` / `.remove` and `writeEntity` record automatically, so
code that has never heard of change sets still produces undoable work. A plugin
writing with raw `fs` calls `recordChangeSetWrite({ uri })` with no id and
picks up whatever is in effect. An explicit id always wins over the ambient
one, and a write with neither stays unclaimed.

In `mikser-io-mcp`, a tool registered with `mutates: true` gets `changeSet` and
`summary` added to its schema and its handler wrapped in `withChangeSet`
automatically — declared once per tool rather than threaded through each write,
because a new mutating tool that forgets the plumbing is one whose edits
silently cannot be undone.

Paths come back repo-relative and POSIX-separated, ready for a git pathspec.

**Not a transaction.** Nothing is held back, nothing rolls back on failure, and
a half-finished set is a real set containing what actually landed. It is a
label on work that already happened, which is what makes it safe on a write
path that must never block. A path is claimed only after the write succeeds —
claiming on intent would make a write that never happened undoable, and undoing
it would delete whatever is actually at that path.

**Unclaimed writes stay unclaimed.** A consumer must still handle them; they
happened, and losing them would be worse than not attributing them.
`mikser-io-git` commits claimed sets to their own scoped commits and sweeps the
rest into unattributed ones, which is what lets it offer undo for the first and
not the second.

The engine records the grouping and takes no position on what is done with it —
it knows nothing about commits, branches or reverts. Versioning the paths
together is one use; a snapshot, an audit trail, a draft-then-publish gate or a
filesystem-level rollback all want the same fact. That is why change sets live
in core and git does not.

## Search

`queryEntities` sifts **meta**. `searchEntities` answers the other question —
*where does this text appear?* — across structured values, source files and
built output.

### `searchEntities(options)`

```js
import { searchEntities } from 'mikser-io'

const { hits, count, truncated } = await searchEntities({
    query: 'NOVAPRESS',
    in: ['meta', 'content'],   // default
})
```

| Option | Meaning |
| --- | --- |
| `query` | Text to find. A plain substring unless `regex` is true. Required. |
| `in` | `'meta'`, `'content'`, `'output'`. Default `['meta', 'content']`. |
| `collection` | Restrict to one collection. |
| `filter` | Sift filter narrowing **what may be searched at all** — see below. |
| `regex` | Treat `query` as a JavaScript regular expression. |
| `ignoreCase` | Case-insensitive matching. Default false. |
| `limit` | Maximum hits (default 50). `truncated` says when it stopped early. |

The three scopes answer different questions and none implies another. `meta`
walks structured values as dotted paths and touches no files. `content` reads
the **source**. `output` walks the **built** folder and reports `occurrences`
per destination — the blast-radius question, and the one where a string can be
present because a layout writes it, with no source entity containing it
anywhere.

Whether a file is text is decided by reading its bytes, not by its extension,
so a `.njk` source or a `.webmanifest` output is searched without first being
added to a list of known formats.

`truncated` is load-bearing: it separates "these are the hits" from "these are
the first N", which a caller acting on a blast radius cannot afford to guess.

> **Unscoped by default.** A bare call reads every entity and every source
> file — drafts, unpublished documents, layouts, sidecar JavaScript. The `api`
> plugin narrows `list` through each endpoint's own sift scope; nothing
> narrows this. Anything that puts search behind a request **must** pass that
> same scope as `filter`, or a public endpoint listing only published
> documents will happily search the unpublished ones. There is deliberately no
> `search` operation in the `api` plugin and no route in this module.

### Primitives

Exported so a caller building a different question out of the same parts does
not reimplement them: `countMatches`, `snippetAround`, `lineOfFirstMatch`,
`flattenMeta`, `findOccurrences`, `walkFiles`.

`findOccurrences(text, needle)` returns every occurrence with `line`, `col`,
the line's `text`, and `leading` — whether the match begins its line. That one
flag separates the file **declaring** something from the files merely using
it, in any text format, with no per-language grammar involved. It returns the
line rather than a verdict about it, so where the heuristic is wrong the
evidence is in the result.

## Content

Reading an entity's source, and deciding what "source" even means for it.

### `readEntityContent(entity, { reload } = {})`

Returns one of `{ content }`, `{ contentError }`, `{ contentSkipped }` — an
object to `Object.assign` onto the entity, or use directly. Dispatches by URI
scheme: plain paths and `file://` read from disk, `http(s)://` goes through the
built-in provider, anything else dynamic-imports `mikser-io-provider-<scheme>`.

`entity.content` already being a string short-circuits the whole dispatch, which
spares re-fetching a remote document a source plugin eagerly pulled in. Pass
`reload: true` when you want the bytes **as they are now** — between builds the
catalog copy and the file on disk part ways, and a whole-file rewrite built from
the catalog copy silently discards whatever changed underneath. An entity with
no `uri` keeps what it has rather than erroring.

### `looksTextual(buffer)` / `isTextEntity(entity)`

`looksTextual` answers "is this text?" from the BYTES: no NUL and a clean UTF-8
decode. This is what decides whether content comes back, and it is why a
`.liquid`, `.njk`, `.toml` or a format nobody has written yet is readable
without being added to a list first.

`isTextEntity` is a cheap extension guess with no I/O. It is a **hint** — the
extension list behind it is hand-maintained and therefore wrong about anything
not yet added. Never gate a read on it.

### `mimeForEntity(entity)`

Content type for the entity's `destination`, from the IANA registry via
`mime-types`. Null when the entity has no destination or the extension is
unregistered.

### `checksumOf(content)` / `checksum(uri)`

`checksumOf` hashes a string; `checksum` hashes a file, sampling head and tail
for large ones rather than reading the whole thing.

## Collections and sources

### `useCollection(runtime, name)`

The folder behind a collection, and guarded writes into it.

```js
const documents = useCollection(runtime, 'documents')
documents.folder                          // absolute path
await documents.write('blog/post.md', text)
await documents.remove('blog/post.md')
documents.resolveWithin('blog/post.md')   // absolute path, or throws
```

`write`, `remove` and `resolveWithin` refuse a path that resolves outside the
collection folder. This matters whenever the path comes from a request body or
a form: joining a folder with `../../x` lands outside it. The path is resolved
and then contained rather than rejected on a literal `..`, so `blog/../post.md`
still works.

### `useSource(core, options)`

Codifies the folder-of-files pattern: scan a folder, emit entities, watch for
changes, sweep deletions.

| Option | Meaning |
| --- | --- |
| `collection`, `type`, `folder` | Required. |
| `extensions` | Default `['*']`. |
| `ignore` | Glob patterns to skip. |
| `phase` | `'loaded'` (default) or another lifecycle phase. |
| `content` | Load file content into the entity at sync time. |
| `load` | `async (entity) => meta` — your parse step. |
| `idPrefix` | Defaults to `/<collection>`. |
| `stripExtensionFromId` | Default false (documents style). |
| `progress` | Progress label. |

### `sweepDeleted(collection, scanned, onDelete, ownerPrefix)`

Removes catalog entities whose files are gone. **`ownerPrefix` is mandatory and
load-bearing.** Collections are multi-emitter: the file source scans a folder,
but a CSV plugin fans rows into the same collection, and a remote sync emits
there with a `gdrive://` uri. The sweep only considers entities whose `uri` is
rooted under the prefix — without it, every cycle's file sweep wipes every
other emitter's entities.

### `useRenderer(runtime, { defaultTimeout } = {})`

Returns `{ render }` — the batching renderer the engine dispatches through,
with a per-task timeout (default 30s). A plugin that needs to render something
outside the normal cycle goes through this rather than importing a renderer
package directly.

## Query context

`queryContext` is the `AsyncLocalStorage` that lets a catalog query made during
a render record itself as a dependency, so an aggregate page invalidates when a
new matching entity lands.

It only works if the whole tree shares ONE module instance of `mikser-io`. In
the side-by-side dev layout that means the npm workspace at the parent folder
is not ergonomics but correctness: without it, npm installs a second copy into
a sibling's own `node_modules`, a plugin's `queryContext` is then a different
AsyncLocalStorage than the engine's, queries record no edges, and index pages,
sitemaps and feeds silently stop rebuilding. Production consumers resolve both
from their own tree, so the problem is local to the dev workspace.

## Roles

Enforcement needs only the flat capability list. Explaining a refusal needs the
role — and without it, an admin token and a site with no roles configured are
indistinguishable from inside a session.

| Export | Does |
| --- | --- |
| `describeAuthority({ capabilities, roles, catalogue, summaries })` | everything a session can say about its own authority |
| `reachOf(capabilities)` | `{ writable, readOnly }` as collection names |
| `actingRole(held, catalogue)` | which role is in force |
| `rolesIn(catalogue, { acting, summaries })` | every role and its reach, the acting one marked |
| `explainRefusal({ capability, role, target, catalogue, summaries })` | the sentence an agent repeats |

`readOnly` is the field that makes a refusal explainable, and it is more useful
than the capabilities it comes from because it is already in the vocabulary the
person asking uses.

A principal can hold several roles. `actingRole` returns the one whose
capabilities cover the others — roles are normally written as widening tiers —
and `null` when none dominates, because the acting authority genuinely is the
union and naming half of it would be a lie.

`roles` lists every role, not only the ones the session lacks. One field has to
serve two readers: someone deciding who to ask, and someone holding the widest
role trying to see what exists at all — and a "roles you do not have" field
tells the second one nothing, since for an admin it is always empty.

> **Informational, permanently.** Naming the role that could do something is
> what makes a handoff possible. There is no way to request one and none should
> be added: a role is a decision about a person, taken by whoever configures the
> site, and an agent's part is to say what it cannot do and stop. `explainRefusal`
> deliberately suggests no retry, escalation or workaround — a test asserts it.

## Auth

Building a token-gated or loopback-only route.

| Export | Does |
| --- | --- |
| `resolveAuth(config)` | build a verifier from endpoint config |
| `requireAuth(verifier, options)` | Express middleware |
| `authorize(req, verifier, { allowRemote, trustLoopback })` | the check itself |
| `bearer({ token, name, subject, capabilities, scope })` | a static-token verifier |
| `loopbackOnly({ message })` | middleware refusing non-loopback callers |
| `hasCapability(principal, capability)` | test a resolved principal |

A principal may carry a `scope` — a sift filter that narrows what it can see.
Anything reading content on a principal's behalf must apply it; see the warning
under [Search](#search) for why an unscoped read behind a scoped endpoint is
the failure mode to watch for.

## References

The `$`-keyed reference graph (ADR-0007), reachable at `runtime.refs` or via
`useRefsIndex()`.

| Method | Answers |
| --- | --- |
| `inboundFor(target)` / `outboundFor(source)` | static `$`-ref edges |
| `dynamicInboundFor` / `dynamicOutboundFor` | render-time edges (layout, partial, query, lookup) |
| `inverseClosureOf(seeds)` | everything reachable backwards — what invalidation walks |
| `resolveRefIds(ref)` | which entities a ref string resolves to |
| `rename({ from, to })` | rewrite refs across the catalog, as one cascade |
| `allRefs()` / `size()` | inventory |

### `refFilter(ref)` / `matchesRef(entity, ref)` / `lookupKeys(entity)`

One relation in three directions — as a catalog query, as a predicate, and in
reverse. **They must be changed together.** A key present in one and missing
from the others is silent: `meta.url` once lived only in `refFilter`, which
made every `$`-ref to a served path non-invalidating without any error
anywhere.

### `extractRefs(meta)` / `isRefKey(key)` / `expandEntity(entity, paths, options)` / `projectMeta(meta)`

Find the `$`-keys in a meta tree, test one key, inline referenced entities
along dotted paths, and drop `$`-keys for output.

## Provenance

Where a value was **written** — source file, field path, line, column.

```js
const positions = await useProvenance().positionsFor(entity)
// { 'items[2].label': { line, col }, … }
```

| Method | Answers |
| --- | --- |
| `positionsFor(entity)` | every leaf of the entity's meta |
| `locate(entity, fieldPath)` | one position, or null |
| `forget(id)` | drop a cached entry |
| `size()` | how many entries are cached |

Field paths are free — they come from walking meta, already in memory. Line and
column need one parse of the raw source, done **on demand** and cached against
the entity's checksum, so a build pays nothing.

`registerProvenanceFormat(name, { test, positions })` adds a format rather than
special-casing one. A format whose parser reports no ranges registers a
`probeFormat(name, { test, parse })` instead, which recovers positions in one
pass without the parser's help.

## Manifest and outputs

`runtime.manifest` holds render snapshots. Full treatment lives in
[diagnostics.md](diagnostics.md) — indexed by the question each surface
answers — but the ones an application reaches for:

| Method | Answers |
| --- | --- |
| `affectedBy(entity)` | which destinations would re-render if this changed |
| `collisions()` | destinations more than one entity writes to |
| `snapshotsFor(id)` / `snapshotsAt(destination)` | what rendered, and from what |
| `skipDecision(entity, …)` | the engine's own skip rule, with the reason |

`sourcesOf(destination)` is the reverse lookup: what produced this built file,
each tagged with how it got there. `sourcesBehind(snapshot)` does the same from
a snapshot you already hold. `resolveOutputPath(destination)` maps a
destination to a path on disk, and `writeOutput(file, bytes)` writes one.

## Tools

The tool registry — named, described, invokable capabilities. Two agent
workflows exist and are equally real: one speaking MCP over HTTP, one running
the CLI and reading its output. A tool registered here reaches both.

```js
registerTool('audit', {
    description: 'What this answers, in prose an agent will actually read.',
    inputSchema: { path: { type: 'string', required: true } },
}, async ({ path }) => ok({ … }))
```

`invokeTool(name, args)` runs one — it accepts the bare name or the `mikser_`
prefixed form. `toolNames()`, `toolSchema(name)` and `toolSchemas()` enumerate.
`toolResultText(result)` pulls the text back out of a tool result, and
`toolResultFailed(result)` says whether it failed.

The registry is deliberately zod-free: schemas use a neutral
`{ type, required?, description? }` vocabulary, because it must not depend on
one transport's schema library. `mikser-io-mcp` converts to zod at bind time.

## Routes

An Express router stack has the paths but not the intent. Plugins declare each
mount as they make it, so a facade generator, a healthcheck list or a
diagnostics view can read one inventory.

```js
registerRoute({
    path: '/api',
    plugin: 'api',
    reachability: 'public',   // 'public' | 'token' | 'loopback'
    streaming: false,         // true for SSE/WS, which a facade must not buffer
})
```

`registerRoute` also folds in the origin/URL building and the standard boot
log. `listRoutes()` returns the inventory; `reachabilityOf` and `routeLocation`
answer about one route. `isLoopback(ip)` is the check behind
`reachability: 'loopback'` — note that the server's trust-proxy default is
`'loopback'`, not Express's `false`, which is what keeps that gate correct
behind a same-host reverse proxy.

## Cycles and the build report

`nextCycleId()` reserves the id of the cycle a pending change will be picked up
by; `whenCycleCompletes(id)` resolves once it finishes, with its report.
Together they turn "write and guess" into one call that says what the edit
invalidated. `currentCycle()` and `buildReport()` read the cycle in progress and
the last completed report.

## Logging

`addLogTransport({ target, options, level })` adds a pino transport from a
plugin factory or any later hook. Called before the logger is built, it queues;
after, it live-rebuilds the multistream. This is what lets Better Stack,
Datadog, Loki, Axiom or Sentry ship as ordinary sibling plugins with no engine
change per vendor.

Prefer this over `runtime.config.logging.transports` from plugin code — the
declarative form is for user config.

## Junk

`registerJunk({ ignore, match })` teaches the engine to skip editor and OS
debris; `isJunkPath(filePath)` asks.

## What is not here

Plugin factories — `yaml()`, `json()`, `frontMatter()`, `assets()`,
`resources()`, `shares()`, `observer()`, `mapper()`, `commands()`,
`renderHbs()` — are configured rather than called, and live in
[configuration.md](configuration.md).

`mikser-io` exports more than this page covers, deliberately. Five kinds of
export are engine plumbing:

- **Factories the engine calls once** — `createManifest`, `createRefs`,
  `createProvenance`, `createSqliteDatabase`, `createTrack`, `createIndex`,
  `createSubscribers`.
- **Schema constants** the test suites build against rather than copying —
  `SNAPSHOTS_SCHEMA`, `REFS_SCHEMA`, `FAILURES_SCHEMA`, `PROVENANCE_SCHEMA`.
- **Report and cycle internals** — `reportRendered`, `reportSkipped`,
  `reportError`, `emitReport`, `resetReport`, `finishCycle`, `inputHashOf`.
- **Render-time tracking** — `recordReads`, `untrack`, `trackedInfo`,
  `serializeTrack`, `mergeTrack`, `observeConsumed`. These implement
  dependency recording; a plugin observes its RESULTS through
  `runtime.manifest` and `runtime.refs` instead.
- **Template helper plumbing** — `assetUrlHelper`, `resourceUrlHelper`,
  `hrefUrlHelpers`, `fileHelpers`, `renderPreset`, wired into renderers rather
  than called.

They are exported because the engine's own modules and its test suite need them
across file boundaries, not as an invitation. If you find yourself reaching for
one from a plugin, that is worth raising — it usually means a capability is
missing from the surface above.

## Database

```js
import { registerSchema, useDatabase } from 'mikser-io'
```

The engine substrate is a single sqlite file at
`{runtimeFolder}/mikser.sqlite` (filename overridable via
`runtime.config.database.filename`, including `':memory:'`). Plugins
that need their own persistence reach it through these two helpers —
never by opening a second file.

### `registerSchema(name, sqlScript, { durable } = {})`

Register a CREATE-TABLE-IF-NOT-EXISTS SQL block. All registered schemas
are applied during `onLoaded`, after the engine's own tables
(`mikser_entities`, `mikser_refs`, `mikser_snapshots`, `mikser_journal`,
`mikser_meta`) and before any plugin's `onLoaded` runs.

**`durable`** (default `false`) — keep these tables when the cache is
wiped. The engine wipes on a schema-version change (any upgrade) and on a
config-checksum change (any deploy that edits `mikser.config.js`), because
per ADR-0002 the files are the source of truth and the database is derived.
That holds for anything rebuildable and fails for anything that is not: an
OAuth client registration, a refresh token, a received form submission
cannot be recreated from the working folder, and losing them is silent —
the first sign is a user being asked to sign in again after an unrelated
deploy.

Mark those `durable: true` and the wipe drops every other table instead of
deleting the database file. Leave it off for anything you can rebuild:
stale derived rows surviving an upgrade is the failure the wipe exists to
prevent.

```js
registerSchema('my_plugin_data', `
  CREATE TABLE IF NOT EXISTS my_plugin_data (
    id TEXT PRIMARY KEY,
    payload TEXT
  );
  CREATE INDEX IF NOT EXISTS my_plugin_data_id ON my_plugin_data(id);
`)
```

### `useDatabase()`

Returns the shared `better-sqlite3` handle. Available from `onLoaded`
onward. Use it to prepare statements once and reuse them.

```js
let stmtUpsert
onLoaded(async () => {
  const db = useDatabase()
  stmtUpsert = db.prepare(`INSERT INTO my_plugin_data(id, payload) VALUES (?, ?)
                           ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`)
})
```

`mikser_meta.schema_version` is stamped automatically so subsequent runs
can detect schema drift.

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

Dispatch modes for render and postprocess jobs.

| Key | Value | Description |
|-----|-------|-------------|
| `TASKS.INLINE` | `'inline'` | Main-thread async, concurrent via p-map (default) |
| `TASKS.SERIAL` | `'serial'` | Main-thread, sequential via p-queue (concurrency 1) |
| `TASKS.WORKER` | `'worker'` | Piscina worker thread (lazy pool, `minThreads: 0`) |

Layouts opt into worker dispatch via `task: worker` in frontmatter; the
default is `INLINE` for both render and postprocess.

# Entities, Journal & Catalog

## Entities

An entity is the fundamental unit of data in Mikser. Everything that gets processed — a Markdown document, an image file, a layout template, an API record — is represented as an entity object.

### Base Entity Shape

```js
{
  // Identity
  id: '/documents/blog/post.md',    // Unique identifier (usually URI-like path)
  uri: '/project/content/blog/post.md',  // Absolute source path
  name: 'blog/post',                // Display name (usually path without extension)
  collection: 'documents',          // Plugin-defined group name
  type: 'document',                 // Plugin-defined type name
  format: 'md',                     // File extension / content format

  // Timing
  stamp: 1716000000000,             // runtime.stamp — same for all entities in a run
  time: 1716000001234,              // Date.now() at creation

  // Content
  source: '/project/content/blog/post.md',  // Path to read content from
  content: '# Hello World\n...',    // Raw file contents (text formats)
  checksum: 'abc123def456',         // MD5 checksum of source file

  // Enriched by plugins
  meta: {                           // Structured metadata (front-matter, JSON, YAML)
    title: 'Hello World',
    date: '2024-01-01',
    tags: ['intro', 'guide']
  },

  // Set by layouts plugin
  layout: { /* layout entity */ },  // Matched layout object
  destination: '/project/out/blog/post/index.html',  // Target output path
  page: 1,                          // Current page (pagination)
  pages: 3,                         // Total pages

  // Set by assets plugin
  preset: {
    name: 'thumbnail',
    format: 'webp',
    options: { width: 300 },
    checksum: 1
  },

  // Set by resources plugin
  resources: ['https://cdn.example.com/lib.js']
}
```

Not all fields are present on every entity. Fields are added by the plugins that understand them.

### Operations

Every change to an entity is recorded as a journal operation:

| Operation | Constant | Description |
|-----------|----------|-------------|
| `CREATE` | `OPERATION.CREATE` | Entity is new |
| `UPDATE` | `OPERATION.UPDATE` | Entity has changed |
| `DELETE` | `OPERATION.DELETE` | Entity has been removed |
| `RENDER` | `OPERATION.RENDER` | Entity needs to be rendered |
| `POSTPROCESS` | `OPERATION.POSTPROCESS` | Entity needs to be postprocessed |

### Entity Match Patterns

Several APIs (mapper, validator, layouts `match`) accept a pattern to filter entities:

```js
// Function — most flexible
match: entity => entity.collection === 'documents' && entity.format === 'md'

// String starting with @/ — minimatch against entity.name
match: '@/blog/*'        // matches blog/post, blog/intro, etc.
match: '@/**/*.md'       // matches any .md file

// Plain string — minimatch against entity.id
match: '/documents/**'

// Object — lodash isMatch (deep partial match)
match: { collection: 'documents', format: 'md' }
```

---

## Journal

The journal is the per-cycle producer/consumer queue every phase reads
from and writes to. It lives as the `mikser_journal` table inside the
engine's sqlite file (`{runtimeFolder}/mikser.sqlite`) — same substrate
as the catalog, refs graph, and render snapshots (see
[ADR-0009](./decisions/0009-database-engine-substrate.md)). Rows are
written on `createEntity` / `updateEntity` / `deleteEntity` /
`renderEntity` / `postprocessEntity`, drained on the matching phase,
and cleared at `onFinalized` (`DELETE FROM mikser_journal`).

Because the table survives crashes, an interrupted run can be resumed
with `mikser --resume`: the engine picks up the leftover rows and
skips the initial filesystem scan.

### Journal Schema

```sql
CREATE TABLE mikser_journal (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT,    -- CREATE | UPDATE | DELETE | RENDER | POSTPROCESS
  entity    TEXT,    -- JSON-serialized entity
  context   TEXT,    -- JSON-serialized context
  options   TEXT,    -- JSON-serialized render/postprocess options
  output    TEXT,    -- JSON-serialized result (success, destination, etc.)
  deps      TEXT     -- JSON-serialized dependency hashes
)
```

### Writing to the Journal

```js
import { createEntity, updateEntity, deleteEntity, renderEntity, renderEntities } from 'mikser-io'

// Add a CREATE operation
await createEntity({
  id: '/posts/hello',
  collection: 'posts',
  type: 'post',
  format: 'md',
  name: 'hello',
  source: '/project/content/hello.md'
})

// Add an UPDATE operation
await updateEntity({ ...existingEntity, checksum: newChecksum })

// Add a DELETE operation
await deleteEntity({ id: '/posts/hello', collection: 'posts', type: 'post' })

// Queue a single render job
await renderEntity(entity, { renderer: 'hbs', tasks: TASKS.INLINE }, contextData)

// Queue multiple render jobs (batched for efficiency)
await renderEntities([
  { entity: e1, options: { renderer: 'hbs' }, context: {} },
  { entity: e2, options: { renderer: 'hbs' }, context: {} }
])
```

`createEntity` and `updateEntity` automatically set `entity.stamp` (current run timestamp) and `entity.time` (current wall clock time) before inserting.

### Reading from the Journal

```js
import { useJournal } from 'mikser-io'

// Async generator — yields journal entries one by one
for await (const { id, entity, operation, context, options, output } of useJournal(
  'Processing documents',        // Progress bar label
  ['CREATE', 'UPDATE'],          // Filter by operation types (omit for all)
  signal                         // AbortSignal for cancellation
)) {
  // Mutate the yielded entity and move on — auto-persist diffs after each
  // iteration and UPDATEs the journal row if it changed.
  entity.meta.slug = entity.name.split('/').pop()
}
```

`useJournal` shows a progress bar automatically. The walk is paged in
chunks of 500 (`CHUNK_SIZE`) so peak memory stays bounded regardless of
corpus size. Snapshot semantics: rows inserted during iteration are not
visible to the walk that's already in progress — if you need to react to
new rows, kick off a fresh `useJournal` in a later phase.

**Auto-persist.** Whatever you mutate on the yielded entity is detected
post-yield and written back. `updateEntry` is still exported for
engine-internal output / deps writes (and as an explicit no-op safety
valve), but plugin code that just mutates the entity doesn't need to
call it.

### Low-level Journal Access

```js
import { addEntry, addEntries, updateEntry } from 'mikser-io'

// Insert a raw entry (no stamp/time injection)
await addEntry({ entity, operation: 'CREATE', context: {}, options: {} })

// Batch insert (chunked in groups of 10)
await addEntries([
  { entity: e1, operation: 'CREATE', context: {}, options: {} },
  { entity: e2, operation: 'UPDATE', context: {}, options: {} }
])

// Update an existing entry (e.g. after rendering)
await updateEntry({ id: journalId, output: { success: true, result: '/out/page.html' } })
```

---

## Catalog

The catalog is a persistent registry of all entities across all runs. Unlike the journal (which is ephemeral), the catalog is kept between runs and used for incremental change detection.

**Location:** `mikser_entities` table inside `{runtimeFolder}/mikser.sqlite` (see [ADR-0009](./decisions/0009-database-engine-substrate.md) for the design rationale).

### Structure

The table has indexed columns for the routinely-queried dimensions
(`id` PK, `collection`, `type`, `format`, `name`, `meta_href`,
`meta_layout`, `meta_lang`, `meta_cache`, `time`, `uri`) plus a `data`
column holding the full entity body as JSON TEXT. `findEntities()`
queries push predicates on the indexed columns down to SQL; the
remainder runs as JS-side sift on the materialized subset.

### Querying the Catalog

```js
import { findEntity, findEntities, iterateEntities, queryEntities } from 'mikser-io'

// Find one entity matching a sift query
const entity = await findEntity({ id: '/documents/blog/post.md' })

// Find all entities matching a query — pushed to SQL because
// `collection` and `format` are indexed columns
const blogPosts = await findEntities({ collection: 'documents', format: 'md' })

// Find with a function — runs JS-side against the full scan
const recent = await findEntities(e => e.meta?.date > '2024-01-01')

// Find all entities (no query = return all). This works, but inside a
// render's queryContext (sidecar load(), template helpers) it records a
// null query dep that conservatively invalidates on every mutation.
// The engine warns when this happens. For "all renderable entities"
// use the more precise shape below instead.
const everything = await findEntities()

// Streaming variant — yields entities one at a time, seek-paginated.
// Use it when results may be corpus-scale and you don't need an array.
for await (const post of iterateEntities({ collection: 'documents' })) {
  // process one at a time, no full materialization
}

// Sort / paginate / project / expand $-refs (ADR-0007)
const { entities, total } = await queryEntities(
  { collection: 'documents' },
  { sort: { 'meta.date': -1 }, limit: 20, expand: ['$author'] }
)
```

### Query filters and incremental invalidation

Inside a render's `queryContext` (sidecar `load()`, template helpers, anything inside `runtime.process()`), every `findEntities` / `iterateEntities` / `queryEntities` call records its filter into the rendered entity's `refClosure`. On the next cycle, `manifest.shouldSkip` and `manifest.queryAffected` sift-match each filter against this cycle's mutated entities — if anything matches, the aggregate re-renders.

That means **the filter you write determines what invalidates your aggregate.** Two anti-patterns to avoid:

```js
// Filter-after-fetch — null filter recorded, invalidates on EVERY mutation
const all = await findEntities()
const posts = all.filter(e => e.meta?.layout === 'post')

// Same shape with JS predicate — also records as null
const recent = await findEntities(e => e.meta?.date > '2024-01-01')
```

The engine surfaces a one-time warning per offending entity when this happens. Fix by pushing the filter into the query:

```js
// Posts only — invalidates only when entities with meta.layout='post' change
const posts = await findEntities({ 'meta.layout': 'post' })

// All renderable entities — for a true sitemap; invalidates only on
// changes to entities that produce output, not on files / assets / etc.
const sitemap = await findEntities({ 'meta.href': { $exists: true } })

// Combined indexed scope — pushes down to SQL
const recent = await findEntities({
  collection: 'documents',
  type: 'document',
  format: 'md',
})
```

Indexed columns that push down (other clauses fall through to JS-side sift over the materialized subset):

| column | filter shape | typical use |
|---|---|---|
| `id` | `{id: '/path/to/entity'}` | direct lookup |
| `collection` | `{collection: 'documents'}` | scope by source type |
| `type` | `{type: 'document'}` | scope by semantic type |
| `format` | `{format: 'md'}` | scope by file extension |
| `name` | `{name: 'index'}` | name match |
| `meta.href` | `{'meta.href': {$exists: true}}` | renderable-only scope |
| `meta.layout` | `{'meta.layout': 'post'}` | layout-keyed scope |
| `meta.lang` | `{'meta.lang': 'en'}` | language scope |
| `meta.cache` | `{'meta.cache': 0}` | the cache opt-out partition |
| `time` | `{time: {$gt: 1700000000000}}` | recency |
| `uri` | `{uri: {$regex: '...'}}` | path patterns |

For relationship-driven aggregates ("all posts by Dick"), prefer the refs index over a query — the closure walk handles invalidation precisely without recording a query dep at all:

```js
const postIds = runtime.refs.inboundFor('/authors/dick.yml')
const posts = postIds.map(id => findEntity({ id }))
```

### Catalog in Plugins / Render Templates

Use the public ops — they go through the AsyncLocalStorage query-context
so refs can track dependencies and the sift→SQL translator pushes
predicates down to indexed columns:

```js
import { findEntities, findEntity, iterateEntities } from 'mikser-io'

const docs = await findEntities({ collection: 'documents' })
const post = await findEntity({ id: '/documents/blog/post.md' })

// The facade also lives on the runtime singleton:
//   runtime.catalog.findEntities(...) etc.
```

### Catalog vs Journal

Both live in the same sqlite file (`runtime/mikser.sqlite`), different
tables.

| | Journal | Catalog |
|--|---------|---------|
| Lifetime | One cycle (per-`process()` invocation in watch mode) | Persistent across runs |
| Purpose | Per-cycle producer/consumer queue between phases | Entity registry, queryable substrate |
| Storage | `mikser_journal` table | `mikser_entities` table |
| Rows | CREATE / UPDATE / DELETE / RENDER / POSTPROCESS | Current entity state, indexed for sift→SQL pushdown |
| Cleared | Yes, at `onFinalized` (`DELETE FROM mikser_journal`). Leftover rows survive crashes for `--resume`. | No — updated incrementally during persist |

The catalog is updated during the `persist` phase by reading CREATE/UPDATE/DELETE operations from the journal and applying them inside a single transaction.

---

## Change Detection

Plugins use checksums to avoid re-importing unchanged files:

```js
import { checksum, findEntity, createEntity, updateEntity } from 'mikser-io'

onImport(async () => {
  for (const file of await globby('**/*.md', { cwd: docsFolder })) {
    const id = `/docs/${file}`
    const uri = path.join(docsFolder, file)
    const hash = await checksum(uri)

    const existing = await findEntity({ id })

    if (!existing) {
      await createEntity({ id, uri, checksum: hash, ... })
    } else if (existing.checksum !== hash) {
      await updateEntity({ ...existing, checksum: hash })
    }
    // If checksum matches: no journal entry → no processing
  }
})
```

This pattern is used by all built-in source plugins (documents, files, layouts) to ensure only changed entities are processed during incremental builds.

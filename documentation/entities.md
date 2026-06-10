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

The journal is a temporary SQLite database that tracks all operations in the current run. It is created fresh at the start of each run and destroyed at finalization.

**Location:** `{runtimeFolder}/journal.db`

### Journal Schema

```sql
CREATE TABLE operations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT,    -- CREATE | UPDATE | DELETE | RENDER
  entity    TEXT,    -- JSON-serialized entity object
  context   TEXT,    -- JSON-serialized context object
  options   TEXT,    -- JSON-serialized render options
  output    TEXT     -- JSON-serialized render result
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
await renderEntity(entity, { renderer: 'hbs', tasks: 'POOL' }, contextData)

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
  console.log(entity.id, operation)
}
```

`useJournal` shows a progress bar automatically. Results are paginated internally (1000 rows per page) to keep memory usage bounded.

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
import { findEntity, findEntities } from 'mikser-io'

// Find one entity matching a sift query
const entity = await findEntity({ id: '/documents/blog/post.md' })

// Find all entities matching a query — pushed to SQL because
// `collection` and `format` are indexed columns
const blogPosts = await findEntities({ collection: 'documents', format: 'md' })

// Find with a function — runs JS-side against the full scan
const recent = await findEntities(e => e.meta?.date > '2024-01-01')

// Find all entities (no query = return all)
const everything = await findEntities()
```

### Catalog in Plugins / Render Templates

Use the public ops — they go through the AsyncLocalStorage query-context
so refs can track dependencies and the sift→SQL translator pushes
predicates down to indexed columns:

```js
import { findEntities, findEntity } from 'mikser-io'

const docs = await findEntities({ collection: 'documents' })
const post = await findEntity({ id: '/documents/blog/post.md' })

// Available as runtime.catalog in templates via the data render plugin
```

### Catalog vs Journal

| | Journal | Catalog |
|--|---------|---------|
| Lifetime | One run | Persistent |
| Purpose | Track changes in current run | Entity registry across runs |
| Format | In-memory queue | `mikser_entities` table in sqlite |
| Operations | CREATE, UPDATE, DELETE, RENDER, POSTPROCESS | Stores current entity state |
| Cleared | Yes, at `onFinalized` | No (updated incrementally) |

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

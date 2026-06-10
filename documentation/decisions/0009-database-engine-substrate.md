# ADR-0009 — Sqlite is the engine's persistence substrate

**Status:** Accepted
**Date:** 2026
**Supersedes:** —
**Superseded by:** —

## Context

Three engine subsystems — catalog, refs, manifest — each grew their own
persistence shape over time:

- **Catalog** — `Map<id, entity>` in memory, NDJSON snapshot at
  `runtime/catalog.ndjson`. Full-file rewrite on every persist.
- **Refs** — inverse-reference graph (`$`-keyed edges per ADR-0007),
  rebuilt from the catalog every `onPersist`. Pure in-memory Maps.
- **Manifest** — render snapshots (inputHash, outputHash, refClosure)
  in an in-memory Map, NDJSON at `runtime/manifest.ndjson`, again
  full-file rewrite per cycle.

Each subsystem also held a duplicated cross-cutting concern: the layouts
plugin maintained a `state.layouts.sitemap` mirror so render workers
could resolve `href` lookups synchronously. At 14k realistic entities
that mirror was ~100MB — reserialized to each Piscina worker for every
render task.

Two failure modes piled up:

1. **Catalog-file watch-mode ceiling at ~100MB.** Full-file NDJSON
   rewrite at every persist crosses the human-perception threshold for
   "instant" rebuild somewhere around 200-300ms — typically at ~100MB
   on-disk. Beyond that, watch-mode rebuilds visibly stutter on save.
2. **Memory growth that wasn't bounded by activity.** At 50k realistic
   entities, RSS hit 1.17GB just to *hold* the catalog at rest — no
   work in flight, no dispatch happening. At 110k realistic, the
   process OOMed. The architecture had a corpus-size ceiling well
   below what users were starting to reach.

The naive sqlite swap had been tried before (`node:sqlite` direct
driver, one-shot prepared statements, batched VALUES inserts) and
**measured worse on every metric** — see CLAUDE.md's earlier note:
warm cycles +59% slower, RSS +124-170% larger at 14k-50k realistic.
The reason was specific: the engine iterates `findEntities()` several
times per cycle (layouts onLoaded rebuild, source-sweep Deleted,
plugin lookups), and `all-rows + per-row JSON.parse` from sqlite was
~100× slower than walking an already-parsed in-memory Map. Sqlite
saved the write cost (~1ms vs ~300ms at 100MB) but paid it back many
times over on every scan.

That earlier conclusion held: a 1:1 driver swap is not the answer.
What *is* the answer is a different design — sift→SQL pushdown for
indexed columns so common queries don't materialize the table, an
LRU cache for `findById` so hot lookups bypass parsing, and the same
sqlite instance shared by *every* persistent subsystem so the file is
the synchronization point.

## Decision

### Single database file, schemas registered per subsystem

One `runtime/mikser.sqlite` file. WAL mode + `synchronous=NORMAL` +
`foreign_keys=ON`. Every persistent subsystem registers its schema via
`registerSchema(name, sql)` at module-eval time; the database is
opened once in `onInitialize` and applies all registered schemas
before any plugin hook runs. Subsystems then call `useDatabase()` to
get the handle.

Tables (all `mikser_` prefixed for namespace clarity, matching the
vector plugin's convention):

- **`mikser_meta`** — engine bookkeeping (schema_version, etc.)
- **`mikser_entities`** — catalog. PK on `id`. Indexed columns for
  the routinely-queried dimensions: `collection`, `type`, `format`,
  `name`, `meta_href`, `meta_layout`, `meta_lang`, `meta_cache`,
  `time`, `uri`. Full entity body in `data` (JSON TEXT).
- **`mikser_refs`** — inverse-reference graph (ADR-0007). FK to
  `mikser_entities` with `ON DELETE CASCADE` so refs disappear with
  their source. Indexed on `target` for inbound lookups, on `source`
  for outbound.
- **`mikser_snapshots`** — manifest. PK `(id, destination)`,
  `refClosure` as JSON, partial index on `parent` for two-stage
  rebuild dispatch.

Plugins reach the same primitives — `mikser-io-vector`'s sqlite-vec
mode writes to a *separate* file but follows the identical
`registerSchema` shape. Anything a plugin needs to persist beyond
in-memory state goes through the engine's database.

### Sift → SQL translator with indexed pushdown

`findEntities(filter)` accepts sift-shaped queries. The translator
(`src/database/sift-to-sql.js`) pushes indexed clauses down to SQL —
$eq/$ne/$lt/$lte/$gt/$gte/$in/$nin/$exists/$regex on any column in the
`INDEXED_COLUMNS` map. Un-pushable clauses become a residual JS-side
sift filter that runs on the materialized subset. Worst case is a full
scan + sift, matching the old Map's behavior; best case (and the
common case) hits an index and never touches `JSON.parse` for filtered-
out rows.

`$or`/`$and` recursively translate when every sub-clause is fully
push-able; mixed-translatability collapses the whole logical clause to
JS to keep semantics correct.

### LRU cache for findById

The `findById` hot path (refs walks, expand resolution, render-side
worker lookups) bypasses query translation entirely — direct PK
lookup, with a 10k-entry LRU cache in front. Without the cache,
`findById` was the dominant cost during refs replay. With it, hot
lookups are O(1) and stay in JS-already-parsed objects.

### Worker-side sqlite, sync template helpers

The previous `state.layouts.sitemap` mirror is gone. Render workers
open their own read-only sqlite handle on first task
(`ensureWorkerDb(options)` in `src/render.js`) and resolve hrefs via
a prepared statement against `mikser_entities.meta_href`. Templates
keep their sync contract — `{{href "/some/path"}}` returns immediately,
no Promise. Per-worker connection cost is one prepared statement +
sqlite's per-connection page cache; the WAL writer in the main
process and the read-only workers don't block each other.

### Per-phase transactions

Catalog/manifest writes batch into one transaction per `onPersist`
and one per `onFinalize`. The atomic unit is a lifecycle phase, not a
single mutation. Crash mid-build → either the entire phase committed
or none of it did.

## Consequences

### What got easier

- **Memory ceiling shifted from "what fits in heap" to "what fits in
  page cache."** At 14k realistic, peak RSS dropped from 656MB (initial
  catalog-only sqlite swap) to 520MB after Phase 5.5's allLayoutEntities
  fix and Phase 5.6's Piscina lazy init — within 1% of the old
  Map+NDJSON baseline (516MB). At 110k realistic — a workload the
  Map+NDJSON branch couldn't reach — the database branch runs at
  3.2GB RSS warm.
- **Persistent state across restarts.** No NDJSON replay on startup;
  open the file, schema is current, refs and manifest are already
  there.
- **Plugin persistence pattern.** Plugins that need durable state
  call `registerSchema` once and `useDatabase()` to read/write. No
  more per-plugin NDJSON file with bespoke read/write code.
- **Workers stay sync.** Template helpers (`href`, `hrefLang`,
  `lookupHref`) work without Promises because each worker holds a
  read-only sqlite handle. The "async storage breaks sync templates"
  problem that killed earlier postgres consideration doesn't apply
  to in-process sqlite.

### What got harder

- **No more grep-the-NDJSON debugging.** Inspect via `sqlite3
  runtime/mikser.sqlite` or scenario test helpers
  (`readCatalog`/`readManifest` in `test/scenarios/_harness.js`).
- **Schema migrations are now a concern.** Currently mitigated by
  ADR posture #1 ("until v10, no users") — we rewrite in place
  whenever schemas change. Post-v10 this becomes real work.
- **Watch-mode warm cycle +18% slower at 14k** compared to
  Map+NDJSON baseline (2.94s vs 2.5s). The architectural win is at
  scale and at restart; the per-cycle overhead is the cost.

### Followup work that landed alongside

- **Piscina lazy init** (`minThreads: 0` + `idleTimeout: 30_000`).
  Render dispatch is INLINE by default; Piscina was pre-spawning 4
  worker threads at engine.setup() anyway. Setting `minThreads: 0`
  drops that ~130MB at 14k, ~600MB at scales where workers actually
  get used.
- **Postprocess TASKS.WORKER dispatch.** The postprocess switch only
  had INLINE and SERIAL cases; WORKER fell through silently.
  Postprocess now has its own lazy Piscina pool and the dispatcher
  honors `task: worker` end-to-end.
- **`workerSafeOptions`.** Worker payloads previously leaked plugin-
  surface functions (`runtime.options.layouts.inspect`) and the
  per-render `track` closure, causing `DataCloneError`. Both worker
  dispatch paths now strip non-cloneable values before transferring.

## Examples

- `src/database/index.js` — `createSqliteDatabase()`,
  `registerSchema()`, `useDatabase()`, mikser_meta bookkeeping.
- `src/database/sift-to-sql.js` — translator, indexed-column map.
- `src/catalog.js` — `mikser_entities` schema, entityToRow,
  LRU cache for findById, sift-translator integration.
- `src/refs.js` — `mikser_refs` schema, prepared statements for
  inboundFor / outboundFor / inverseClosureOf.
- `src/manifest.js` — `mikser_snapshots` schema, two-query
  recordedHashes via `json_each`.
- `src/render.js` — worker-side `ensureWorkerDb` + `lookupHrefViaDb`
  for sync template helpers.
- `test/scenarios/_harness.js` — `readCatalog` / `readManifest`
  helpers open `mikser.sqlite` read-only for assertions.

## Watch for drift

- **"Let's just keep a Map mirror in memory for hot paths."** That's
  what the LRU cache is. A separate Map will re-create the bounded-
  growth problem the database was specifically chosen to fix.
- **"This subsystem deserves its own database file."** Almost never.
  The single-file design is the synchronization point — separate
  files break transactional guarantees across subsystems and force
  hand-rolled cross-database coordination. The vector plugin has a
  separate file *because it isn't an engine subsystem* and may run
  against pg instead.
- **"We can add a quick `JSON.parse(rows)` materialize-and-walk for
  this one feature."** That's the failure mode the sift→SQL
  translator and `INDEXED_COLUMNS` exist to prevent. If a query is
  hot enough to need materialization, add the index and push it
  down.
- **"Postgres would let us scale further."** It would also re-
  introduce the async-storage / sync-templates impedance mismatch
  the sqlite design specifically avoids. The 110k-entity workload
  runs on sqlite. The "we'll need pg eventually" intuition assumed
  numbers the engine actually surpasses today.

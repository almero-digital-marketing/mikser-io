# Database substrate migration

Engine-level database (sqlite default, postgres opt-in). Catalog, refs,
manifest all move from per-subsystem persistence (Map+NDJSON, in-memory
graphs, NDJSON snapshots) to one backing store with shared transactions.

Living on `engine/database`. Merge to `main` only when the full curve is
in place — half-migrated state isn't shippable.

## Why

- **100MB catalog file is the watch-mode ceiling on Map+NDJSON.** Measured
  at 14k realistic entities. Save crosses the perception threshold.
- **50k realistic = 1.17GB RSS and 9s warm clean.** V8 heap pressure
  and per-cycle load cost both bite at scale.
- **Refs is rebuilt every cycle by walking the catalog.** Persisting it
  alone doesn't help — other walks force the full catalog into memory
  anyway. Need to move catalog and refs together.
- **Database is engine substrate** (ADR-0006). One connection, shared
  transactions, schema namespacing per subsystem. Plugins that need
  persistence layer on top.

The earlier sqlite-as-storage-swap attempt (session log) regressed on
every metric because the engine still iterated `findEntities()` several
times per cycle. Map's already-parsed in-memory walk was ~100× faster
than sqlite's per-row JSON.parse. This time the plan addresses the
access patterns AND the storage — not just the storage.

## Risks (from audit)

### Critical

1. **Test infrastructure reads storage files directly.**
   `test/scenarios/_harness.js` parses `catalog.ndjson` and
   `manifest.ndjson` line-by-line. Scenarios assert on the array shape.
   Mitigation: add `runtime.catalog.export()` debug helper; refactor
   harness readers to call it via IPC.

2. **mikser-io-mcp depends heavily on `runtime.refs.*`.** 5 distinct
   call sites: `inboundFor`, `outboundFor`, `allRefs`, `rename`, `size`.
   Every `mikser_refs_*` MCP tool routes through these.
   Mitigation: the `runtime.refs` surface is the contract. Driver swap
   stays invisible to mikser-io-mcp.

### High

3. **`runtime.state.{layouts, assets, resources}` is rebuilt every cycle
   by walking the catalog.** These walks are what killed the earlier
   sqlite attempt. Three full `findEntities()` scans per cold cycle.
   Mitigation: drop the derived state caches entirely (Phase 3). Query
   the DB instead, backed by indexed columns. `state.assets.presets`
   stays in memory (JS modules, not entities).

4. **Hot-path `findById` latency regression.** 5 hot callers:
   `refs.js:425, 493`, `manifest.js:180, 367`, `source.js:64`. Map: ~30ns.
   Sqlite indexed SELECT: ~30μs. At 10k entities × 5 BFS hops × 5 refs avg
   = 250k calls/cycle = 7.5s of pure DB latency.
   Mitigation: LRU cache (~1000 entries) wrapping `findById`. Per-cycle,
   invalidates on entity mutation in the same cycle.

5. **Lifecycle ordering — `catalog.onPersist` must run before
   `refs.onPersist`.** Hook order is import order in `index.js` — fragile.
   Mitigation: wrap catalog mutations + refs index updates in one
   `db.transaction(...)` call. Refs.onPersist no longer rebuilds; it
   just dispatches.

### Medium

6. **`runtime.catalog.cacheInvalidated` direct read** (`source.js:62, 101`).
   Driver must expose this at the same path with the same semantics.

7. **`manifest.collectEdges` hot-path findById.** Per render. LRU cache
   handles this since partials are a small reused set.

8. **`--verify` mode reads manifest + checks output files.** Schema needs
   an indexed way to iterate snapshots for verification — streaming
   SELECT, not materialize-all.

### Low

9. **Sibling plugins (eta, liquid, markdown, decap, schemas, post-pdf).**
   Clean. No direct catalog/refs/manifest dependencies.
10. **mikser-io-vector.** Independent storage. No interaction. Reference
    architecture for the driver pattern itself.

### Operational

11. **Recovery blast radius.** One sqlite file instead of three NDJSON
    files. Same recovery shape, slightly bigger blast radius. Good error
    reporting on corrupt DB is essential.
12. **Watch-mode + `--verify` concurrency.** WAL mode allows concurrent
    reads. Test that --verify works while a long-running watch process
    is open.
13. **Schema migrations.** Until v10: drop `runtime/`, rebuild. After v10:
    revisit if a real scenario forces it (production postgres with
    editorial content, multi-instance coordinated upgrade, schema change
    that needs to preserve data). Initial design uses inline
    `CREATE IF NOT EXISTS` + a `meta.schema_version` stamp; mismatched
    version fails loud with "run mikser --clear". No migration framework
    until we have evidence we need one.
14. **Native sqlite dep install story.** `better-sqlite3` ships prebuilt
    binaries for common Node + platform combos; exotic environments
    (musl libc, very new Node releases without prebuilts yet) may need
    `npm rebuild` from source. Same library mikser-io-vector already
    uses, so this risk is already in the codebase — no new surface.

## Phases

Each phase is independently shippable + measurable. Tests + perf
measurement after each. Phase commits land on this branch only; merge
to main happens after Phase 6.

### Phase 1 — Database substrate
**Duration: 3-4 days**

Engine-level `database` config, driver dispatcher, sqlite driver. No
subsystem migrations yet.

Library choices locked in:

- **sqlite:** `better-sqlite3` (matches mikser-io-vector's choice;
  consistent install story across the codebase). Gives us `.iterate()`
  for lazy result streaming, `db.function()` for sift→SQL escape hatches
  (`$regex` etc.), prepared statements, sync API for hot paths.
- **postgres:** `pg` (also matches vector). Connection pool via `pg.Pool`.

Tasks:

- `mikser.config.js` reads `database: { driver, sqlite: {...}, postgres: {...} }`
- Connection config mirrors vector's shape: `sqlite: { filename }`,
  fallback to `runtime/mikser.sqlite`
- `src/database.js`: dispatcher + driver registration + `useDatabase()` API
- `src/database-driver-sqlite.js`: better-sqlite3 wrapper, connection
  lifecycle, PRAGMAs (WAL, synchronous=NORMAL), schema migration runner
- Schema registration API: subsystems call `registerSchema('catalog',
  sqlScript)` during `onInitialize`; engine runs migrations at
  `onInitialized`
- Transaction primitive: `db.transaction(fn)` — better-sqlite3's
  built-in `db.transaction()` wrapper, which handles BEGIN / COMMIT /
  ROLLBACK on throw automatically

**Validation:** existing tests still pass; `runtime.database` available
at onLoaded; empty schema initializes cleanly; subsequent runs skip
migration.

### Phase 2 — Migrate catalog
**Duration: 4-5 days**

Catalog moves to sqlite. Map driver retires (or becomes `:memory:` shim).

- Schema: `catalog_entities (id, collection, type, format, meta_href,
  meta_layout, time, checksum, data TEXT NOT NULL)` with indexes on the
  denormalized columns
- Configurable extra indexes via `catalog: { indexed: [...] }`
- Sift→SQL translator (`src/catalog-sift-to-sql.js`): handles `$eq`, `$ne`,
  `$in`, `$nin`, `$lt`, `$gt`, `$or`, `$and`, `$exists`, `$regex` +
  dotted-path keys. Falls back to materialize+sift-in-JS for translator
  misses (with log warning).
- LRU cache (~1000 entries) wrapping `findById` on the hot path
- Module-level functions (`findById`, `findEntity`, `findEntities`,
  `queryEntities`, `readEntity`) reroute through the database
- `runtime.catalog.export()` debug helper for tests
- Update `test/unit/plugin-harness.js` and
  `test/scenarios/_harness.js` accordingly

**Validation:**
- All tests pass
- Cold at 10k light: target within 20% of pre-migration (~10.8s baseline)
- Warm clean at 14k realistic: target ≤ pre-migration (~2.5s baseline)
- Peak RSS at 14k realistic: target ≤ 200MB (516MB baseline)
- mikser-io-mcp tools work end-to-end

### Phase 3 — Drop derived state, query the DB
**Duration: 2-3 days**

The state.layouts.layouts / state.layouts.sitemap / state.assets.assetsMap
/ state.resources.resourceLib caches were workarounds for not having
indexed storage. With Phase 2 in place, drop them and query the DB.

- `state.layouts.layouts[name]` → `findEntity({collection:'layouts', name})`
- `state.layouts.sitemap[href]` → `findEntity({'meta.href': href})`
- `state.layouts.uriIndex[uri]` → `findEntities({uri})`
- `state.assets.assetsMap[id]` → either denormalize `assets` as a column
  on entities table, or query meta at lookup time
- `state.resources.resourceLib[name]` → `findEntity({type:'resource', name})`
- `state.assets.presets` stays in memory (JS modules)
- Delete the rebuild walks in `layouts.onLoaded`, `assets.onLoaded`,
  `resources.onLoaded`

**Validation:** warm clean drops further (no rebuild walks); functional
parity (smoke + scenarios pass); per-render latency tracked.

### Phase 4 — Migrate refs
**Duration: 2-3 days**

- Schema: `catalog_refs (source_id, target_ref, kind, field)` with indexes
  on both source and target; FK + ON DELETE CASCADE to entities
- `inboundFor`, `outboundFor`, `inverseClosureOf` become indexed SQL queries
- `refs.onPersist` removed; refs maintenance happens inside the
  `catalog.onPersist` transaction
- `manifest.replaceDynamic` writes to `catalog_refs` directly (replacing
  in-memory `dynamicOutbound`)

**Validation:** mikser-io-mcp's `mikser_refs_*` tools return correct
results; refs BFS performance OK at 14k; persisted across restart (no
rebuild on cold start).

### Phase 5 — Migrate manifest
**Duration: 2 days**

- Schema: `manifest_snapshots (id, destination, inputHash, refClosure JSON,
  renderedAt, parent, outputHash)`
- `shouldSkip`, `lookup` become indexed SELECTs
- `collectEdges` reads via SQL
- `--verify` mode iterates via streaming SELECT

**Validation:** all scenarios pass (incl. cache-invalidation, --verify);
warm clean stable.

### Phase 6 — Postgres driver
**Duration: 3-4 days**

- `src/database-driver-postgres.js`: `pg` connection pool, schema
  namespacing, `jsonb` columns instead of `TEXT`
- Sift→SQL translator's postgres dialect: `data->'meta'->>'status'` instead
  of `json_extract(data, '$.meta.status')`, etc.
- `ON CONFLICT` vs `INSERT OR REPLACE`
- Migration scripts adapted to postgres syntax
- Document when to use sqlite (CLI/local/library) vs postgres
  (server/multi-tenant/CMS backend)

**Validation:** same test suite passes against postgres; performance
characteristics documented.

### Phase 7 — Documentation + ADR
**Duration: 1 day**

- New ADR: "Database is engine substrate" — five-test framework
  justification
- Update README + CLAUDE.md
- Migration notes for plugin authors (sift filter rules, useDatabase
  access)
- Performance numbers across drivers + entity weights

## Side-by-side perf comparison

After each phase, run the comparison both ways:

```bash
# Compare current branch to main
git stash
git checkout main
SIZE=realistic node test/perf/generate.js 14000
rm -rf test/perf/runtime test/perf/out
/usr/bin/time -p node app.js --working-folder test/perf > /tmp/main-cold.log 2>&1
# ...warm runs...
git checkout engine/database
rm -rf test/perf/runtime test/perf/out
/usr/bin/time -p node --experimental-sqlite app.js --working-folder test/perf > /tmp/branch-cold.log 2>&1
# ...warm runs...
git stash pop
```

Numbers go in the commit message for each phase. Baseline table to
populate at each phase boundary:

| metric | main (Map+NDJSON) | branch (database) |
|---|---|---|
| 10k light cold | 10.8s | TBD |
| 14k realistic cold | 18.6s | TBD |
| 14k realistic warm | 2.5s | TBD |
| 14k realistic RSS | 516MB | TBD |
| 50k realistic warm | 9.1s | TBD |
| 50k realistic RSS | 1.17GB | TBD |

## Decisions made

- **better-sqlite3 for sqlite, `pg` for postgres.** Matches
  mikser-io-vector. Consistent install story, one native dep across
  the codebase, `.iterate()` available for lazy result streaming,
  `db.function()` available for sift→SQL escape hatches.

- **No migration framework. Inline `CREATE IF NOT EXISTS` + schema
  version stamp.** Mikser's catalog is a derived cache rebuildable
  from source files; each project has its own self-contained
  `runtime/mikser.sqlite`. Versioned migrations earn their keep in
  multi-tenant production where data can't be regenerated — not here.
  The driver's `open()` hook:
  - Runs idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
    EXISTS` statements (the schema lives in the driver source, reviewed
    in PRs like any other code).
  - Reads `meta.schema_version`. On mismatch with the current engine
    constant, throws with a clear message: "Database schema is X; this
    mikser-io expects Y. Run `mikser --clear` to rebuild from sources."
  - Writes its own version stamp on first open.
  Same shape as today's catalog version stamp (`cacheInvalidated` flips
  on mismatch). Revisit only when a post-v10 scenario forces it.

- **Two transactions per cycle, one per lifecycle phase.** Render is
  transaction-free.
  - **`onPersist` transaction.** Applies journal CREATE/UPDATE/DELETE
    mutations to `catalog_entities` + `catalog_refs` atomically. Closes
    before render dispatch. Size scales with mutation count — typically
    <10s, up to ~60s on cold 100k.
  - **Render phase.** No transaction. Piscina workers read entities
    (via the dispatcher's hydrated snapshots) and produce output files.
    The DB sits at the post-onPersist committed state. Concurrent
    readers (api plugin, MCP tools) see consistent state throughout.
  - **`onFinalize` transaction.** Applies journal RENDER entries to
    `manifest_snapshots`. Short — usually <10s.

  This avoids the "one giant 30-minute transaction per cycle" failure
  mode: in sqlite that grows the WAL unboundedly, blocks other writers,
  and slows crash recovery; in postgres it blocks VACUUM, holds row
  locks indefinitely, and breaks pgbouncer transaction pooling. With
  per-phase transactions, the longest transaction scales with entity
  count, not build wall-time.

## Open questions

- **Index discovery.** Do we auto-add indexes based on observed query
  patterns, or stay strictly config-driven? Lean: config-driven for
  v1; observability via debug logs.
- **mikser-io-vector eventually folds into the engine database?** Phase
  4+ candidate. Out of scope for this branch. Note: vector currently
  writes to `runtime/vectors.db`; if it ever shares the engine's
  `runtime/mikser.sqlite`, transactions could span vector + catalog
  writes. Powerful but adds coupling — defer.

## Stop rules

If at any phase boundary the perf numbers are worse than baseline AND
we don't have a clear path to recovery, stop and re-evaluate. Don't
push through hoping later phases fix it. The earlier sqlite attempt
session showed this pattern — implementation finished, every metric
worse, had to revert. Profile first, ship only when measured.

The "till v10, no users" posture means we can ALSO stop and revert the
whole branch without anyone's workflow breaking. That's the safety net.

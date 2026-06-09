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
    real migration scripts. Design the initial schema with future change
    in mind — numbered version, additive-only discipline.
14. **Node version requirement.** `node:sqlite` needs `--experimental-sqlite`
    on Node 22.x, stable on 24+. Decide: bump engines.node, or use
    better-sqlite3 (native dep, proven).

## Phases

Each phase is independently shippable + measurable. Tests + perf
measurement after each. Phase commits land on this branch only; merge
to main happens after Phase 6.

### Phase 1 — Database substrate
**Duration: 3-4 days**

Engine-level `database` config, driver dispatcher, sqlite driver. No
subsystem migrations yet.

- `mikser.config.js` reads `database: { driver, sqlite: {...}, postgres: {...} }`
- `src/database.js`: dispatcher + driver registration + `useDatabase()` API
- `src/database-driver-sqlite.js`: native driver, connection lifecycle,
  PRAGMAs (WAL, synchronous=NORMAL), schema migration runner
- Schema registration API: subsystems call `registerSchema('catalog',
  sqlScript)` during `onInitialize`; engine runs migrations at
  `onInitialized`
- Transaction primitive: `db.transaction(fn)` — runs fn inside
  `BEGIN; ...; COMMIT` with abort on throw
- Decide: `node:sqlite` vs `better-sqlite3`

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

## Open questions

- **node:sqlite vs better-sqlite3.** Decision needed before Phase 1.
  Pro node:sqlite: built-in, no native compilation, future-proof for
  Node 24+. Con: experimental on 22.x, lacks `.iterate()`. Pro
  better-sqlite3: proven, full API, `.iterate()`. Con: native dep,
  compilation issues possible.
- **Schema migration discipline.** Versioned `migrations/NNNN-*.sql`
  files? Inline `CREATE IF NOT EXISTS` only? Decide before Phase 1
  schema setup.
- **Per-cycle transaction granularity.** One transaction per cycle, or
  one transaction per onPersist? Tradeoffs: longer transaction =
  better atomicity but holds locks longer in watch-mode.
- **Index discovery.** Do we auto-add indexes based on observed query
  patterns, or stay strictly config-driven? Lean: config-driven for
  v1; observability via debug logs.
- **mikser-io-vector eventually folds into the engine database?** Phase
  4+ candidate. Out of scope for this branch.

## Stop rules

If at any phase boundary the perf numbers are worse than baseline AND
we don't have a clear path to recovery, stop and re-evaluate. Don't
push through hoping later phases fix it. The earlier sqlite attempt
session showed this pattern — implementation finished, every metric
worse, had to revert. Profile first, ship only when measured.

The "till v10, no users" posture means we can ALSO stop and revert the
whole branch without anyone's workflow breaking. That's the safety net.

// Engine-level entity store. Sqlite-backed via the engine's shared
// database substrate (see src/database/) — ADR-0009.
//
// Schema (registered with the substrate at module load time):
//   mikser_entities (id, collection, type, format, name, meta_href,
//                     meta_url, meta_layout, meta_lang, meta_cache, time,
//                     uri, data)
// Indexed columns are the fields engine code routinely filters on;
// the JSON body sits in `data` for everything else. The sift→SQL
// translator pushes predicates on indexed columns down to SQL.
//
// Hot-path `findById` goes through a small LRU cache wrapping the
// prepared SELECT. Refs BFS, manifest collectEdges, and source's
// gate all hit findById in tight loops; without caching, the
// per-call cost (~10-30μs) would compound badly.
//
// Identity semantics: each `findEntity({id})` call returns a freshly
// JSON.parsed entity, NOT the same instance as the previous call
// (unlike the prior in-memory Map). The codebase already mutates only
// through `_.cloneDeep` or locally-constructed entities, so this
// works in practice. New plugin code should not assume identity
// across calls.

import runtime from './runtime.js'
import { useLogger } from './engine/index.js'
import { onLoaded, onPersist, onFinalize } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import _ from 'lodash'
import sift from 'sift'
import { expandEntity, projectMeta, refFilter } from './utils.js'
import { normalizeFilter } from './track.js'
import { useDatabase, registerSchema } from './database/index.js'
import { translate as siftToSql, INDEXED_COLUMNS } from './database/sift-to-sql.js'
import { queryContext } from './database/query-context.js'
import { useRefsIndex } from './refs.js'

export { queryContext }

// Register the catalog schema with the database. Applied idempotently
// at db.open() via CREATE IF NOT EXISTS.
// `WITHOUT ROWID` makes the primary key clustered — smaller file,
// faster id lookups.
registerSchema('mikser_entities', `
    CREATE TABLE IF NOT EXISTS mikser_entities (
        id           TEXT PRIMARY KEY,
        collection   TEXT,
        type         TEXT,
        format       TEXT,
        name         TEXT,
        meta_href    TEXT,
        meta_url     TEXT,
        meta_layout  TEXT,
        meta_lang    TEXT,
        meta_cache   INTEGER,
        time         INTEGER,
        uri          TEXT,
        data         TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_collection  ON mikser_entities(collection);
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_type        ON mikser_entities(type);
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_format      ON mikser_entities(format);
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_name        ON mikser_entities(name);
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_meta_href   ON mikser_entities(meta_href)   WHERE meta_href   IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_meta_url    ON mikser_entities(meta_url)    WHERE meta_url    IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_meta_layout ON mikser_entities(meta_layout) WHERE meta_layout IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_meta_lang   ON mikser_entities(meta_lang)   WHERE meta_lang   IS NOT NULL;
    -- Partial index over meta.cache: false (rare opt-out for renders
    -- mikser can't track precisely). Typical site has 0-10; WHERE
    -- clause keeps the index tiny.
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_meta_cache  ON mikser_entities(meta_cache)  WHERE meta_cache  IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_time        ON mikser_entities(time);
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_uri         ON mikser_entities(uri);
`)

// Per-process dedupe of the no-filter findEntities/iterateEntities
// warning. Keyed by the rendering entity id (which is what gets
// blamed in the recorded refClosure). Once per offending site is
// enough — the warning is educational, not load-bearing.
const _warnedNullFilter = new Set()

function recordQuery(filter) {
    const ctx = queryContext.getStore()
    if (!ctx?.track) return
    // Null/undefined filter records as `null` in the snapshot's
    // refClosure, which manifest.shouldSkip and manifest.queryAffected
    // treat as "any mutation could have affected this render."
    // Architecturally correct, but it means an aggregate layout whose
    // sidecar calls findEntities() with no args invalidates on every
    // single CREATE/UPDATE/DELETE — including spurious ones (plugins
    // re-emitting unchanged entities, etc.).
    //
    // Warn once per rendering entity so authors can narrow the filter.
    // The fix is almost always to add the collection / type / format
    // dimension the sidecar actually cares about; the JS-side .filter()
    // chain that usually follows findEntities() is the signal that the
    // filter belongs in the SQL.
    if ((filter === undefined || filter === null) && ctx.entityId) {
        if (!_warnedNullFilter.has(ctx.entityId)) {
            _warnedNullFilter.add(ctx.entityId)
            const logger = useLogger()
            logger?.warn(
                'findEntities()/iterateEntities() called with no filter from %s — recorded query dep invalidates on every mutation. For "all renderable entities" use findEntities({"meta.href": {$exists: true}}). For narrower scopes use any indexed column ({collection, type, format, "meta.layout", "meta.lang"}); pushing the filter into SQL keeps invalidation precise.',
                ctx.entityId,
            )
        }
    }
    ctx.track.query(normalizeFilter(filter))
}

// LRU cache for findById hot path. Bounded; evicts oldest on overflow.
// Invalidates per-id on entity mutation.
//
// Sized to comfortably cover small-to-mid corpora and the hot working
// set of larger ones. At 10k corpus: full cache, 100% hit rate. At
// 100k corpus: ~10% holds the hot working set (refs BFS revisits,
// manifest collectEdges hashing). Memory cost is bounded — 10k
// entries × ~7KB average = ~70MB cache footprint, still much less
// than the prior in-memory Map that held the entire catalog in heap.
//
// Bigger workloads can tune via `runtime.config.catalog.cache.size`
// (handled at onLoaded).
const DEFAULT_LRU_SIZE = 10000
let lruSize = DEFAULT_LRU_SIZE
const findByIdCache = new Map()

function cacheGet(id) {
    if (!findByIdCache.has(id)) return undefined
    // Touch — move to end so LRU eviction picks the oldest.
    const v = findByIdCache.get(id)
    findByIdCache.delete(id)
    findByIdCache.set(id, v)
    return v
}

function cacheSet(id, entity) {
    if (findByIdCache.size >= lruSize && !findByIdCache.has(id)) {
        const oldest = findByIdCache.keys().next().value
        findByIdCache.delete(oldest)
    }
    findByIdCache.set(id, entity)
}

function cacheEvict(id) {
    findByIdCache.delete(id)
}

function cacheClear() {
    findByIdCache.clear()
}

// Prepared statements + lifecycle handle. Set at onLoaded; persists
// across cycles (sqlite stays open).
let db = null
// Chunk size for paged iterateEntities walks. Bounds peak entity
// memory at chunk × row regardless of corpus. 500 × ~7KB ≈ 3.5MB —
// small enough that even 1M corpora stay flat on RSS, large enough
// that the per-chunk SELECT overhead is negligible.
const CHUNK_SIZE = 500

let stmtGet = null
let stmtUpsert = null
let stmtDelete = null
let stmtAllData = null
let stmtCount = null
let stmtChecksumsForCollection = null

// Extract denormalized index columns from an entity body. Null for
// missing fields — sqlite IS NULL handling treats those correctly.
function entityToRow(entity) {
    return {
        id:           entity.id,
        collection:   entity.collection   ?? null,
        type:         entity.type         ?? null,
        format:       entity.format       ?? null,
        name:         entity.name         ?? null,
        meta_href:    entity.meta?.href   ?? null,
        // Deployed served path (ADR-0011). Indexed so a $-ref to a file/
        // resource resolves by the path content actually authors (its
        // served URL), not the collection-prefixed id.
        meta_url:     entity.meta?.url    ?? null,
        meta_layout:  entity.meta?.layout ?? null,
        meta_lang:    entity.meta?.lang   ?? null,
        // meta.cache: false is the opt-out — entities that should
        // render every cycle. Stored as 0 (the only meaningful value;
        // NULL means "not set" so the partial index skips it).
        meta_cache:   entity.meta?.cache === false ? 0 : null,
        time:         entity.time         ?? null,
        uri:          entity.uri          ?? null,
        data:         JSON.stringify(entity),
    }
}

// Apply per-cycle journal mutations inside one transaction (per the
// migration plan's per-phase transaction granularity). Maintains
// `mikser_refs` alongside `mikser_entities` so refs and entities
// commit atomically — neither view ever shows a partial mutation.
//
// better-sqlite3's transaction wrapper is sync-only, so we drain the
// journal first and then sync-apply in one call.
async function applyJournalMutations() {
    const logger = useLogger()
    const refsIndex = useRefsIndex()
    const mutations = []
    for await (const { operation, entity } of useJournal('Catalog')) {
        mutations.push({ operation, entity })
    }
    if (!mutations.length) return
    db.transaction(() => {
        // Two passes, deliberately. indexEntity resolves each $-ref
        // against mikser_entities to record what it bound to, so it has
        // to run after every row this cycle is in place — otherwise a
        // ref to an entity that happens to be upserted later in the same
        // batch binds to nothing, purely because of journal order.
        const toIndex = []
        for (const { operation, entity } of mutations) {
            switch (operation) {
                case OPERATION.CREATE:
                case OPERATION.UPDATE:
                    logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
                    stmtUpsert.run(entityToRow(entity))
                    toIndex.push(entity)
                    cacheEvict(entity.id)   // next read returns fresh data
                    break
                case OPERATION.DELETE:
                    logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
                    stmtDelete.run(entity.id)
                    // FK ON DELETE CASCADE handles mikser_refs cleanup.
                    // mikser_failures is cleared explicitly rather than by
                    // cascade — see manifest.clearFailures for why it cannot
                    // be a foreign key. Left behind, one row for a deleted
                    // entity keeps the dispatch set non-empty for the life of
                    // the database, so layouts' idle-cycle early-out never
                    // fires again.
                    runtime.manifest?.clearFailures(entity.id)
                    cacheEvict(entity.id)
                    break
            }
        }
        // Static $-ref edges from entity.meta. Refs index does
        // delete-then-insert per source internally, so this stays
        // idempotent across UPDATE.
        for (const entity of toIndex) refsIndex?.indexEntity(entity)
    })
}

onLoaded(async () => {
    db = useDatabase()
    if (!db) {
        // Shouldn't happen — src/database/index.js's onLoaded runs
        // first (it's imported earlier in index.js). Treat as a
        // misconfiguration.
        throw new Error('Catalog requires the database; none was opened.')
    }

    // Register a REGEXP user function so the sift→SQL translator can
    // push $regex predicates down. Null-safe: null column never
    // matches. Matches sift semantics.
    db.handle.function('REGEXP', { deterministic: true }, (pattern, value) => {
        if (value == null) return 0
        try {
            return new RegExp(pattern).test(String(value)) ? 1 : 0
        } catch {
            return 0
        }
    })

    stmtGet = db.prepare('SELECT data FROM mikser_entities WHERE id = ?')
    stmtUpsert = db.prepare(`
        INSERT INTO mikser_entities
            (id, collection, type, format, name, meta_href, meta_url, meta_layout, meta_lang, meta_cache, time, uri, data)
        VALUES
            (@id, @collection, @type, @format, @name, @meta_href, @meta_url, @meta_layout, @meta_lang, @meta_cache, @time, @uri, @data)
        ON CONFLICT(id) DO UPDATE SET
            collection  = @collection,
            type        = @type,
            format      = @format,
            name        = @name,
            meta_href   = @meta_href,
            meta_url    = @meta_url,
            meta_layout = @meta_layout,
            meta_lang   = @meta_lang,
            meta_cache  = @meta_cache,
            time        = @time,
            uri         = @uri,
            data        = @data
    `)
    stmtDelete = db.prepare('DELETE FROM mikser_entities WHERE id = ?')
    stmtAllData = db.prepare('SELECT data FROM mikser_entities')
    stmtCount = db.prepare('SELECT COUNT(*) AS c FROM mikser_entities')
    // Bulk-prefetch primitive used by source.js's gate. Pulls the
    // checksum field for every entity in a collection without parsing
    // the full JSON body — `json_extract` evaluates inside sqlite,
    // returning just the column we asked for. At 14k entities,
    // ~14× faster than per-file findById (no per-row JSON.parse).
    stmtChecksumsForCollection = db.prepare(`
        SELECT id, json_extract(data, '$.checksum') AS checksum
        FROM mikser_entities
        WHERE collection = ?
    `)

    const configured = runtime.config?.catalog?.cache?.size
    lruSize = Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_LRU_SIZE
    cacheClear()

    // Expose the engine-side handle plugins might want. Matches the
    // runtime.refs / runtime.catalog shape: a small surface for
    // diagnostic / debug / test inspection. Plugin code should still
    // call findEntity / findEntities / queryEntities for queries —
    // those go through the sift→SQL translator and the LRU cache.
    runtime.catalog = {
        // No persistent state version mismatch handling here — the
        // database's schema_version stamp catches that at db.open()
        // and throws with "run mikser --clear". For source.js's gate
        // we keep cacheInvalidated as a stable false
        // (the source-side semantics now follow from journal + db
        // state, not from a separate flag).
        cacheInvalidated: false,
        // Snapshot the catalog for tests / debug. Iterates every row;
        // O(N) — not for hot paths. Returns the legacy shape so
        // existing test/scenarios harnesses can assert on it.
        export: exportCatalog,
        // Compatibility — some legacy callers expected this. Now a
        // no-op (writes happen per-cycle via onPersist transactions).
        save: async () => {},
    }
})

onPersist(async () => {
    await applyJournalMutations()
})

onFinalize(async () => {
    // Second drain, and the one that closes the cycle.
    //
    // onPersist runs BEFORE render, so the drain above only ever sees what
    // the load and process phases journalled. Everything a render or a
    // postprocess journals lands after it — and onFinalized's clearJournal()
    // then throws those entries away unread. The manifest never had this
    // problem because it drains at onFinalize; the catalog simply had a
    // shorter view of the same journal.
    //
    // The visible symptom was pruning that silently did nothing: a render
    // asking for `catalog: false` journals its DELETE once the render
    // resolves, which is past persist, so the row stayed. gpoint's cms
    // accumulated 1,134 scratch entities carrying 86 MB of render payload,
    // took its public endpoint from 70ms to 8-15s, and blanked the site.
    //
    // Draining again here rather than moving the persist drain: the phases
    // before render still need their mutations committed at persist (the
    // render reads the catalog), and journal consumers are named and
    // independent, so a second pass only ever picks up what the first could
    // not have seen.
    await applyJournalMutations()

    // Checkpoint the WAL so the main file size stays representative
    // and external tools (mikser --audit-output on a separate run, debug
    // scripts) see committed state. PASSIVE never blocks readers or
    // writers; it only catches up what it can.
    if (!db?.isOpen) return
    try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    } catch (err) {
        useLogger().warn('Catalog WAL checkpoint failed (%s) — data is durable, file size may lag', err.message)
    }
})

// Snapshot the catalog as `{ version, entities: [...] }` — the schema
// version plus every entity body. O(N) in both time and memory, so it is
// for debugging and inspection, never a hot path; `iterateEntities`
// streams when the result set might be corpus-scale.
function exportCatalog() {
    if (!db?.isOpen) return { version: null, entities: [] }
    const rows = stmtAllData.all()
    const meta = db.prepare('SELECT value FROM mikser_meta WHERE key = ?').get('schema_version')
    return {
        version: meta?.value ?? null,
        entities: rows.map(r => JSON.parse(r.data)),
    }
}

// In-memory fallback for unit tests that stub
// `runtime.catalog = { byId: new Map() }` without bringing up the
// sqlite database. The public catalog functions check for this stub
// when `db` isn't open and operate against the Map directly. Lets
// plugin-harness.js and a handful of unit tests run without a DB
// connection.
function mapStub() {
    const byId = runtime.catalog?.byId
    if (!(byId instanceof Map)) return null
    return {
        kind: 'stub',
        get(id) { return byId.get(id) ?? null },
        all() { return Array.from(byId.values()) },
    }
}

// Synchronous by-id lookup. Hot path: refs BFS, manifest collectEdges,
// source.js gate. Backed by an LRU cache; first miss goes to sqlite,
// subsequent hits return from memory.
//
// Untracked — doesn't record a query dependency, because the consumers
// are engine bookkeeping not render-time deps.
export function findById(id) {
    if (!id) return null

    if (db?.isOpen) {
        const cached = cacheGet(id)
        if (cached !== undefined) return cached
        const row = stmtGet.get(id)
        const entity = row ? JSON.parse(row.data) : null
        cacheSet(id, entity)
        return entity
    }

    const shim = mapStub()
    return shim ? shim.get(id) : null
}

// Find one entity by sift filter. Fast path for `{id, ...}` queries
// (hit the LRU and validate remaining clauses inline). For other
// filters, translate to SQL + JS fallback.
export async function findEntity(query) {
    // A function is a valid filter, so the guard has to admit one:
    // `typeof fn !== 'object'`, and rejecting it here returns undefined
    // for every function filter without a word.
    if (!query || (typeof query !== 'object' && typeof query !== 'function')) return
    recordQuery(query)

    if (db?.isOpen) {
        if (typeof query.id === 'string') {
            const entity = findById(query.id)
            if (!entity) return
            const rest = Object.fromEntries(
                Object.entries(query).filter(([k]) => k !== 'id'),
            )
            if (Object.keys(rest).length === 0) return entity
            return sift(rest)(entity) ? entity : undefined
        }

        const t = siftToSql(query)
        // With a residual predicate we may need to scan multiple rows
        // before finding a match; without one, LIMIT 1 short-circuits.
        const matcher = residualMatcher(query, t.jsFilter)
        const stmt = db.prepare(matcher
            ? `SELECT data FROM mikser_entities ${t.sql}`
            : `SELECT data FROM mikser_entities ${t.sql} LIMIT 1`)
        for (const row of stmt.iterate(...t.params)) {
            const entity = JSON.parse(row.data)
            if (!matcher || matcher(entity)) return entity
        }
        return
    }

    const shim = mapStub()
    if (!shim) return
    if (typeof query.id === 'string') {
        const entity = shim.get(query.id)
        if (!entity) return
        const rest = Object.fromEntries(
            Object.entries(query).filter(([k]) => k !== 'id'),
        )
        if (Object.keys(rest).length === 0) return entity
        return sift(rest)(entity) ? entity : undefined
    }
    const m = typeof query === 'function' ? query : sift(query)
    for (const entity of shim.all()) {
        if (m(entity)) return entity
    }
}

// All entities (no arg) or those matching `query`. Indexed clauses
// push down to SQL; un-indexed clauses run as a sift filter over the
// pushdown result set.
// The residual predicate a SQL translation could not absorb.
//
// `translate()` reports `jsFilter: null` for two different situations:
// nothing is left to check in JS, and the filter could not be read at
// all. A function filter is the second. Reading that null as the first
// discards the predicate — `findEntities(fn)` then answers with the
// entire catalog and `findEntity(fn)` with whichever row LIMIT 1
// returns, both silently. So the function case is decided HERE, from
// `query` itself, rather than inferred from what translate returned.
//
// The plugin harness applies function filters, so a plugin that relies
// on this passes its own tests either way; only production diverges.
//
// A function cannot be indexed — it forces a full scan and a JSON.parse
// per row — so prefer an object filter, and `refFilter()` for the common
// "resolve a ref string" case.
function residualMatcher(query, jsFilter) {
    if (jsFilter) return sift(jsFilter)
    if (typeof query === 'function') {
        warnFullScan()
        return query
    }
    return null
}

// Once per process: a function filter is a performance cliff, not an
// error, and a message per call on a hot path costs more than the cliff.
let warnedFullScan = false
function warnFullScan() {
    if (warnedFullScan) return
    warnedFullScan = true
    try {
        useLogger().debug(
            'Catalog query used a function filter: this cannot be indexed and '
            + 'scans the whole catalog. Prefer an object filter, or refFilter(ref) '
            + 'to resolve a ref string.',
        )
    } catch { /* logger may not exist yet */ }
}

export async function findEntities(query) {
    recordQuery(query)

    if (db?.isOpen) {
        if (!query) {
            return stmtAllData.all().map(r => JSON.parse(r.data))
        }
        const t = siftToSql(query)
        const stmt = db.prepare(`SELECT data FROM mikser_entities ${t.sql}`)
        const rows = stmt.all(...t.params)
        const entities = rows.map(r => JSON.parse(r.data))
        const matcher = residualMatcher(query, t.jsFilter)
        return matcher ? entities.filter(matcher) : entities
    }

    const shim = mapStub()
    if (!shim) return []
    if (!query) return shim.all()
    const m = typeof query === 'function' ? query : sift(query)
    return shim.all().filter(m)
}

// How many entities match, without materializing any of them.
//
// findEntities parses the JSON body of every row it returns, which is the
// wrong price for a number. A COUNT(*) with the same pushed-down WHERE is one
// query and no parsing — the difference between asking "how big is the
// catalog" costing nothing and costing a full scan.
//
// Returns null when the query cannot be answered in SQL alone. A residual
// JS-side clause would require fetching the rows to test them, which is
// exactly what this exists to avoid, and guessing a number would be worse than
// admitting there isn't one.
export function countEntities(query) {
    if (!db?.isOpen) {
        const shim = mapStub()
        if (!shim) return 0
        if (!query) return shim.all().length
        const m = typeof query === 'function' ? query : sift(query)
        return shim.all().filter(m).length
    }
    if (!query) return stmtCount.get().c

    const t = siftToSql(query)
    // A residual matcher means part of the filter never reached SQL.
    if (residualMatcher(query, t.jsFilter)) return null
    return db.prepare(`SELECT COUNT(*) AS c FROM mikser_entities ${t.sql}`).get(...t.params).c
}

// Streaming variant of findEntities. Same query shape, same sift→SQL
// translation, but yields entities chunk-by-chunk so peak memory is
// O(chunk × entity) instead of O(corpus × entity).
//
// Use when the caller can process entities one-at-a-time AND the result
// set might be corpus-scale — big data plugin exports, force-rebuild
// dispatch, anything that walks "everything matching this filter."
//
// Don't use when the caller needs the array shape (.length / .sort /
// .filter chains, JSON.stringify of the whole set, etc.) — findEntities
// stays faster and clearer for bounded result sets.
//
// Chunking strategy: pages CHUNK_SIZE rows ordered by id (PK, indexed),
// each chunk seek-paginated by "id > lastId" so we don't pay OFFSET's
// O(N) skip cost. Closing the SELECT between chunks lets `updateEntry`
// / `runtime.update` and other writes run freely in the gap (same
// pattern useJournal uses).
//
// Snapshot semantics: no explicit upper bound. Entities created
// mid-walk with an id greater than the cursor land in a later chunk.
// Practical impact is small — most catalog walks happen in onLoaded
// (before mutations) or onRender (where mutations are journal-bound
// and don't hit mikser_entities until onPersist).
export async function* iterateEntities(query) {
    recordQuery(query)

    if (db?.isOpen) {
        const t = query ? siftToSql(query) : { sql: '', params: [], jsFilter: null }
        const where = t.sql
            ? `${t.sql} AND id > ?`
            : `WHERE id > ?`
        const stmt = db.prepare(
            `SELECT id, data FROM mikser_entities ${where} ORDER BY id LIMIT ?`,
        )
        const matcher = residualMatcher(query, t.jsFilter)

        let lastId = ''
        while (true) {
            const rows = stmt.all(...t.params, lastId, CHUNK_SIZE)
            if (!rows.length) return
            for (const row of rows) {
                const entity = JSON.parse(row.data)
                if (!matcher || matcher(entity)) yield entity
            }
            if (rows.length < CHUNK_SIZE) return
            lastId = rows[rows.length - 1].id
        }
    }

    // Stub path — for tests that don't bring up the database.
    const shim = mapStub()
    if (!shim) return
    const m = query ? (typeof query === 'function' ? query : sift(query)) : null
    for (const entity of shim.all()) {
        if (!m || m(entity)) yield entity
    }
}

// Expand-and-project layer — sift filters with sort, pagination,
// dotted-path projection, plus optional inline-expand of $-keyed
// references (ADR-0007). Used by the api plugin's HTTP handlers,
// mikser-io-mcp's tools, and any library-mode caller.

async function findRef(ref) {
    if (!ref || typeof ref !== 'string') return null
    const matches = await findEntities(refFilter(ref))
    return matches[0] ?? null
}

function expandLimits() {
    const cfg = runtime?.config?.catalog?.expand ?? {}
    return {
        maxDepth:    typeof cfg.maxDepth    === 'number' ? cfg.maxDepth    : 5,
        maxPaths:    typeof cfg.maxPaths    === 'number' ? cfg.maxPaths    : 20,
        maxResolved: typeof cfg.maxResolved === 'number' ? cfg.maxResolved : 100,
    }
}

export function assertExpand(expand) {
    if (!expand?.length) return
    const { maxPaths, maxDepth } = expandLimits()
    if (expand.length > maxPaths) {
        throw new Error(
            `expand has ${expand.length} paths, exceeds maxPaths (${maxPaths})`,
        )
    }
    for (const p of expand) {
        const parts = p.split('.').filter(Boolean)
        if (parts.length > maxDepth) {
            throw new Error(
                `Path '${p}' has length ${parts.length}, exceeds maxDepth (${maxDepth})`,
            )
        }
    }
}

async function expandAndProject(entity, expand) {
    let result = entity
    if (expand?.length) {
        result = await expandEntity(entity, expand, {
            findRef,
            ...expandLimits(),
        })
    }
    if (!result?.meta) return result
    return { ...result, meta: projectMeta(result.meta) }
}

// Combine a caller's filter with an endpoint scope. A sift-shaped scope
// becomes part of the query so sift-to-sql can push it down; a function scope
// returns the filter untouched and is applied by the caller after the fetch.
export function scopedFilter(filter, scope) {
    if (!scope || typeof scope === 'function') return filter
    const hasFilter = filter && Object.keys(filter).length > 0
    return hasFilter ? { $and: [filter, scope] } : scope
}

export async function queryEntities({
    filter, sort, fields, skip, limit, expand, scope,
} = {}) {
    const effectiveLimit = Math.min(100, Math.max(1, limit ?? 25))
    const effectiveSkip = Math.max(0, skip ?? 0)

    // A sift-shaped `scope` is merged into the filter so it reaches
    // findEntities, where sift-to-sql pushes what it can into the WHERE
    // clause. A function `scope` cannot be translated and stays a post-fetch
    // predicate — which means the query materializes every row the caller's
    // own filter matched, including the ones the endpoint would then reject.
    // For an endpoint whose filter is broad (or absent) that is the entire
    // catalog, per request, and `limit` does not help: it is applied after
    // this. Prefer the object form.
    const scopePredicate = typeof scope === 'function' ? scope : null
    const effectiveFilter = scopedFilter(filter, scope)

    recordQuery(effectiveFilter)

    // Materialize via findEntities (which handles sqlite + shim
    // dispatch + js fallback).
    let all = await findEntities(effectiveFilter)
    if (scopePredicate) all = all.filter(scopePredicate)

    const total = all.length

    if (sort && Object.keys(sort).length) {
        const entries = Object.entries(sort)
        all.sort((a, b) => {
            for (const [key, dir] of entries) {
                const av = _.get(a, key)
                const bv = _.get(b, key)
                if (av == null && bv == null) continue
                if (av == null) return 1
                if (bv == null) return -1
                if (av < bv) return -dir
                if (av > bv) return dir
            }
            return 0
        })
    }

    let items = all.slice(effectiveSkip, effectiveSkip + effectiveLimit)
    items = await Promise.all(items.map(item => expandAndProject(item, expand)))
    if (fields?.length) items = items.map(e => _.pick(e, fields))

    return {
        items,
        total,
        skip: effectiveSkip,
        limit: effectiveLimit,
        hasNext: effectiveSkip + effectiveLimit < total,
    }
}

// Bulk snapshot of a collection's `(id, checksum)` pairs, returned
// as a `Map<id, checksum>`. The intended consumer is the source.js
// gate, which compares scanned file checksums against the catalog's
// recorded ones to decide whether a CREATE/UPDATE is needed.
//
// Goes through column projection (json_extract on the sqlite side)
// instead of materializing entities, so the cost scales with
// collection size, not with entity payload size. At 14k entities ×
// 7KB this is ~14× faster than the equivalent loop of per-file
// findById calls.
//
// Returns an empty Map when the catalog isn't open yet (test stub
// path, pre-onLoaded).
export function checksumsByCollection(collection) {
    const out = new Map()
    if (!db?.isOpen || !collection) return out
    for (const row of stmtChecksumsForCollection.iterate(collection)) {
        out.set(row.id, row.checksum)
    }
    return out
}

export async function readEntity({ id, expand } = {}) {
    if (!id) throw new Error('id is required')
    const result = await queryEntities({
        filter: { id },
        skip: 0,
        limit: 1,
        expand,
    })
    return result.items[0] ?? null
}

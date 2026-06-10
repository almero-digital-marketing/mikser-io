// Engine-level entity store. Sqlite-backed via the engine's shared
// database substrate (see src/database/) — ADR-0009.
//
// Schema (registered with the substrate at module load time):
//   mikser_entities (id, collection, type, format, name, meta_href,
//                     meta_layout, meta_lang, meta_cache, time, uri,
//                     data)
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
import { useLogger } from './engine.js'
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
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_meta_layout ON mikser_entities(meta_layout) WHERE meta_layout IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_meta_lang   ON mikser_entities(meta_lang)   WHERE meta_lang   IS NOT NULL;
    -- Partial index over meta.cache: false (rare opt-out for renders
    -- mikser can't track precisely). Typical site has 0-10; WHERE
    -- clause keeps the index tiny.
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_meta_cache  ON mikser_entities(meta_cache)  WHERE meta_cache  IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_time        ON mikser_entities(time);
    CREATE INDEX IF NOT EXISTS idx_mikser_entities_uri         ON mikser_entities(uri);
`)

function recordQuery(filter) {
    const ctx = queryContext.getStore()
    if (!ctx?.track) return
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
        for (const { operation, entity } of mutations) {
            switch (operation) {
                case OPERATION.CREATE:
                case OPERATION.UPDATE:
                    logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
                    stmtUpsert.run(entityToRow(entity))
                    // Static $-ref edges from entity.meta. Refs index
                    // does delete-then-insert internally so this is
                    // idempotent across UPDATE.
                    refsIndex?.indexEntity(entity)
                    cacheEvict(entity.id)   // next read returns fresh data
                    break
                case OPERATION.DELETE:
                    logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
                    stmtDelete.run(entity.id)
                    // FK ON DELETE CASCADE handles mikser_refs cleanup.
                    cacheEvict(entity.id)
                    break
            }
        }
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
            (id, collection, type, format, name, meta_href, meta_layout, meta_lang, meta_cache, time, uri, data)
        VALUES
            (@id, @collection, @type, @format, @name, @meta_href, @meta_layout, @meta_lang, @meta_cache, @time, @uri, @data)
        ON CONFLICT(id) DO UPDATE SET
            collection  = @collection,
            type        = @type,
            format      = @format,
            name        = @name,
            meta_href   = @meta_href,
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
    // Checkpoint the WAL so the main file size stays representative
    // and external tools (mikser --verify on a separate run, debug
    // scripts) see committed state. PASSIVE never blocks readers or
    // writers; it only catches up what it can.
    if (!db?.isOpen) return
    try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    } catch (err) {
        useLogger().warn('Catalog WAL checkpoint failed (%s) — data is durable, file size may lag', err.message)
    }
})

// Snapshot the catalog as `{ version, entities: [...] }`. Same shape
// the NDJSON test harness used to read off disk. O(N) — debug only.
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
    if (!query || typeof query !== 'object') return
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
        const sql = `SELECT data FROM mikser_entities ${t.sql} LIMIT ${t.jsFilter ? '' : '1'}`
        // With a jsFilter we may need to scan multiple rows before
        // finding a match; without one, LIMIT 1 short-circuits.
        const stmt = db.prepare(t.jsFilter
            ? `SELECT data FROM mikser_entities ${t.sql}`
            : `SELECT data FROM mikser_entities ${t.sql} LIMIT 1`)
        const matcher = t.jsFilter ? sift(t.jsFilter) : null
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
    const m = sift(query)
    for (const entity of shim.all()) {
        if (m(entity)) return entity
    }
}

// All entities (no arg) or those matching `query`. Indexed clauses
// push down to SQL; un-indexed clauses run as a sift filter over the
// pushdown result set.
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
        if (t.jsFilter) {
            const matcher = sift(t.jsFilter)
            return entities.filter(matcher)
        }
        return entities
    }

    const shim = mapStub()
    if (!shim) return []
    if (!query) return shim.all()
    const m = sift(query)
    return shim.all().filter(m)
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

export async function queryEntities({
    filter, sort, fields, skip, limit, expand, scope,
} = {}) {
    const effectiveLimit = Math.min(100, Math.max(1, limit ?? 25))
    const effectiveSkip = Math.max(0, skip ?? 0)

    recordQuery(filter)

    // Materialize via findEntities (which handles sqlite + shim
    // dispatch + js fallback). scope is a JS predicate applied
    // post-fetch.
    let all = await findEntities(filter)
    if (scope) all = all.filter(scope)

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

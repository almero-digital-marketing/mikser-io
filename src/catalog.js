// Engine-level entity store. Map<id, entity> in memory, NDJSON on disk
// at `runtime/catalog.ndjson`. Public ops: findEntity, findEntities,
// findById, queryEntities, readEntity, assertExpand.
//
// Map<id, entity> for the lookups that matter on the hot path:
// refs's BFS calls findById per edge, manifest's collectEdges resolves
// partials by id, source.js's gate looks up each scanned file. O(1) hash
// vs O(N) linear scan adds up at 10k+ entities.
//
// Persistence shape mirrors manifest.js: NDJSON (first line metadata
// `{__meta__, version}`, one entity per line), atomic write via tmp +
// rename, dirty-flag skip-on-clean, streaming line read. Versioned —
// reading a file with a mismatched version flips `cacheInvalidated` so
// the cycle re-emits.
//
// Fully in-memory at runtime — scale ceiling is heap. A truly lazy
// storage layer (sqlite or similar) is a separate conversation that
// would also need to push findEntities/queryEntities down to the store.

import path from 'node:path'
import { writeFile, rename } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import _ from 'lodash'
import sift from 'sift'
import { AsyncLocalStorage } from 'node:async_hooks'

import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onInitialized, onPersist, onFinalized } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { expandEntity, projectMeta, refFilter } from './utils.js'
import { normalizeFilter } from './track.js'
import packageInfo from '../package.json' with { type: 'json' }

const CATALOG_FILE = 'catalog.ndjson'

// Context propagated through async boundaries via Node's AsyncLocalStorage.
// Consumers (engine's render dispatch, api plugin's per-query cache,
// preview plugin's in-memory cache) wrap a slice of work in
// `queryContext.run({track}, …)`; catalog query methods below read the
// store and report which filters the work consulted.
//
// Called from outside any `.run(...)` (plugin lifecycle, raw MCP
// handlers, anywhere without a context): `getStore()` returns
// undefined, no tracking. Same query methods serve all callers.
export const queryContext = new AsyncLocalStorage()

function recordQuery(filter) {
    const ctx = queryContext.getStore()
    if (!ctx?.track) return
    ctx.track.query(normalizeFilter(filter))
}

// Module-level state. Single Map<id, entity> is the source of truth.
// Streaming-loaded at onInitialized; dirty-tracked across mutations so
// onFinalized can skip the write when nothing changed.
const byId = new Map()
let dirty = false

onInitialized(async () => {
    byId.clear()
    dirty = false
    let loadedVersion = null
    let cacheInvalidated = false

    const catalogPath = path.join(runtime.options.runtimeFolder, CATALOG_FILE)
    if (existsSync(catalogPath)) {
        try {
            // NDJSON: one snapshot per line. First line is a metadata
            // header carrying the engine version that wrote the file;
            // subsequent lines are entities. Streaming via readline so
            // memory stays bounded as the catalog grows.
            const stream = createReadStream(catalogPath)
            const rl = createInterface({ input: stream, crlfDelay: Infinity })
            for await (const line of rl) {
                if (!line.trim()) continue
                try {
                    const obj = JSON.parse(line)
                    if (obj.__meta__) {
                        loadedVersion = obj.version
                    } else if (obj.id) {
                        byId.set(obj.id, obj)
                    }
                } catch (err) {
                    useLogger().warn('Skipping malformed catalog line: %s', err.message)
                }
            }
        } catch (err) {
            // Malformed file (truncated by a crash, hand-edited badly,
            // partially-written on disk-full) would otherwise blow up
            // the whole startup. Fall back to empty + cacheInvalidated
            // so the rest of the cycle re-processes from scratch.
            useLogger().error('Catalog read failed (%s) — starting with empty catalog', err.message)
            byId.clear()
            cacheInvalidated = true
        }
    }

    if (loadedVersion && loadedVersion !== packageInfo.version) {
        cacheInvalidated = true
    }

    runtime.catalog = {
        byId,
        version: packageInfo.version,
        cacheInvalidated,
        save,
    }

    if (cacheInvalidated) {
        useLogger().notice(
            'Catalog cache invalidated: prior=%s current=%s — re-processing this cycle',
            loadedVersion ?? '(none)',
            packageInfo.version,
        )
    }
})

// Persist if anything has changed since the last successful save. NDJSON
// write — one entity per line, with a metadata header line carrying the
// engine version. Atomic via write-tmp + rename so a crash mid-write
// leaves the previous file intact.
async function save() {
    if (!dirty) return
    const catalogPath = path.join(runtime.options.runtimeFolder, CATALOG_FILE)
    const tmpPath = catalogPath + '.tmp'
    const lines = [JSON.stringify({ __meta__: true, version: packageInfo.version })]
    for (const entity of byId.values()) {
        lines.push(JSON.stringify(entity))
    }
    await writeFile(tmpPath, lines.join('\n') + '\n', 'utf8')
    await rename(tmpPath, catalogPath)
    dirty = false
}

onPersist(async () => {
    const logger = useLogger()
    for await (let { operation, entity } of useJournal('Catalog')) {
        switch (operation) {
            case OPERATION.CREATE:
            case OPERATION.UPDATE:
                logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
                // Upsert. CREATE and UPDATE collapse to the same operation
                // here: source plugins re-emit CREATE on every scan, and
                // plugins that "ensure an entity is in the catalog" call
                // runtime.update without a findEntity-then-branch dance.
                byId.set(entity.id, entity)
                dirty = true
                break
            case OPERATION.DELETE:
                logger.trace('Database %s %s: %s', entity.collection, operation, entity.id)
                if (byId.delete(entity.id)) dirty = true
                break
        }
    }
})

onFinalized(async () => {
    await save()
})

// Synchronous by-id lookup. Untracked — does NOT record a query
// dependency in queryContext, because the consumers are hot-path
// internal modules (manifest snapshot construction, refs inverse walk,
// catalog's own upsert check) that read the catalog for engine
// bookkeeping, not as a render-time data dep. Returns the entity or
// null. O(1) Map lookup.
export function findById(id) {
    if (!id) return null
    return runtime.catalog?.byId.get(id) ?? null
}

// Find one entity by sift filter. Two shapes:
//   - `{id: 'foo', ...rest}` — fast O(1) path: lookup by id, then
//     run the remaining keys as a sift filter against the result.
//   - any other sift filter — `sift(filter)` predicate, iterates
//     `byId.values()`.
//
// Function predicates aren't accepted — sift covers `$or`, `$in`,
// `$nin`, `$gt`/`$lt`, `$regex`, dotted-path keys, etc. The structured
// shape is the only shape so the catalog's eventual indexed backend
// can push the filter down to storage. For inline per-entity tests
// without going through the catalog, use a plain `if` (or `sift(...)`
// on the filter you already have).
export async function findEntity(query) {
    if (!query || typeof query !== 'object') return
    recordQuery(query)
    if (!runtime.catalog) return

    if (query.id && typeof query.id === 'string') {
        const entity = runtime.catalog.byId.get(query.id)
        if (!entity) return
        const rest = Object.fromEntries(
            Object.entries(query).filter(([k]) => k !== 'id'),
        )
        if (Object.keys(rest).length === 0) return entity
        return sift(rest)(entity) ? entity : undefined
    }

    const match = sift(query)
    for (const entity of runtime.catalog.byId.values()) {
        if (match(entity)) return entity
    }
    return
}

// All entities (no arg) or those matching `query` (sift filter). For
// sift filters with pagination, sort, and expand, use `queryEntities`
// below.
export async function findEntities(query) {
    recordQuery(query)
    if (!runtime.catalog) return []
    if (!query) return Array.from(runtime.catalog.byId.values())
    if (typeof query !== 'object') return []
    const match = sift(query)
    const out = []
    for (const entity of runtime.catalog.byId.values()) {
        if (match(entity)) out.push(entity)
    }
    return out
}

// High-level CRUD-with-query surface — sift filters, sort, pagination,
// dotted-path projection, plus optional inline-expand of $-keyed
// references (ADR-0007). Used by the api plugin's HTTP handlers, the
// mikser-io-mcp plugin's tools, and any library-mode caller.

// Resolve a ref string to an entity. Uses the same id / meta.href /
// stripped-extension heuristic as `matchesRef`, expressed as the sift
// filter from `refFilter` so the storage layer can index it the same
// way as any other findEntity call. Untracked: expand-driven ref
// resolution is an implementation detail of queryEntities and
// shouldn't surface as a separate query dep.
async function findRef(ref) {
    if (!ref || typeof ref !== 'string' || !runtime.catalog) return null
    const match = sift(refFilter(ref))
    for (const entity of runtime.catalog.byId.values()) {
        if (match(entity)) return entity
    }
    return null
}

// Per-call expansion caps. Plumbed from mikser.config.js:
//   catalog: { expand: { maxDepth, maxPaths, maxResolved } }
// Defaults match ADR-0007 B7.
function expandLimits() {
    const cfg = runtime?.config?.catalog?.expand ?? {}
    return {
        maxDepth:    typeof cfg.maxDepth    === 'number' ? cfg.maxDepth    : 5,
        maxPaths:    typeof cfg.maxPaths    === 'number' ? cfg.maxPaths    : 20,
        maxResolved: typeof cfg.maxResolved === 'number' ? cfg.maxResolved : 100,
    }
}

// Validate an `expand` spec against the configured caps. Throws on
// violation; returns nothing on success. Used by `subscribe()` at
// registration time to reject bad expand before opening any transport
// channels.
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

// Apply expand-then-project to one entity. When `expand` has entries
// the walker inlines resolved refs first; in all cases the final meta
// is normalized (`$`-keys stripped) so the wire shape matches what the
// SDK consumers and templates expect per ADR-0007 A3. Private — the
// only callers are queryEntities (per-item) and readEntity (via
// queryEntities). External code expands by going through one of those.
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

// Paginated, sorted, filtered, projected query over the catalog. The
// `scope` arg is an optional pre-filter predicate (used by the api
// plugin's per-endpoint allowedEntities lambda); library callers
// usually pass nothing. Returns `{ items, total, skip, limit, hasNext }`.
export async function queryEntities({
    filter, sort, fields, skip, limit, expand, scope,
} = {}) {
    const effectiveLimit = Math.min(100, Math.max(1, limit ?? 25))
    const effectiveSkip = Math.max(0, skip ?? 0)

    recordQuery(filter)

    let all = runtime.catalog ? Array.from(runtime.catalog.byId.values()) : []
    if (scope) all = all.filter(scope)

    if (filter && Object.keys(filter).length) {
        const match = sift(filter)
        all = all.filter(match)
    }

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

// Read a single entity by catalog id. Returns the entity (post-expand,
// post-project) or null when not found. Throws on missing id.
// Source-file content loading is a separate concern — compose with
// `readEntityContent` from utils.js if you want `entity.content`
// populated, or call `readFile(entity.uri)` directly for raw bytes.
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

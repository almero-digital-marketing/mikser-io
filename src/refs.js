// Engine-level reverse-reference index. Persisted in `mikser_refs`
// alongside `mikser_entities` and maintained inside catalog.onPersist's
// transaction (static `$`-keyed refs from entity.meta) plus per-render
// `replaceDynamic` calls (layout/partial/query edges from the track
// API).
//
// Two kinds of edges share the same table, distinguished by the `kind`
// column:
//
//   kind='ref'                — static `$`-keyed edge from entity meta
//                               (ADR-0007 A1). field = dotted path.
//   kind='layout' | 'partial'
//   | 'query'                 — dynamic render-time edge populated by
//                               the engine after each successful render
//                               via the track API. field = '' (empty).
//
// Every row carries BOTH the question and the answer:
//
//   target_ref  — the string the dependent asked for. May be an id, a
//                 meta.href, a meta.url (ADR-0011 served path), or an
//                 id with its extension stripped.
//   target_id   — the entity it actually resolved to, '' when nothing
//                 did. NOT NULL because WITHOUT ROWID requires it of
//                 primary-key columns, and it is in the key so one
//                 dependent can bind one name to several entities
//                 (language variants).
//
// Both are load-bearing. Answering "who depends on X?" from target_ref
// alone means guessing which strings X could have answered to, and that
// guess fails the moment X changes its name: the recorded string is then
// derivable from no live state. target_id alone cannot express a forward
// or dangling reference, nor re-bind when an entity later claims a name
// nobody could resolve before.
//
// Lookups are indexed SELECTs over (target_ref, kind), (target_id) and
// (source_id):
//
//   inbound  :: "Which entities reference this target_ref?"
//   outbound :: "Which target_refs does this source emit?"
//
// The catalog is the source of truth (ADR-0002); mikser_refs is a
// projection maintained alongside it. ON DELETE CASCADE means
// mikser_entities deletes cascade automatically — no orphaned refs.
//
// Lives in the engine (not as a plugin) per ADR-0006's five-test:
// substrate (not domain), strategic (operationalises ADR-0007 as a
// queryable graph), can't cleanly be a plugin without every consumer
// paying soft-dependency cost.

import sift from 'sift'
import runtime from './runtime.js'
import { useLogger } from './engine/index.js'
import { onLoaded, onPersist } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { extractRefs, isRefKey, writeEntity, lookupKeys, refFilter } from './utils/index.js'
import { findEntity, findById } from './catalog.js'
import { registerSchema, useDatabase } from './database/index.js'

// Schema registration. Applied idempotently at db.open(). FK to
// mikser_entities means a catalog DELETE cascades to refs cleanup,
// no orphans. WITHOUT ROWID makes (source_id, target_ref, kind, field)
// the clustered key — smaller, faster prefix scans on source_id.
//
// Index on target_ref covers the inverse-direction lookup (everyone
// who references X). The primary key's leading source_id column
// already covers forward (everything X references) without a
// separate index.
//
// Exported so tests build their index over the real schema rather than a
// copy. A copy drifts the moment a column is added, and the failure is a
// bare SQLITE_ERROR that names nothing.
export const REFS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS mikser_refs (
        source_id   TEXT NOT NULL,
        target_ref  TEXT NOT NULL,
        target_id   TEXT NOT NULL DEFAULT '',
        kind        TEXT NOT NULL,
        field       TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, target_ref, kind, field, target_id),
        FOREIGN KEY (source_id) REFERENCES mikser_entities(id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_mikser_refs_target ON mikser_refs(target_ref);
    CREATE INDEX IF NOT EXISTS idx_mikser_refs_target_id ON mikser_refs(target_id);
`
registerSchema('mikser_refs', REFS_SCHEMA)

// json_tree's `fullkey` → the field path the ref index uses.
// `$.meta.items[0].href` → `items[0].href`, and a quoted segment
// (`$.meta."$author"`, which is how json_tree spells a key starting with
// `$`) loses its quotes so both spellings compare equal.
function normalizeMetaPath(fullkey) {
    return String(fullkey)
        .replace(/^\$\.meta\.?/, '')
        .replace(/"([^"]*)"/g, '$1')
}

// Build the index handle over the provided sqlite database. Prepares
// the SQL statements once at construction; subsequent reads/writes
// reuse them.
//
// Exported so tests can build an index over an in-memory sqlite without
// driving the full lifecycle. Production wiring lives in createRefs()
// below.
export function createIndex(db) {
    if (!db) throw new Error('createIndex: db is required')

    // Read statements
    const stmtInboundStatic = db.prepare(`
        SELECT source_id, field FROM mikser_refs
        WHERE target_ref = ? AND kind = 'ref'
    `)
    // Any string value anywhere under an entity's meta that equals the
    // target — including inside arrays, which is where nav and footer link
    // lists live. json_tree walks the stored JSON, so no schema and no
    // write-time indexing is involved.
    const stmtInboundMetaValue = db.prepare(`
        SELECT DISTINCT e.id AS id, j.fullkey AS field
        FROM mikser_entities e, json_tree(e.data, '$.meta') j
        WHERE j.type = 'text' AND j.value = ?
    `)

    const stmtOutboundStatic = db.prepare(`
        SELECT field, target_ref FROM mikser_refs
        WHERE source_id = ? AND kind = 'ref'
    `)
    const stmtInboundAny = db.prepare(`
        SELECT DISTINCT source_id FROM mikser_refs
        WHERE target_ref = ?
    `)
    // Identity-direction inbound: everything BOUND to this entity, under
    // whatever name it was asked for. Immune to the target renaming
    // itself, which is the whole point — the binding was recorded when
    // it was made instead of re-derived from the target's current names.
    const stmtInboundByTargetId = db.prepare(`
        SELECT DISTINCT source_id FROM mikser_refs
        WHERE target_id = ? AND target_id != ''
    `)
    const stmtInboundDynamic = db.prepare(`
        SELECT source_id, kind FROM mikser_refs
        WHERE target_ref = ? AND kind != 'ref'
    `)
    const stmtOutboundDynamic = db.prepare(`
        SELECT kind, target_ref FROM mikser_refs
        WHERE source_id = ? AND kind != 'ref'
    `)
    const stmtAllRefs = db.prepare(`
        SELECT DISTINCT target_ref FROM mikser_refs WHERE kind = 'ref'
    `)
    const stmtCountStaticEdges = db.prepare(`
        SELECT COUNT(*) AS c FROM mikser_refs WHERE kind = 'ref'
    `)
    const stmtCountStaticTargets = db.prepare(`
        SELECT COUNT(DISTINCT target_ref) AS c FROM mikser_refs WHERE kind = 'ref'
    `)
    const stmtCountStaticSources = db.prepare(`
        SELECT COUNT(DISTINCT source_id) AS c FROM mikser_refs WHERE kind = 'ref'
    `)
    const stmtCountDynamicEdges = db.prepare(`
        SELECT COUNT(*) AS c FROM mikser_refs WHERE kind != 'ref'
    `)
    const stmtCountDynamicSources = db.prepare(`
        SELECT COUNT(DISTINCT source_id) AS c FROM mikser_refs WHERE kind != 'ref'
    `)

    // Synchronous resolution of a ref string to entity ids. Mirrors
    // `refFilter` in utils/ — id, meta.href, meta.url, then
    // id-minus-extension — but as sync SQL, because indexEntity runs
    // inside catalog.applyJournalMutations' transaction and
    // better-sqlite3 transactions are sync-only.
    //
    // Returns every match, not the first: a name shared by language
    // variants binds to all of them, and over-binding only ever means
    // more invalidation, which the manifest's hash check then filters.
    const stmtResolveExact = db.prepare(`
        SELECT id FROM mikser_entities
        WHERE id = ? OR meta_href = ? OR meta_url = ?
    `)
    const stmtResolveExtended = db.prepare(`
        SELECT id FROM mikser_entities WHERE id GLOB ?
    `)
    function resolveRefIds(ref) {
        if (typeof ref !== 'string' || !ref) return []
        const ids = new Set()
        for (const row of stmtResolveExact.all(ref, ref, ref)) ids.add(row.id)
        // The extension-tolerant form. GLOB narrows to `<ref>.something`
        // using the primary key's prefix; the regex then enforces
        // EXACTLY one trailing extension and no further path segment,
        // matching refFilter's `^ref\.[^./]+$`.
        //
        // SQLite's GLOB has no escape syntax, so a ref containing GLOB
        // metacharacters cannot be used as a literal prefix. Skip the
        // narrowing rather than run a pattern that means something else
        // than the caller wrote; the exact forms above still apply, and
        // the name-direction query still covers the edge.
        if (/[*?[\]]/.test(ref)) return [...ids]
        const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const oneExtension = new RegExp(`^${escaped}\\.[^./]+$`)
        for (const row of stmtResolveExtended.all(`${ref}.*`)) {
            if (oneExtension.test(row.id)) ids.add(row.id)
        }
        return [...ids]
    }

    // Write statements
    const stmtClearStaticForSource = db.prepare(`
        DELETE FROM mikser_refs WHERE source_id = ? AND kind = 'ref'
    `)
    const stmtClearDynamicForSource = db.prepare(`
        DELETE FROM mikser_refs WHERE source_id = ? AND kind != 'ref'
    `)
    const stmtInsertEdge = db.prepare(`
        INSERT OR IGNORE INTO mikser_refs (source_id, target_ref, target_id, kind, field)
        VALUES (?, ?, ?, ?, ?)
    `)

    // -- Read API ------------------------------------------------------

    // Everything that points at `ref`, by BOTH mechanisms.
    //
    // The index holds `$`-keyed refs only, because those are the ones the
    // engine resolves and invalidates on. But a site links to a page far
    // more often with a plain string — `items: [{ label, href: '/about' }]`
    // in a nav or footer document — and asking "what breaks if I delete
    // this" got `count: 0` while two live pages linked to it. A silent miss
    // is worse than no answer for that question.
    //
    // Plain values are found at READ time with json_tree over each entity's
    // meta rather than indexed at write time: indexing every string in every
    // meta would put the whole catalog in the edge table to serve a
    // diagnostic, and the engine does not invalidate on plain strings
    // anyway — which is itself worth knowing, and is why the two kinds stay
    // labelled rather than merged.
    function inboundFor(ref) {
        const refs = stmtInboundStatic.all(ref)
            .map(r => ({ id: r.source_id, field: r.field, kind: 'ref' }))
        const seen = new Set(refs.map(r => `${r.id}|${r.field}`))
        const hrefs = []
        for (const row of stmtInboundMetaValue.all(ref)) {
            const field = normalizeMetaPath(row.field)
            // A `$`-keyed path is the ref index's territory by definition, and
            // json_tree finds those values too — reporting them again as
            // `href` would double-count every ref and mislabel it. Note that
            // json_tree QUOTES a key beginning with `$` (`$.meta."$author"`),
            // so this has to run after unquoting or the two spellings never
            // meet and the dedup below misses.
            if (field.split('.').some(seg => seg.startsWith('$'))) continue
            // `meta.href` / `meta.url` at the top level are the entity's own
            // ADDRESS, not a link to something else. Without this, asking
            // what points at /about lists /documents/bg/about.md — the page
            // itself — among the things that would break if it were deleted.
            if (field === 'href' || field === 'url') continue
            if (seen.has(`${row.id}|${field}`)) continue
            hrefs.push({ id: row.id, field, kind: 'href' })
        }
        return [...refs, ...hrefs]
    }

    function outboundFor(sourceId) {
        return stmtOutboundStatic.all(sourceId)
            .map(r => ({ field: r.field, ref: r.target_ref }))
    }

    function allRefs() {
        return stmtAllRefs.all().map(r => r.target_ref)
    }

    function size() {
        return {
            refs:           stmtCountStaticTargets.get().c,
            sources:        stmtCountStaticSources.get().c,
            edges:          stmtCountStaticEdges.get().c,
            dynamicSources: stmtCountDynamicSources.get().c,
            dynamicEdges:   stmtCountDynamicEdges.get().c,
        }
    }

    function dynamicInboundFor(target) {
        return stmtInboundDynamic.all(target)
            .map(r => ({ id: r.source_id, kind: r.kind }))
    }

    function dynamicOutboundFor(sourceId) {
        return stmtOutboundDynamic.all(sourceId)
            .map(r => ({ kind: r.kind, target: r.target_ref }))
    }

    // Transitive inverse-closure walk from a set of seed entities.
    // Crosses BOTH static $-ref edges AND dynamic (layout / partial /
    // query) edges — `stmtInboundAny` selects every kind. Returns
    // Set<entityId> of every entity that transitively depends on any
    // seed, including the seeds themselves.
    //
    // Each seed contributes three lookup keys (id, meta.href, id with
    // its extension stripped) — matching the canonical resolution
    // schemas / findRef use. Cycle-safe via the result Set.
    function inverseClosureOf(seeds, getEntityById) {
        const closure = new Set()
        const toWalk = []

        const enqueue = (id, entity) => {
            if (!id || closure.has(id)) return
            closure.add(id)
            toWalk.push({ id, entity })
        }

        for (const seed of seeds ?? []) {
            const entity = typeof seed === 'string' ? null : seed
            enqueue(entity?.id ?? (typeof seed === 'string' ? seed : null), entity)
        }

        while (toWalk.length > 0) {
            const { id, entity } = toWalk.shift()
            const referrers = new Set()

            // Identity direction: edges BOUND to this entity. Survives
            // the entity renaming itself, because the binding was
            // recorded at resolve time rather than reconstructed from
            // whatever names it happens to carry now.
            for (const row of stmtInboundByTargetId.all(id)) referrers.add(row.source_id)

            // Name direction: edges that ASKED for a name this entity
            // answers to. Covers unresolved/forward references, and an
            // entity that has just started answering to a name nobody
            // could resolve before.
            //
            // Union rather than either alone: a superset of what each
            // direction finds on its own, so no dependency is missed
            // because it was recorded under the other one. Over-
            // approximating here is cheap — manifest.skipDecision still
            // compares hashes and drops anything that did not change.
            for (const key of lookupKeys(entity ?? { id })) {
                for (const row of stmtInboundAny.all(key)) referrers.add(row.source_id)
            }

            for (const sourceId of referrers) {
                enqueue(sourceId, getEntityById?.(sourceId))
            }
        }

        return closure
    }

    // -- Write API -----------------------------------------------------
    //
    // Catalog.onPersist calls `indexEntity` from inside its transaction
    // for every CREATE / UPDATE journal entry. Engine.js calls
    // `replaceDynamic` after each successful render. DELETEs cascade
    // automatically via the FK — no explicit removeEntity needed.

    // Replace this entity's static refs in mikser_refs. Idempotent:
    // delete-then-insert wipes prior edges for the same source. Caller
    // must be inside a transaction (catalog.onPersist provides one).
    function indexEntity(entity) {
        if (!entity?.id) return
        stmtClearStaticForSource.run(entity.id)
        if (!entity.meta) return
        for (const { path, ref } of extractRefs(entity.meta)) {
            // Resolve now and record what it bound to. An unresolvable
            // ref still gets its row with target_id '' — a forward
            // reference is a real dependency, and the name-direction
            // query is what will find it when the target appears.
            const targetIds = resolveRefIds(ref)
            if (!targetIds.length) {
                stmtInsertEdge.run(entity.id, ref, '', 'ref', path)
                continue
            }
            for (const targetId of targetIds) {
                stmtInsertEdge.run(entity.id, ref, targetId, 'ref', path)
            }
        }
    }

    // Replace this source's dynamic edges (layout / partial / query)
    // with `edges`. Empty array clears them. Per-call transaction —
    // multiple replaceDynamic invocations during one cycle are
    // independently atomic.
    function replaceDynamic(sourceId, edges) {
        db.transaction(() => {
            stmtClearDynamicForSource.run(sourceId)
            if (!edges?.length) return
            for (const { kind, target, targetId, targetIds } of edges) {
                if (!kind || !target) continue
                // Render-time edges already know what they resolved to —
                // the lookup helper had the entity in hand — so no
                // re-resolution here. `targetIds` carries the plural
                // case (one name, several language variants).
                const ids = targetIds?.length ? targetIds : targetId ? [targetId] : ['']
                for (const id of ids) {
                    stmtInsertEdge.run(sourceId, target, id, kind, '')
                }
            }
        })
    }

    function clearDynamic(sourceId) {
        replaceDynamic(sourceId, [])
    }

    const stmtClearAllStatic  = db.prepare(`DELETE FROM mikser_refs WHERE kind = 'ref'`)
    const stmtClearAll        = db.prepare(`DELETE FROM mikser_refs`)

    // One-shot rebuild — clears all static refs, then re-indexes the
    // given entities. Not used on hot paths (catalog.onPersist maintains
    // refs incrementally), but useful for tests and for a future
    // operational "rebuild from scratch" command. Wrapped in a single
    // transaction so the index is never observed mid-rebuild.
    function rebuild(entities) {
        db.transaction(() => {
            stmtClearAllStatic.run()
            if (!entities?.length) return
            for (const e of entities) indexEntity(e)
        })
    }

    function clear() {
        stmtClearAll.run()
    }

    return {
        // Read
        inboundFor,
        outboundFor,
        allRefs,
        size,
        dynamicInboundFor,
        dynamicOutboundFor,
        inverseClosureOf,
        // Synchronous ref -> entity ids, mirroring refFilter's four
        // forms. Exposed because the manifest needs the same binding
        // the index records: hashing a static $-ref with catalog's
        // findById only ever worked for id-form refs, since findById is
        // an exact primary-key read.
        resolveRefIds,
        // Write
        indexEntity,
        replaceDynamic,
        clearDynamic,
        rebuild,
        clear,
    }
}

// -- Subscribers -----------------------------------------------------
//
// Subscriber dispatch lives in this module (not in the index) so the
// subscribe/dispatch logic stays portable — useful for tests that
// don't want to spin up a DB.

// Graph subscriptions. A subscriber registers `{filter, expand, onAffected}`
// and gets called every cycle for each (root, mutatedEntity) pair where:
//   - `root` is an entity matching `filter`
//   - the cycle's mutation chain ends at a node within `expand`-depth of `root`
//
// Implementation: at end of each cycle, walk the inverse-ref graph from
// each mutated entity up to `maxDepth(expand)` hops. At every visited
// node, evaluate each subscriber's filter; on match, dispatch.
//
// `getEntityById` is injected so tests can run the subscribe/dispatch
// machinery without a full runtime/catalog harness. In production it's
// wired to catalog.findById via createRefs() below.
export function createSubscribers(index, getEntityById) {
    if (typeof getEntityById !== 'function') {
        throw new Error('createSubscribers: getEntityById is required')
    }
    const subscribers = new Set()

    function add(sub) {
        subscribers.add(sub)
        const dispose = () => subscribers.delete(sub)
        if (sub.signal) {
            if (sub.signal.aborted) dispose()
            else sub.signal.addEventListener('abort', dispose, { once: true })
        }
        return { dispose }
    }

    function maxDepthOf(expand) {
        if (!Array.isArray(expand) || expand.length === 0) return 0
        let max = 0
        for (const path of expand) {
            const n = typeof path === 'string' ? path.split('.').length : 0
            if (n > max) max = n
        }
        return max
    }

    function inverseReach(startEntity, depth) {
        const visited = new Map()
        if (!startEntity?.id) return visited
        visited.set(startEntity.id, 0)
        if (depth === 0) return visited

        let frontier = [startEntity]
        for (let d = 1; d <= depth; d++) {
            const next = []
            for (const entity of frontier) {
                const candidates = inverseReferrersOf(entity)
                for (const referrer of candidates) {
                    if (visited.has(referrer.id)) continue
                    visited.set(referrer.id, d)
                    next.push(referrer)
                }
            }
            if (next.length === 0) break
            frontier = next
        }
        return visited
    }

    function inverseReferrersOf(entity) {
        const seenIds = new Set()
        const out = []
        for (const ref of lookupKeys(entity)) {
            for (const { id } of index.inboundFor(ref)) {
                if (seenIds.has(id)) continue
                seenIds.add(id)
                const referrer = getEntityById(id)
                if (referrer) out.push(referrer)
            }
        }
        return out
    }

    async function dispatch(mutations) {
        if (subscribers.size === 0 || mutations.length === 0) return

        const maxDepth = Math.max(
            0,
            ...[...subscribers].map(s => maxDepthOf(s.expand)),
        )

        for (const mutated of mutations) {
            const reached = inverseReach(mutated, maxDepth)
            for (const [visitedId, hopsFromMutation] of reached) {
                const visitedEntity = getEntityById(visitedId)
                if (!visitedEntity) continue
                for (const sub of subscribers) {
                    if (typeof sub.filter !== 'function') continue
                    if (maxDepthOf(sub.expand) < hopsFromMutation) continue
                    if (!sub.filter(visitedEntity)) continue
                    try {
                        await sub.onAffected({ root: visitedEntity, mutated })
                    } catch (err) {
                        try {
                            useLogger().warn('runtime.refs subscriber threw: %s', err.message)
                        } catch { /* no logger — silent */ }
                    }
                }
            }
        }
    }

    return { add, dispatch, inverseReach }
}

// Filter-based subscribers — sift-matched, no graph walk. See module
// header for the intent split with createSubscribers.
export function createQuerySubscribers() {
    const subscribers = new Set()

    function add(sub) {
        subscribers.add(sub)
        const dispose = () => subscribers.delete(sub)
        if (sub.signal) {
            if (sub.signal.aborted) dispose()
            else sub.signal.addEventListener('abort', dispose, { once: true })
        }
        return { dispose }
    }

    async function dispatch(mutations) {
        if (subscribers.size === 0 || mutations.length === 0) return
        for (const sub of subscribers) {
            const matcher = sift(sub.filter)
            for (const mutated of mutations) {
                if (!matcher(mutated)) continue
                try {
                    await sub.onAffected({ mutated })
                } catch (err) {
                    try {
                        useLogger().warn('runtime.refs.subscribeQuery handler threw: %s', err.message)
                    } catch { /* no logger — silent */ }
                }
            }
        }
    }

    return { add, dispatch }
}

// Build the public `runtime.refs.*` surface. The caller (the onLoaded
// hook below) builds the index separately so static-ref maintenance
// in catalog.onPersist can share it via useRefsIndex(). For tests and
// standalone use, pass null for `prebuiltIndex` and createRefs will
// build its own.
export function createRefs(db, prebuiltIndex = null) {
    const index = prebuiltIndex ?? createIndex(db)
    const subscribers = createSubscribers(index, findById)
    const querySubscribers = createQuerySubscribers()

    // Per-cycle dispatch hook. No rebuild walk anymore — catalog.onPersist
    // maintains mikser_refs incrementally inside its own transaction,
    // so by the time our onPersist runs (after catalog's, by import
    // order in index.js), every static ref edge for this cycle's
    // mutations is already in the DB.
    onPersist(async (signal) => {
        const mutations = []
        for await (let { operation, entity } of useJournal(
            'Refs dispatch',
            [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
            signal,
        )) {
            mutations.push(entity)
        }

        await subscribers.dispatch(mutations)
        await querySubscribers.dispatch(mutations)
    })

    return {
        // Static $-ref edges
        inboundFor:  (ref) => index.inboundFor(ref),
        outboundFor: (id)  => index.outboundFor(id),
        allRefs:     ()    => index.allRefs(),
        size:        ()    => index.size(),

        // Dynamic (render-time) edges
        dynamicOutboundFor: (id)     => index.dynamicOutboundFor(id),
        dynamicInboundFor:  (target) => index.dynamicInboundFor(target),

        inverseClosureOf: (seeds) => index.inverseClosureOf(seeds, findById),

        // Resolve a ref string to the entity ids it binds to — the same
        // four forms refFilter uses, synchronously. The manifest needs
        // it to hash a static $-ref correctly.
        resolveRefIds: (ref) => index.resolveRefIds(ref),

        // Replace dynamic edges for a source — called by the engine
        // after a successful render via the track API.
        replaceDynamic: (sourceId, edges) => index.replaceDynamic(sourceId, edges),
        clearDynamic:   (sourceId)        => index.clearDynamic(sourceId),

        // Public subscribe API per ADR-0007 B9 / live-expand design.
        //
        //   const sub = runtime.refs.subscribeGraph({
        //       filter:     (entity) => entity.type === 'post',
        //       expand:     ['author', 'tags.*'],     // depth-2 graph
        //       onAffected: async ({ root, mutated }) => { ... },
        //       signal,                              // optional AbortSignal
        //   })
        //   sub.dispose()
        subscribeGraph(opts = {}) {
            const { filter, expand, onAffected, signal } = opts
            if (typeof filter !== 'function') {
                throw new Error('runtime.refs.subscribeGraph: filter must be a function')
            }
            if (typeof onAffected !== 'function') {
                throw new Error('runtime.refs.subscribeGraph: onAffected must be a function')
            }
            return subscribers.add({ filter, expand, onAffected, signal })
        },

        // Filter-based subscriptions. Same teardown shape as
        // subscribeGraph — `dispose()` or abort the signal.
        subscribeQuery(opts = {}) {
            const { filter, onAffected, signal } = opts
            if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
                throw new Error('runtime.refs.subscribeQuery: filter must be a sift expression object')
            }
            if (typeof onAffected !== 'function') {
                throw new Error('runtime.refs.subscribeQuery: onAffected must be a function')
            }
            return querySubscribers.add({ filter, onAffected, signal })
        },

        // Atomic rename cascade. Walks the inverse index for `from`,
        // opens each referencing source file, rewrites the `$`-keyed
        // value via writeEntity. Watcher resyncs on the next cycle.
        async rename({ from, to } = {}) {
            if (!from || !to) {
                throw new Error('runtime.refs.rename: both `from` and `to` are required')
            }
            if (from === to) return { from, to, updated: [], failures: [] }

            // `$`-keyed refs only, deliberately. inboundFor also reports
            // plain string matches now — a nav item's `href` — but writeEntity
            // patches `$`-keyed values, and rewriting arbitrary meta strings
            // through it is a file-mutating change nobody asked for. A plain
            // href pointing at the old name is REPORTED as unrewritten below
            // rather than silently rewritten or silently skipped.
            const all = index.inboundFor(from)
            const entries = all.filter(e => e.kind !== 'href')
            const unrewritten = all.filter(e => e.kind === 'href')
            if (entries.length === 0) {
                return { from, to, updated: [], failures: [], unrewritten }
            }

            const byEntity = new Map()
            for (const { id, field } of entries) {
                if (!byEntity.has(id)) byEntity.set(id, [])
                byEntity.get(id).push(field)
            }

            const updated = []
            const failures = []

            for (const [id, fields] of byEntity.entries()) {
                const entity = await findEntity({ id })
                if (!entity) {
                    failures.push({ id, error: 'source entity not in catalog' })
                    continue
                }
                try {
                    const patch = buildRenamePatch(entity, fields, from, to)
                    if (Object.keys(patch).length === 0) continue
                    await writeEntity(entity, patch)
                    updated.push({ id, fields })
                } catch (err) {
                    failures.push({ id, error: err.message })
                }
            }

            return { from, to, updated, failures, unrewritten }
        },
    }
}

// Module-level wiring. createRefs needs the DB; useDatabase() returns
// null until database.js's onLoaded fires, so we defer wiring to that
// phase. catalog.js is imported before refs.js in index.js, so its
// onLoaded (which opens prepared statements over mikser_entities)
// runs before ours. Static-ref maintenance happens in catalog.onPersist
// via the index handle we expose on runtime; see catalog.js for the
// hook integration.

let sharedIndex = null

onLoaded(async () => {
    const db = useDatabase()
    if (!db) {
        throw new Error('refs requires the database; useDatabase() returned null')
    }
    // Build the index once; createRefs receives the same instance so
    // the public surface (runtime.refs.*) and catalog.onPersist's
    // indexEntity calls share state.
    sharedIndex = createIndex(db)
    runtime.refs = createRefs(db, sharedIndex)
})

// Expose the index for catalog.js's onPersist hook so static refs can
// be maintained inside the same transaction as mikser_entities
// mutations. Returns null before onLoaded fires.
export function useRefsIndex() {
    return sharedIndex
}

// Resolve a ref to an entity using the same heuristic catalog.js's
// findRef uses (id / meta.href / id-minus-ext) via the shared
// `refFilter` builder in utils/. Exported so other callers can
// reuse the same matching rules.
export async function refExists(ref) {
    if (!ref || typeof ref !== 'string') return false
    const matches = await import('./catalog.js').then(({ findEntities }) => findEntities(refFilter(ref)))
    return matches.length > 0
}

// Build the writeEntity patch that swaps `from` → `to` in every `$`-keyed
// field listed in `fields`. Reads the entity's current canonical meta to
// figure out which fields carry a single ref vs an array, and constructs
// the right shape for each. Pure — no IO.
function buildRenamePatch(entity, fields, from, to) {
    const patch = {}
    for (const fieldPath of fields) {
        if (!isRefKey(fieldPath.split('.').pop())) continue
        const parts = fieldPath.split('.')
        applyNested(patch, parts, rewriteValueIn(entity.meta, parts, from, to), null)
    }
    return patch
}

function rewriteValueIn(meta, parts, from, to) {
    let node = meta
    for (const part of parts) {
        if (node == null) return undefined
        const idx = Number(part)
        if (!isNaN(idx) && Array.isArray(node)) {
            node = node[idx]
        } else {
            node = node?.[part]
        }
    }
    return rewriteValue(node, from, to)
}

function rewriteValue(value, from, to) {
    if (typeof value === 'string') return value === from ? to : value
    if (Array.isArray(value)) return value.map(v => rewriteValue(v, from, to))
    if (value && typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(value)) out[k] = rewriteValue(v, from, to)
        return out
    }
    return value
}

function applyNested(node, parts, value, _from) {
    let cursor = node
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]
        const idx = Number(part)
        const isArrayIndex = !isNaN(idx)
        if (isArrayIndex) {
            if (!Array.isArray(cursor[parts[i - 1]])) cursor[parts[i - 1]] = []
            cursor = cursor[idx] ??= {}
        } else {
            cursor = cursor[part] ??= {}
        }
    }
    cursor[parts[parts.length - 1]] = value
}

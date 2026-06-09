// Engine-level reverse-reference index. Maintains an in-memory inverse
// graph over the `$`-keyed references declared by entities in the
// catalog (per ADR-0007 A1). Rebuilt every cycle in onPersist (after
// catalog.js has applied this cycle's CREATE / UPDATE / DELETE entries),
// so plugins can rely on `runtime.refs.*` returning the post-mutation
// view of the graph.
//
// Two views over the same edges:
//
//   inbound :: Map<refValue, Map<sourceEntityId, fieldPath[]>>
//                "Which entities reference this href, and in which fields?"
//
//   outbound :: Map<sourceEntityId, Array<{ field, ref }>>
//                "Which refs does this entity emit, and in which fields?"
//
// Lookups in either direction are O(1) for the entity-list and
// O(edges-per-entity) for the field list.
//
// The index is NOT persisted. The catalog is the source of truth
// (ADR-0002); this is a derived projection that reconstructs from the
// catalog on every engine start. --clear / engine restart rebuilds it
// with no data loss because there's no data to lose.
//
// Lives in the engine (not as a plugin) per the analysis in ADR-0006's
// five-test: substrate (not domain), strategic (it operationalises
// ADR-0007 as a queryable graph), can't cleanly be a plugin without
// every consumer paying soft-dependency cost, plugins compose against
// `runtime.refs` independently, and the inverse-graph contract moves
// on engine cadence (file/refs schema, not external spec).

import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onInitialized, onPersist } from './lifecycle.js'
import { useJournal } from './journal.js'
import { OPERATION } from './constants.js'
import { extractRefs, isRefKey, writeEntity } from './utils.js'
import { findEntities, findEntity } from './catalog.js'

export function createIndex() {
    // Static edges — $-keyed refs from entity.meta (ADR-0007). Rebuilt
    // from the catalog every cycle in onPersist.
    /** @type {Map<string, Map<string, string[]>>} */
    const inbound = new Map()

    /** @type {Map<string, Array<{ field: string, ref: string }>>} */
    const outbound = new Map()

    // Dynamic edges — render-time dependencies (layout, partial, query)
    // populated by the engine after each successful render. Survive
    // rebuilds (which only clear static state); cleared per-source when
    // that source re-renders or gets deleted.
    /** @type {Map<string, Map<string, Set<string>>>} target → sourceId → Set<kind> */
    const dynamicInbound = new Map()

    /** @type {Map<string, Array<{ kind: string, target: string }>>} sourceId → edges */
    const dynamicOutbound = new Map()

    function clear() {
        inbound.clear()
        outbound.clear()
    }

    function add(sourceId, field, ref) {
        if (!inbound.has(ref)) inbound.set(ref, new Map())
        const fieldsByEntity = inbound.get(ref)
        if (!fieldsByEntity.has(sourceId)) fieldsByEntity.set(sourceId, [])
        fieldsByEntity.get(sourceId).push(field)

        if (!outbound.has(sourceId)) outbound.set(sourceId, [])
        outbound.get(sourceId).push({ field, ref })
    }

    function indexEntity(entity) {
        if (!entity?.id || !entity.meta) return
        for (const { path, ref } of extractRefs(entity.meta)) {
            add(entity.id, path, ref)
        }
    }

    function rebuild(entities) {
        // Clear ONLY static state. Dynamic edges (render-time deps)
        // are managed per-source by the engine and outlive a rebuild.
        clear()
        for (const entity of entities) indexEntity(entity)
    }

    function inboundFor(ref) {
        const fieldsByEntity = inbound.get(ref)
        if (!fieldsByEntity) return []
        const out = []
        for (const [id, fields] of fieldsByEntity.entries()) {
            for (const field of fields) out.push({ id, field })
        }
        return out
    }

    function outboundFor(sourceId) {
        return outbound.get(sourceId)?.slice() ?? []
    }

    function allRefs() {
        return [...inbound.keys()]
    }

    // Replace the dynamic outbound edges from `sourceId` with `edges`,
    // updating the inverse index atomically. Called by the engine after
    // each successful render — edges represent everything the render
    // read (the auto-added layout edge + whatever the renderer reported
    // via the track API). Passing an empty array clears the source.
    function replaceDynamic(sourceId, edges) {
        // Remove the source from the inverse map of its previous targets.
        const previous = dynamicOutbound.get(sourceId)
        if (previous) {
            for (const { target } of previous) {
                const inMap = dynamicInbound.get(target)
                if (inMap) {
                    inMap.delete(sourceId)
                    if (inMap.size === 0) dynamicInbound.delete(target)
                }
            }
        }
        if (!edges || edges.length === 0) {
            dynamicOutbound.delete(sourceId)
            return
        }
        dynamicOutbound.set(sourceId, edges.slice())
        for (const { target, kind } of edges) {
            if (!dynamicInbound.has(target)) dynamicInbound.set(target, new Map())
            const inMap = dynamicInbound.get(target)
            if (!inMap.has(sourceId)) inMap.set(sourceId, new Set())
            inMap.get(sourceId).add(kind)
        }
    }

    function clearDynamic(sourceId) {
        replaceDynamic(sourceId, [])
    }

    function dynamicOutboundFor(sourceId) {
        return dynamicOutbound.get(sourceId)?.slice() ?? []
    }

    function dynamicInboundFor(target) {
        const inMap = dynamicInbound.get(target)
        if (!inMap) return []
        const out = []
        for (const [id, kinds] of inMap) {
            for (const kind of kinds) out.push({ id, kind })
        }
        return out
    }

    function size() {
        let edges = 0
        for (const fields of inbound.values()) {
            for (const list of fields.values()) edges += list.length
        }
        let dynamicEdges = 0
        for (const list of dynamicOutbound.values()) dynamicEdges += list.length
        return {
            refs:     inbound.size,
            sources:  outbound.size,
            edges,
            dynamicSources: dynamicOutbound.size,
            dynamicEdges,
        }
    }

    return {
        rebuild,
        indexEntity,
        inboundFor,
        outboundFor,
        allRefs,
        size,
        clear,
        replaceDynamic,
        clearDynamic,
        dynamicOutboundFor,
        dynamicInboundFor,
    }
}

// Graph subscriptions. A subscriber registers `{filter, expand, onAffected}`
// and gets called every cycle for each (root, mutatedEntity) pair where:
//   - `root` is an entity matching `filter`
//   - the cycle's mutation chain ends at a node within `expand`-depth of `root`
//
// Implementation: at end of each cycle, walk the inverse-ref graph from
// each mutated entity up to `maxDepth(expand)` hops. At every visited
// node, evaluate each subscriber's filter; on match, dispatch.
//
// The api plugin's live-expand and per-query cache invalidation both
// drive their behaviour through this primitive.
//
// `getEntityById` is injected so tests can run the subscribe/dispatch
// machinery without a full runtime/catalog harness. In production it's
// wired to `runtime.catalog.chain.get('entities').find({id}).value()`
// via createRefs() below.
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

    // Compute max path length across an expand spec. Each path is a
    // dotted string; `*` segments don't reduce or extend the count.
    function maxDepthOf(expand) {
        if (!Array.isArray(expand) || expand.length === 0) return 0
        let max = 0
        for (const path of expand) {
            const n = typeof path === 'string' ? path.split('.').length : 0
            if (n > max) max = n
        }
        return max
    }

    // BFS backwards through the inverse index from a starting entity,
    // up to `depth` hops. Returns a Map<entityId, hopsFromStart> —
    // entities at depth 0 (the start itself), 1 (direct referrers), 2
    // (referrers of referrers), and so on, up to `depth`. Cycles in
    // the inverse graph break naturally because `visited` is consulted
    // before re-entering.
    //
    // The per-entity depth is what lets the dispatch loop honour each
    // subscriber's own max-depth — a subscriber with `expand: ['a']`
    // only sees entities within hop 1, even when a deeper subscriber
    // forced the BFS to go further.
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
        // Look up by every form the source might have used to write a
        // ref to this entity — id, meta.href, stripped-extension id —
        // since the index keys are author-written values that may use
        // any of those shapes.
        const seenIds = new Set()
        const refs = [
            entity.id,
            entity.meta?.href,
            typeof entity.id === 'string' ? entity.id.replace(/\.[^./]+$/, '') : null,
        ].filter(v => typeof v === 'string')

        const out = []
        for (const ref of refs) {
            for (const { id } of index.inboundFor(ref)) {
                if (seenIds.has(id)) continue
                seenIds.add(id)
                const referrer = getEntityById(id)
                if (referrer) out.push(referrer)
            }
        }
        return out
    }

    // Dispatch this cycle's mutations to all relevant subscribers.
    // For each mutated entity E:
    //   1. Walk inverse from E up to the MAX expand depth across all
    //      subscribers — one BFS per mutation, not per subscriber.
    //   2. Track the per-entity hop-count from E (via inverseReach's
    //      returned Map).
    //   3. For each visited entity, fire subscribers whose own max
    //      expand depth >= the hop-count AND whose filter matches.
    //
    // The per-entity hop check is what stops a subscriber with
    // `expand: ['a']` from firing when the visited entity was reached
    // at hop 2 (only because another subscriber needed depth 2).
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
                        // Logger may not be initialised in unit-test
                        // contexts; failures from the helper itself are
                        // not the subscriber's problem.
                        try {
                            useLogger().warn('runtime.refs subscriber threw: %s', err.message)
                        } catch { /* no logger — silent */ }
                    }
                }
            }
        }
    }

    return { add, dispatch, _subscribers: subscribers, _inverseReach: inverseReach }
}

// Build the public `runtime.refs.*` surface. Tests and direct callers
// use this factory; the engine wires it in via the lifecycle hooks
// registered at module level below.
export function createRefs() {
    const index = createIndex()
    // Catalog lookup is injected so the subscribers can be tested
    // without a runtime. In production the wired lookup is synchronous
    // against the in-memory lowdb chain.
    const getEntityById = (id) =>
        runtime.catalog?.chain.get('entities').find({ id }).value()
    const subscribers = createSubscribers(index, getEntityById)

    return {
        // Index queries (synchronous; backed by in-memory Maps).
        // Existing API returns $-ref edges only — kind='ref' implicit.
        inboundFor:  (ref) => index.inboundFor(ref),
        outboundFor: (id)  => index.outboundFor(id),
        allRefs:     ()    => index.allRefs(),
        size:        ()    => index.size(),

        // Dynamic (render-time) edge queries — populated by the engine
        // after each render via the track API. Returns `{kind, target}`
        // tuples (outbound) or `{id, kind}` tuples (inbound). kind is
        // one of 'layout', 'partial', 'query'.
        dynamicOutboundFor: (id)     => index.dynamicOutboundFor(id),
        dynamicInboundFor:  (target) => index.dynamicInboundFor(target),

        // Replace an entity's dynamic outbound edges. Called by the
        // engine after a successful render — the edges list comes from
        // the track payload (auto layout edge + reported partials/queries).
        // Passing an empty array clears all dynamic edges from this source.
        replaceDynamic: (sourceId, edges) => index.replaceDynamic(sourceId, edges),
        clearDynamic:   (sourceId)        => index.clearDynamic(sourceId),

        // Internal — for the engine's onPersist hook.
        _rebuildFrom: (entities) => index.rebuild(entities),
        _dispatch:    (mutations) => subscribers.dispatch(mutations),

        // Public subscribe API per ADR-0007 B9 / live-expand design.
        //
        // Register interest in graph changes affecting a filter-matching
        // set of roots and their expansion graphs. The callback fires
        // ONCE per (root, mutated) pair affected by this cycle, with
        // `root` being the entity matching the filter and `mutated`
        // being the entity whose change triggered the affected status.
        //
        //   const sub = runtime.refs.subscribeGraph({
        //       filter: e => e.id === '/blog/launch.md',
        //       expand: ['author.organization', 'hero'],
        //       onAffected: ({ root, mutated }) => { ... },
        //       signal,                          // optional AbortSignal
        //   })
        //   sub.dispose()                        // explicit teardown
        //
        // Returns { dispose }. If `signal` is provided, abort also
        // disposes (with no need to call dispose explicitly).
        subscribeGraph(opts = {}) {
            const { filter, expand = [], onAffected, signal } = opts
            if (typeof filter !== 'function') {
                throw new Error('runtime.refs.subscribeGraph: filter must be a function')
            }
            if (typeof onAffected !== 'function') {
                throw new Error('runtime.refs.subscribeGraph: onAffected must be a function')
            }
            return subscribers.add({ filter, expand, onAffected, signal })
        },

        // Atomic rename cascade. Walks the inverse index for `from`,
        // opens each referencing source file, rewrites the `$`-keyed
        // value via writeEntity. Watcher resyncs on the next cycle.
        //
        //   await runtime.refs.rename({
        //       from: '/authors/dick',
        //       to:   '/authors/dick-marinov',
        //   })
        //   // → { updated: [{id, fields}], failures: [{id, error}] }
        //
        // Idempotent: second call with the same args returns empty
        // updated because the first call drained the inbound list.
        async rename({ from, to } = {}) {
            if (!from || !to) {
                throw new Error('runtime.refs.rename: both `from` and `to` are required')
            }
            if (from === to) return { from, to, updated: [], failures: [] }

            const entries = index.inboundFor(from)
            if (entries.length === 0) {
                return { from, to, updated: [], failures: [] }
            }

            // Group field updates by entity id so writeEntity is called
            // once per file even when an entity references `from` from
            // multiple fields.
            const byEntity = new Map() // id → fields[]
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

            return { from, to, updated, failures }
        },
    }
}

// Wire to the lifecycle. catalog.js registers onPersist (writes journal
// mutations into the catalog) and onFinalized (catalog.write). We
// register AFTER catalog by virtue of being imported later (engine.js
// imports catalog first, then refs). The persist phase runs both
// hooks; ours runs after catalog's, so by the time we rebuild the
// index, the catalog reflects this cycle's mutations.

onInitialized(async () => {
    runtime.refs = createRefs()
})

onPersist(async (signal) => {
    if (!runtime.refs) return
    // Collect this cycle's mutations (the same iteration catalog.js
    // uses, but observed at a separate journal cursor — useJournal
    // is a fresh generator per call).
    const mutations = []
    for await (let { operation, entity } of useJournal(
        'Refs index',
        [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
        signal,
    )) {
        if (operation === OPERATION.DELETE) {
            // Mutations array carries the entity-as-deleted (just id /
            // collection / type). Subscribers receive this as `mutated`
            // for "the thing that went away" — they decide whether to
            // act.
            mutations.push(entity)
            // Drop the deleted entity's dynamic (render-time) edges so
            // a future entity reusing the same id doesn't inherit stale
            // partial/layout deps.
            if (entity?.id) runtime.refs.clearDynamic(entity.id)
        } else {
            mutations.push(entity)
        }
    }

    // Rebuild the static (catalog-derived) part of the index from the
    // post-mutation catalog. Cheap (O(n) walk over in-memory Maps);
    // future versions can incrementalize if profiling demands it.
    // Dynamic edges (render-time partial/layout deps) are preserved
    // across rebuilds — they're owned by the engine, refreshed per
    // entity at render time.
    const entities = await findEntities()
    runtime.refs._rebuildFrom(entities)

    // Dispatch subscribers AFTER the rebuild so any inverse-walk uses
    // the post-mutation graph. (A subscriber asking "who references
    // this?" should see the world as it is after this cycle's writes.)
    await runtime.refs._dispatch(mutations)
})

// Resolve a ref to an entity using the same heuristic catalog.js's
// findRef uses (id / meta.href / id-minus-ext). Exported so other
// callers can reuse the same matching rules.
// TODO: the heuristic is duplicated here and in catalog.js — single
// source of truth would put it in utils.js as a shared predicate.
export async function refExists(ref) {
    if (!ref || typeof ref !== 'string') return false
    const matches = await findEntities(e =>
        !!e && (
            e.id === ref ||
            e.meta?.href === ref ||
            (typeof e.id === 'string' && e.id.replace(/\.[^./]+$/, '') === ref)
        ),
    )
    return matches.length > 0
}

// Build the writeEntity patch that swaps `from` → `to` in every `$`-keyed
// field listed in `fields`. Reads the entity's current canonical meta to
// figure out which fields carry a single ref vs an array, and constructs
// the right shape for each. Pure — no IO.
function buildRenamePatch(entity, fields, from, to) {
    const patch = {}
    for (const fieldPath of fields) {
        const parts = fieldPath.split('.')
        const topKey = parts[0]
        if (!Object.prototype.hasOwnProperty.call(entity.meta ?? {}, topKey)) continue

        if (parts.length === 1) {
            const value = entity.meta[topKey]
            patch[topKey] = rewriteValue(value, from, to)
        } else {
            const cloned = structuredClone(entity.meta[topKey])
            applyNested(cloned, parts.slice(1), from, to)
            patch[topKey] = cloned
        }
    }
    return patch
}

function rewriteValue(value, from, to) {
    if (typeof value === 'string') return value === from ? to : value
    if (Array.isArray(value)) return value.map(v => (v === from ? to : v))
    return value
}

function applyNested(node, parts, from, to) {
    if (parts.length === 0) return
    const [head, ...tail] = parts

    if (Array.isArray(node)) {
        const i = Number(head)
        if (Number.isFinite(i) && i in node) {
            if (tail.length === 0) {
                if (node[i] === from) node[i] = to
            } else {
                applyNested(node[i], tail, from, to)
            }
        }
        return
    }

    if (node === null || typeof node !== 'object') return
    if (!Object.prototype.hasOwnProperty.call(node, head)) return

    if (tail.length === 0) {
        node[head] = rewriteValue(node[head], from, to)
    } else {
        applyNested(node[head], tail, from, to)
    }
}

// Render-time dependency tracker. Used by the engine's onRender to
// collect a per-render set of partials and queries that the renderer
// (and any code reachable from its async stack) consumed, so the
// manifest can persist a precise refClosure for incremental skip
// decisions. Also used by the layouts plugin's sidecar `load()` path
// for the same purpose at a different lifecycle phase.
//
// A track is *just* a small structured collector — no engine state, no
// lifecycle hooks, no IO. It's plumbed through `queryContext` so
// catalog query methods report into it automatically; the renderer
// plugins call `track.partial(id)` directly from their partial-loading
// hooks (handlebars AST walk, eta's wrapped render(), liquid's
// wrapped _parsePartialFile).

// Normalize a filter for cache/snapshot storage. Object filters are
// serializable and re-runnable via sift; function filters and
// primitives collapse to a `null` sentinel that forces conservative
// invalidation (any mutation re-renders) instead of silently losing
// the dep.
export function normalizeFilter(filter) {
    if (filter && typeof filter === 'object' && !Array.isArray(filter)) return filter
    return null
}

// Stable string key for a (possibly null) filter, used by the dedupe
// Sets inside tracks and inside manifest's buildRefClosure. The
// `__null__` sentinel distinguishes the unserializable case from a
// missing filter so dedup is correct in both directions.
export function filterKey(filter) {
    return filter === null ? '__null__' : JSON.stringify(filter)
}

// Factory for the track object passed through queryContext. The two
// `opts` toggles let callers carve out exactly the slot they need:
// engine's per-render track collects both partials and queries; the
// layouts plugin's sidecar track is query-only (sidecars don't load
// partials themselves). Disabled methods are simply absent — caller
// patterns like `track?.partial(id)` continue to work.
//
// The returned object exposes `partials: Set<string>` and
// `queries: Array<filter | null>` directly. Consumers iterate either
// shape; both are owned by the track for the lifetime of the run.
export function createTrack({ partial = true, query = true, lookup = true, meta = false, consumed = false, assets = true } = {}) {
    const track = {}
    if (lookup) {
        // Lookups a TEMPLATE made by name: runtime.href('/contacts'),
        // runtime.lookupUrl('/media/clip.mp4'). Both read the catalog
        // directly, so without recording them nothing knows that a page
        // depends on the page it links to — rename the target and only the
        // target re-renders, leaving every link to it pointing at a file
        // that no longer exists, on a green build.
        //
        // The edge kind is 'lookup', NOT 'ref'. mikser_refs divides
        // ownership by kind: indexEntity owns kind='ref' (static
        // frontmatter $-refs) and clears it per source, replaceDynamic owns
        // everything else. A render-time edge written as 'ref' is inserted
        // by replaceDynamic and then wiped by the next indexEntity, so it
        // lands in the manifest, never in the refs index, and schedules
        // nothing.
        //
        // Records BOTH the string asked for and what it resolved to.
        // The string alone cannot survive the target renaming itself;
        // the resolved id alone cannot express a link to a page that
        // does not exist yet. mikser_refs keeps both columns for the
        // same reason, and the two invalidation directions read one
        // each.
        //
        // A name can resolve to several entities — language variants
        // share a meta.href — so the value is a Set of ids, empty when
        // the lookup found nothing.
        const lookups = new Map()
        track.lookups = lookups
        track.lookup = (target, resolvedIds) => {
            if (!target || typeof target !== 'string') return
            let ids = lookups.get(target)
            if (!ids) lookups.set(target, ids = new Set())
            for (const id of Array.isArray(resolvedIds) ? resolvedIds : resolvedIds ? [resolvedIds] : []) {
                if (id && typeof id === 'string') ids.add(id)
            }
        }
    }
    if (partial) {
        const partials = new Set()
        track.partials = partials
        track.partial = (target) => { if (target) partials.add(target) }
    }
    if (meta) {
        // Which keys of the entity's own meta the render actually READ.
        //
        // Not an edge, and deliberately kept out of the refClosure: these are
        // property paths on the entity itself, not references to other
        // entities, and inserting them into mikser_refs would put noise in the
        // invalidation graph.
        //
        // The point is what static parsing structurally cannot see. A layout's
        // contract is assembled by walking templates, but a sidecar reads meta
        // in plain JavaScript — `row.meta?.hero?.tags` — and no parser for any
        // engine will ever find that. Observing the read is the only way.
        const metaReads = new Set()
        track.metaReads = metaReads
        track.metaRead = (path) => { if (path) metaReads.add(path) }
    }
    if (consumed) {
        // Which fields of OTHER entities this render read.
        //
        // `metaReads` covers the entity being rendered. This covers the ones it
        // pulled in — a page reads a navigation document through a query and
        // then takes `items[].label` off it, and until now nothing recorded
        // that. The consequence is that a document which never renders had no
        // derivable contract at all: the engine knew THAT a page queried it,
        // never which of its keys mattered.
        //
        // Keyed by the consumed entity's id, because the answer is per-entity:
        // "what does anything read from navigation.yml" is the question, and it
        // is asked from the other side.
        const consumedReads = new Map()
        track.consumedReads = consumedReads
        track.consumedRead = (id, path) => {
            if (!id || !path) return
            let paths = consumedReads.get(id)
            if (!paths) consumedReads.set(id, paths = new Set())
            paths.add(path)
        }
    }
    if (assets) {
        // Files a template asked for by URL: a preset derivative, a resource
        // from a library. Recorded so the engine can check at the end of the
        // cycle whether the thing being linked to is actually in the output.
        //
        // The helpers BUILD these paths — nothing they return has been checked
        // against a file — so a preset that never ran, or one whose format
        // changed, produces a perfectly well-formed link to nothing. The page
        // renders, the build is green, and the image is missing until a person
        // notices.
        //
        // The output-relative destination, not the page-relative url the
        // helper returns: `../../assets/web/hero.webp` cannot be resolved
        // without knowing which page asked, and this is the form that maps
        // straight onto a path under the output folder.
        const assetRefs = new Set()
        track.assets = assetRefs
        track.asset = (destination) => { if (destination) assetRefs.add(destination) }
    }

    if (query) {
        const queries = []
        const queryKeys = new Set()
        track.queries = queries
        track.query = (filter) => {
            const normalized = normalizeFilter(filter)
            const key = filterKey(normalized)
            if (queryKeys.has(key)) return
            queryKeys.add(key)
            queries.push(normalized)
        }
    }
    return track
}

// How a recording view identifies itself and hands back what it wraps.
//
// A Proxy is viral in a way plain data is not: it survives every assignment and
// spread, and then reaches an API that works on internal slots and cannot cope.
// `structuredClone` is the one that matters here — it rejects ANY proxy, because
// a proxy exotic object has no internal slots to copy — and mikser clones
// entities in expandEntity() to avoid mutating the caller's catalog row.
//
// So a view has to be undoable. Reading this symbol returns the raw target plus
// what is needed to re-apply the view afterwards, which keeps both properties in
// tension: the clone is taken from untouched data, and the result can be wrapped
// again so later reads are still recorded.
const READS = Symbol.for('mikser.recordReads')

// The raw object behind a recording view, or null when `value` is not one.
export function trackedInfo(value) {
    if (value === null || typeof value !== 'object') return null
    return value[READS] ?? null
}

// `value` with every recording view in it replaced by what it wraps.
//
// Returns the SAME reference when nothing was wrapped, so the common case costs
// a walk and no allocation. Unwrapping deliberately does not go through the get
// trap: reading every key to copy it would record every key as read, and a
// contract that says a layout consumes everything is worth nothing — worse, the
// build would then invalidate on any change at all.
export function untrack(value) {
    const info = trackedInfo(value)
    // The target's own contents are raw: views are created lazily on access and
    // never written back, so unwrapping the outermost one is enough.
    if (info) return info.target
    if (Array.isArray(value)) {
        let changed = false
        const out = value.map(v => { const u = untrack(v); if (u !== v) changed = true; return u })
        return changed ? out : value
    }
    if (value && typeof value === 'object' && (value.constructor === Object || !value.constructor)) {
        let changed = false
        const out = {}
        for (const [k, v] of Object.entries(value)) {
            const u = untrack(v)
            if (u !== v) changed = true
            out[k] = u
        }
        return changed ? out : value
    }
    return value
}

// Property paths that say nothing about the data. Reading `.length` to
// iterate, or `.toJSON` because something serialized, is not a template
// depending on a key — recording them would bury the real ones.
const UNINTERESTING = new Set([
    'length', 'constructor', 'prototype', 'toJSON', 'toString', 'valueOf',
    'then', 'inspect', 'nodeType', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString',
])

// A read-recording view of a value.
//
// Every property access is reported as a dotted path and the result is wrapped
// again, so `data.meta.hero.tags` is recorded a segment at a time and deep
// reads are captured without knowing the shape in advance.
//
// Engine-agnostic by construction, which is the whole reason it is worth
// having: it never sees a template. Whatever reads the object is recorded —
// liquid, handlebars, eta, a sidecar's plain JavaScript, a helper — because
// they all reach the data through this one object.
//
// Array indices collapse to a single `[]` marker rather than `0`, `1`, `2`.
// The contract wants "each case has specs", not "case 7 has specs", and the
// static closure already speaks that vocabulary, so the two line up.
//
// Proxies are cached per underlying object so that identity holds within one
// render: code doing `a.b === a.b` keeps working, and a cyclic structure does
// not recurse forever.
export function recordReads(value, path, record, cache = new WeakMap()) {
    if (value === null || typeof value !== 'object') return value
    const hit = cache.get(value)
    if (hit) return hit

    const isArray = Array.isArray(value)
    const proxy = new Proxy(value, {
        get(target, prop, receiver) {
            // Answered before anything else, and never recorded: this is the
            // engine asking what it is holding, not a template reading content.
            if (prop === READS) return { target, path, record }
            const out = Reflect.get(target, prop, receiver)
            // Symbols are iteration and type-coercion machinery, never keys an
            // author writes.
            if (typeof prop === 'symbol' || UNINTERESTING.has(prop)) return out
            if (typeof out === 'function') return out
            // Only properties the object ACTUALLY HAS.
            //
            // Template engines probe for protocol members on every value they
            // touch — LiquidJS asks for `toLiquid`, iteration asks for `next` —
            // and recording those would put engine machinery in a document's
            // contract, differently per engine, which is exactly the coupling
            // this is supposed to avoid.
            //
            // Absent keys are not lost by this: a template naming a key the
            // document lacks is the STATIC closure's business, and it reports
            // it. This half answers the other question — what was actually
            // read — and a probe for a property that is not there read nothing.
            if (!Object.hasOwn(target, prop)) return out

            const isIndex = isArray && /^\d+$/.test(prop)
            const childPath = isIndex
                ? `${path}[]`
                : (path ? `${path}.${prop}` : String(prop))
            record(childPath)
            return recordReads(out, childPath, record, cache)
        },
        // Kept truthful so `in`, spread and Object.keys behave exactly as they
        // would without the proxy. A view that changed the answers would be a
        // worse bug than the blindness it is fixing.
        has(target, prop) { return Reflect.has(target, prop) },
        ownKeys(target) { return Reflect.ownKeys(target) },
        getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop) },
    })
    cache.set(value, proxy)
    return proxy
}

// A track's CONTENTS, as plain data that survives structured clone.
//
// A track is an object of closures, so it cannot be handed to a worker — which
// is why worker renders used to be dispatched without one and fell back to
// layout-only deps. The closures are what cannot cross; the collected data can.
// So the worker builds its own track and returns this on the way back.
//
// Deliberately NOT the logger pattern. The logger proxies each call over the
// IPC port because a log line arriving late costs nothing. Dependencies are
// different: `collectEdges` runs on the line after the render is awaited, and
// the port is a SEPARATE channel from the one carrying the result, so nothing
// orders the last message before the promise resolves. A dep that lost the race
// would be silently missing from a green build. Returning the data with the
// result is ordered by construction.
export function serializeTrack(track) {
    if (!track) return null
    return {
        partials:  track.partials  ? [...track.partials]  : undefined,
        queries:   track.queries   ? [...track.queries]   : undefined,
        metaReads: track.metaReads ? [...track.metaReads] : undefined,
        assets:    track.assets    ? [...track.assets]    : undefined,
        lookups:   track.lookups   ? [...track.lookups].map(([k, v]) => [k, [...v]]) : undefined,
        consumedReads: track.consumedReads
            ? [...track.consumedReads].map(([k, v]) => [k, [...v]]) : undefined,
    }
}

// Fold serialized contents back into a live track. Every slot is a set, so a
// merge is idempotent and an inline render folding its own data back into
// itself changes nothing.
export function mergeTrack(target, data) {
    if (!target || !data) return target
    for (const p of data.partials  ?? []) target.partial?.(p)
    for (const q of data.queries   ?? []) target.query?.(q)
    for (const m of data.metaReads ?? []) target.metaRead?.(m)
    for (const a of data.assets    ?? []) target.asset?.(a)
    for (const [name, ids] of data.lookups ?? []) target.lookup?.(name, ids)
    for (const [id, paths] of data.consumedReads ?? []) {
        for (const path of paths) target.consumedRead?.(id, path)
    }
    return target
}

// A queried entity, wrapped so what a render reads off it is recorded against
// THAT entity rather than the one being rendered.
//
// Only `meta` is wrapped: id, name and uri are how the caller identifies the
// row, not content, and recording them would bury the keys that matter. Returns
// the entity untouched when there is nothing to record into, so a call site can
// wrap unconditionally.
export function observeConsumed(entity, track) {
    if (!track?.consumedRead || !entity?.id || !entity.meta || typeof entity.meta !== 'object') return entity
    return { ...entity, meta: recordReads(entity.meta, '', (path) => track.consumedRead(entity.id, path)) }
}

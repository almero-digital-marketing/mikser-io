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
export function createTrack({ partial = true, query = true } = {}) {
    const track = {}
    if (partial) {
        const partials = new Set()
        track.partials = partials
        track.partial = (target) => { if (target) partials.add(target) }
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

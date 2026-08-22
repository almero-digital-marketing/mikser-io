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
export function createTrack({ partial = true, query = true, lookup = true } = {}) {
    const track = {}
    if (lookup) {
        // Lookups a TEMPLATE made by name: runtime.href('/contacts'),
        // runtime.lookupUrl('/media/clip.mp4'). Both read the catalog
        // directly, and until this existed neither told anyone — so nothing
        // recorded that a page depends on the page it links to.
        //
        // Measured consequence: rename contacts.md to contact-us.md and only
        // the renamed page re-renders. Every page linking to it keeps a href
        // pointing at a file that no longer exists, on a green build.
        //
        // The edge kind is 'lookup', NOT 'ref': mikser_refs divides ownership
        // by kind — indexEntity owns kind='ref' (static frontmatter $-refs)
        // and clears it per source, while replaceDynamic owns everything
        // else. Writing these as 'ref' got them inserted by replaceDynamic
        // and then wiped by the next indexEntity, so the edge existed in
        // the manifest and never in the refs index — recorded, and still
        // never scheduling a re-render.
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

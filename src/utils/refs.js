import path from 'path'

// Canonical lookup variants for an entity — the same four forms the
// schemas plugin, refs subscribers, and the catalog's findRef all use
// to resolve `$author: '/authors/jane'` against an entity at
// `/documents/authors/jane.yml` with `meta.href: '/authors/jane'`.
// Pure: synchronous, no I/O.
//
// MUST stay in lockstep with `refFilter` below, which is the forward
// direction of the same relation. A form present there and missing here
// makes every ref written in that form silently non-invalidating: the
// edge is recorded against the string the author wrote, and nothing the
// target expands to ever matches it. `meta.url` is the one to watch —
// a `$hero: /hero.txt` ref to a served path (ADR-0011) resolves through
// it, while the file entity's id is `/files/hero.txt`.
export function lookupKeys(entity) {
    const id = entity?.id
    if (!id) return []
    const keys = [id]
    if (entity.meta?.href) keys.push(entity.meta.href)
    if (entity.meta?.url) keys.push(entity.meta.url)
    if (typeof id === 'string') {
        const stripped = id.replace(/\.[^./]+$/, '')
        if (stripped !== id) keys.push(stripped)
    }
    return keys
}

// Predicate inverse of `lookupKeys`: does `entity` answer to `refValue`
// via any of the four canonical forms? Used by anywhere a per-entity
// JS test of "does this match the ref" is needed without going through
// the catalog (e.g. testing an in-hand entity).
//
// For *querying* the catalog by ref, use `refFilter(refValue)` and
// pass the result to `findEntities` / `findEntity` — that keeps the
// query as a structured sift filter that storage engines can index
// instead of forcing a full scan.
export function matchesRef(entity, refValue) {
    if (!entity || typeof refValue !== 'string') return false
    if (entity.id === refValue) return true
    if (entity.meta?.href === refValue) return true
    if (entity.meta?.url === refValue) return true
    if (typeof entity.id === 'string' && entity.id.replace(/\.[^./]+$/, '') === refValue) return true
    return false
}

// Structured sift filter equivalent of `matchesRef`. Matches an entity
// when its id, its meta.href, OR its id-minus-trailing-extension equals
// `refValue`. The third clause uses a regex anchored at `refValue` and
// matching exactly one trailing extension — the sift form of
// `id.replace(/\.[^./]+$/, '') === refValue`.
//
// Keep in lockstep with `matchesRef` above. If you change one, change
// both — tests cover the symmetry.
export function refFilter(refValue) {
    if (typeof refValue !== 'string') return { id: '__never__' }
    const escaped = refValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return {
        $or: [
            { id: refValue },
            { 'meta.href': refValue },
            // Served path (ADR-0011): a $-ref to a file/resource is the URL
            // content authors (`/img/x.jpg`, `/media/clip.mp4`), which is the
            // entity's meta.url — not its collection-prefixed id. Indexed.
            { 'meta.url': refValue },
            { id: { $regex: `^${escaped}\\.[^./]+$` } },
        ],
    }
}

// True when `key` is a reference marker per ADR-0007 — a string starting
// with `$` and at least one further character. Bare `$` is treated as a
// regular field name, not a marker, so existing meta that happens to use
// `$` as a key keeps working unchanged.
//
// Pure structural check — no semantic validation, no catalog lookup.
// Validation (does the ref resolve? does the target's layout match?) is
// the schemas plugin's job; see ADR-0007 A6 for the deferred-validation
// model.
export function isRefKey(key) {
    return typeof key === 'string' && key.length > 1 && key.charCodeAt(0) === 36
}

// Walk `meta` and return every reference declaration — any `$`-keyed field
// whose value is a string, or whose value is an array containing strings.
// `$`-keys with other value shapes (numbers, plain objects, etc.) are
// skipped here; the schemas plugin walks meta itself when it needs to
// surface shape warnings.
//
// Returns an array of { path, ref } where `path` is a dotted string
// locating the reference inside `meta` — for example `$author`,
// `seo.$ogImage`, or `sections.0.$image`. Indexes are used for array
// positions so the path uniquely identifies one ref site.
//
// Pure: does not consult the catalog. Resolution is the caller's job.
export function extractRefs(meta) {
    const refs = []
    walk(meta, '')
    return refs

    function walk(node, prefix) {
        if (node === null || typeof node !== 'object') return
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                walk(node[i], prefix ? `${prefix}.${i}` : String(i))
            }
            return
        }
        for (const [k, v] of Object.entries(node)) {
            const path = prefix ? `${prefix}.${k}` : k
            if (isRefKey(k)) {
                if (typeof v === 'string') {
                    refs.push({ path, ref: v })
                } else if (Array.isArray(v)) {
                    for (let i = 0; i < v.length; i++) {
                        if (typeof v[i] === 'string') {
                            refs.push({ path: `${path}.${i}`, ref: v[i] })
                        }
                    }
                }
                // Other shapes are invalid; the schemas plugin warns.
            } else {
                walk(v, path)
            }
        }
    }
}

import path from 'path'
import { recordReads, trackedInfo, untrack } from '../track.js'
import { projectMeta } from './entity.js'
import { isRefKey } from './refs.js'

// Expansion error — thrown by `expandEntity` when an `expand` request
// violates a structural cap (maxDepth, maxPaths, maxResolved). The
// `status` field is the HTTP code the api plugin returns. Per ADR-0007
// B6, missing targets and cycles do NOT throw; the ref string is left
// in place at the deepest position where resolution stopped.
export class ExpandError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ExpandError'
        this.status = 422
    }
}

// Inline-expand reference fields in `entity.meta` per ADR-0007 B1-B7.
// Each entry in `paths` is a dotted path that walks through meta. At
// `$`-keyed fields the ref string is replaced with the resolved entity
// (looked up via `options.findRef`); intermediate non-`$` fields are
// just navigation; `*` iterates arrays. Both canonical (`$author`) and
// normalized (`author`) path segments are accepted.
//
// Caps surface as ExpandError (status 422):
//   - maxDepth    — single-path length, default 5
//   - maxPaths    — number of entries in `paths`, default 20
//   - maxResolved — unique entity resolutions per call, default 100
//
// Missing targets and cycles do NOT throw — per ADR-0007 B6 the ref
// stays as a string at the deepest resolved position. Consumers see
// "string at expected expansion point" as the signal to re-fetch or
// surface a warning.
//
// Returns a deep clone of `entity` with expansions applied in canonical
// form (`$`-keys preserved on disk shape). The api layer applies
// `projectMeta` after to produce the normalized response.
export async function expandEntity(entity, paths, options = {}) {
    const {
        findRef,
        maxDepth = 5,
        maxPaths = 20,
        maxResolved = 100,
    } = options

    if (!Array.isArray(paths) || paths.length === 0) return entity
    if (paths.length > maxPaths) {
        throw new ExpandError(
            `expand has ${paths.length} paths, exceeds maxPaths (${maxPaths})`,
        )
    }
    if (typeof findRef !== 'function') {
        throw new Error('expandEntity: options.findRef is required')
    }

    // Deep clone so the caller's entity (typically the catalog row) is
    // never mutated. `structuredClone` is in Node since 17.
    //
    // Unwrapped first. A sidecar is handed a read-recording view of its
    // entity's meta so the engine can see which keys it consumes, and that view
    // is a Proxy — which structuredClone rejects outright, because it copies
    // internal slots and a proxy has none. Cloning the raw data instead keeps
    // both properties that are in tension here: the caller's entity is still
    // never mutated, and unwrapping reads nothing through the view, so no key
    // is recorded as consumed merely because it was copied.
    const tracked = trackedInfo(entity?.meta)
    const result = structuredClone(untrack(entity))
    if (!result?.meta || typeof result.meta !== 'object') return result

    const ctx = {
        findRef,
        seen: new Set([entity?.id].filter(Boolean)),
        resolved: 0,
        max: maxResolved,
    }

    for (const pathStr of paths) {
        const parts = pathStr.split('.').filter(Boolean)
        if (parts.length === 0) continue
        if (parts.length > maxDepth) {
            throw new ExpandError(
                `Path '${pathStr}' has length ${parts.length}, exceeds maxDepth (${maxDepth})`,
            )
        }
        await walkExpandPath(result.meta, parts, ctx)
    }

    // Re-applied, so a sidecar reading from the EXPANDED copy is still
    // recorded. Without this the feature would quietly stop working for any
    // sidecar that expands refs — which is most of them — because the reads
    // that matter happen on what expandEntity returns, not on what it was
    // given.
    if (tracked && result?.meta && typeof result.meta === 'object') {
        result.meta = recordReads(result.meta, tracked.path, tracked.record)
    }
    return result
}

// Collect every `$`-ref site reachable under `node` by walking plain
// structure (objects + arrays). Stops AT ref keys — a ref's value is the
// next graph hop's concern, not descended here. Returns { container, key,
// value } so the caller can resolve and replace in place. Powers the `$`
// expand wildcard.
function collectRefSites(node, out = []) {
    if (node === null || typeof node !== 'object') return out
    if (Array.isArray(node)) {
        for (const item of node) collectRefSites(item, out)
        return out
    }
    for (const [k, v] of Object.entries(node)) {
        if (isRefKey(k)) out.push({ container: node, key: k, value: v })
        else collectRefSites(v, out)
    }
    return out
}

async function walkExpandPath(node, parts, ctx) {
    if (parts.length === 0) return
    if (node === null || typeof node !== 'object') return

    const [head, ...tail] = parts

    if (head === '*') {
        if (Array.isArray(node)) {
            for (const item of node) {
                await walkExpandPath(item, tail, ctx)
            }
        }
        return
    }

    // `$` wildcard: expand EVERY `$`-ref reachable by walking this node's
    // structure (recursively through plain objects/arrays), one graph hop
    // each. A tail applies to each resolved entity, so `$.$.$` walks the
    // resolved graph deeper. Structure-agnostic — the caller declares that
    // it wants refs resolved, not where they sit. Bounded by maxResolved
    // (and maxDepth caps the chain length); explicit, so the cost is visible
    // at the call site (ADR-0007).
    if (head === '$') {
        for (const site of collectRefSites(node)) {
            if (typeof site.value === 'string') {
                await expandSingleRef(site.container, site.key, site.value, tail, ctx)
            } else if (Array.isArray(site.value)) {
                await expandArrayRef(site.container, site.key, site.value, tail, ctx)
            }
        }
        return
    }

    // Accept both canonical (`$author`) and normalized (`author`) path
    // segments per ADR-0007 B3. If the caller used `$author`, look for
    // exactly that key; if they used `author`, prefer `$author` (the
    // canonical-on-disk form) and fall back to `author` only when the
    // entity stores it un-marked.
    const dollarKey = head.startsWith('$') ? head : `$${head}`
    const plainKey  = head.startsWith('$') ? head.slice(1) : head

    let key, value
    if (Object.prototype.hasOwnProperty.call(node, dollarKey)) {
        key = dollarKey; value = node[dollarKey]
    } else if (Object.prototype.hasOwnProperty.call(node, plainKey)) {
        key = plainKey; value = node[plainKey]
    } else {
        return // path doesn't exist on this branch — silently skip
    }

    const keyIsRef = key === dollarKey
        || (typeof key === 'string' && key.length > 1 && key.charCodeAt(0) === 36)

    if (keyIsRef) {
        if (typeof value === 'string') {
            await expandSingleRef(node, key, value, tail, ctx)
        } else if (Array.isArray(value)) {
            await expandArrayRef(node, key, value, tail, ctx)
        } else if (value && typeof value === 'object') {
            // Already-expanded entity (from an earlier path in this
            // request). Recurse into its meta if there's more to do.
            if (tail.length > 0 && value.meta) {
                await walkExpandPath(value.meta, tail, ctx)
            }
        }
        return
    }

    // Plain navigation field — descend if there's tail.
    if (tail.length > 0) {
        await walkExpandPath(value, tail, ctx)
    }
}

async function expandSingleRef(node, key, ref, tail, ctx) {
    if (ctx.seen.has(ref)) return                 // cycle — leave as string
    const resolved = await ctx.findRef(ref)
    if (!resolved) return                         // missing target — leave as string
    ctx.resolved++
    if (ctx.resolved > ctx.max) {
        throw new ExpandError(
            `Resolution count ${ctx.resolved} exceeds maxResolved (${ctx.max})`,
        )
    }
    // Clone the resolved entity before placing it in the result tree.
    // findRef typically returns a reference to the catalog row; without
    // the clone, subsequent expansions would mutate the catalog.
    const resolvedCopy = structuredClone(untrack(resolved))
    node[key] = resolvedCopy
    if (tail.length > 0 && resolvedCopy.meta) {
        const childCtx = { ...ctx, seen: new Set([...ctx.seen, ref]) }
        await walkExpandPath(resolvedCopy.meta, tail, childCtx)
        ctx.resolved = childCtx.resolved
    }
}

async function expandArrayRef(node, key, refs, tail, ctx) {
    const out = []
    for (const ref of refs) {
        if (typeof ref !== 'string') { out.push(ref); continue }
        if (ctx.seen.has(ref))       { out.push(ref); continue }
        const resolved = await ctx.findRef(ref)
        if (!resolved) { out.push(ref); continue }
        ctx.resolved++
        if (ctx.resolved > ctx.max) {
            throw new ExpandError(
                `Resolution count ${ctx.resolved} exceeds maxResolved (${ctx.max})`,
            )
        }
        // Clone — same reasoning as expandSingleRef.
        const resolvedCopy = structuredClone(untrack(resolved))
        if (tail.length > 0 && resolvedCopy.meta) {
            const childCtx = { ...ctx, seen: new Set([...ctx.seen, ref]) }
            await walkExpandPath(resolvedCopy.meta, tail, childCtx)
            ctx.resolved = childCtx.resolved
        }
        out.push(resolvedCopy)
    }
    node[key] = out
}

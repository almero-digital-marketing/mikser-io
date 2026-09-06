// Preview plugin — in-memory preview cache.
//
// Owns the "render an entity transiently and surface the bytes at a
// clickable URL" infrastructure. Three responsibilities:
//
//   1. An in-memory cache (Map<filename, { bytes, mime, expiresAt,
//      size, deps }>) with LRU eviction past a configurable byte cap.
//   2. An Express GET /preview/:filename route that serves cache entries.
//   3. Offers the cache surface as the `preview` service = { store,
//      get, stats, config } so other plugins (mikser-io-mcp's
//      mikser_preview_render tool, library-mode callers) can stash bytes
//      and retrieve them by URL without going through MCP.
//
// Optional per-entry deps: callers can pass `deps: [filter, ...]` to
// store(), where each filter is a sift expression matching the catalog
// queries the render consulted. On any catalog mutation that matches
// a stored filter, the preview is evicted ahead of its TTL. Without
// deps the entry expires on TTL only, preserving the previous behavior
// for callers that don't track query deps yet.
//
// Lives outside the api plugin because preview is not a REST catalog
// concern — it's a render-and-cache workflow whose lifetime is the
// process, not the catalog. Lives outside core because it's domain
// (a workflow), not transport substrate. Per ADR-0006: plugin.
//
// Composes independently: needs `runtime.options.app` (any Express
// app — engine-supplied or external). Without an app the cache still
// works programmatically for library-mode callers; the GET route just
// isn't mounted.

import sift from 'sift'
import { provideService } from '../services.js'

export function preview(options = {}) {
    return ({ runtime, onLoaded, onPersist, useJournal, useLogger, registerRoute, constants: { OPERATION } }) => {
    // Factory-scope cache. One per engine instance. Module-scope would
    // share across multiple engines in the same Node process, which is
    // a scenario mikser doesn't really support.
    const previews = new Map()   // filename → { bytes, mime, expiresAt, size, deps? }
    let bytesInUse = 0

    // Config knobs with sensible defaults.
    const config = () => ({
        maxBytes:    options.maxBytes    ?? (100 * 1024 * 1024),
        defaultTtl:  options.defaultTtl  ?? 600,
        ttlMin:      options.ttlMin      ?? 30,
        ttlMax:      options.ttlMax      ?? 3600,
        path:        options.path        ?? '/preview',
    })

    // Three primitives the rest of the plugin (and library-mode /
    // mcp-plugin callers) build on: store(), get(), stats(). All
    // operate against the closed-over `previews` Map and `bytesInUse`
    // counter.
    function store({ filename, bytes, mime, ttlMs, deps }) {
        const size = Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes)
        const cfg = config()
        // LRU evict until there's room. JS Map preserves insertion
        // order — `keys().next().value` is the oldest entry.
        while (bytesInUse + size > cfg.maxBytes && previews.size > 0) {
            const oldestKey = previews.keys().next().value
            const oldest = previews.get(oldestKey)
            bytesInUse -= oldest.size
            previews.delete(oldestKey)
        }
        // `deps` is an optional array of sift filters captured at
        // render time (typically via queryContext from catalog.js).
        // The onPersist hook below evicts entries whose any filter
        // matches a mutated entity. Null entries in deps (sentinels
        // for unserializable predicates) force conservative eviction
        // on any mutation.
        const entry = { bytes, mime, expiresAt: Date.now() + ttlMs, size }
        if (Array.isArray(deps) && deps.length) entry.deps = deps
        previews.set(filename, entry)
        bytesInUse += size
        return { filename, size, expiresAt: Date.now() + ttlMs }
    }

    function get(filename) {
        const entry = previews.get(filename)
        if (!entry) return null
        if (entry.expiresAt < Date.now()) {
            bytesInUse -= entry.size
            previews.delete(filename)
            return null
        }
        // Touch — move to tail for LRU recency.
        previews.delete(filename)
        previews.set(filename, entry)
        return entry
    }

    function stats() {
        return {
            count: previews.size,
            bytesInUse,
            maxBytes: config().maxBytes,
            utilization: bytesInUse / config().maxBytes,
        }
    }

    // Offer the cache surface as a service, so a plugin that wants it asks
    // core rather than reaching into runtime.options.preview. `config` is
    // part of the surface too — mikser-io-mcp's mikser_preview_render reads
    // it to derive URL paths + TTL clamps.
    //
    // Provided at factory-eval time, before any hook runs, so a consumer's
    // onLoad / onLoaded can already see it whatever the plugin order.
    provideService('preview', { store, get, stats, config }, { plugin: 'mikser-io' })

    // Per-cycle invalidation. For every preview entry that has `deps`,
    // walk this cycle's catalog mutations and evict the entry if any
    // dep filter matches any mutated entity. Mirrors the api plugin's
    // precise per-cache-file invalidation — same `sift(filter)(entity)`
    // check, same null-filter sentinel meaning "conservative, evict on
    // any mutation."
    //
    // Entries without deps are TTL-only (the previous behavior). New
    // callers wanting catalog-driven invalidation pass deps via
    // store({ ..., deps: [filter, ...] }) — typically populated via
    // queryContext capture in the rendering plugin.
    onPersist(async (signal) => {
        if (previews.size === 0) return
        const mutations = []
        for await (const { entity } of useJournal(
            'Preview cache invalidation',
            [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
            signal,
        )) {
            if (entity?.id) mutations.push(entity)
        }
        if (mutations.length === 0) return

        for (const [filename, entry] of previews) {
            if (!entry.deps?.length) continue
            const matched = entry.deps.some(filter =>
                // Null filter = unserializable predicate captured at
                // store time — conservative, evict on any mutation.
                !filter || mutations.some(m => sift(filter)(m))
            )
            if (!matched) continue
            bytesInUse -= entry.size
            previews.delete(filename)
        }
    })

    // HTTP route: served regardless of whether MCP is on, so previews
    // are also reachable from library-mode callers that stored bytes
    // via the preview service's store() directly.
    onLoaded(async () => {
        const logger = useLogger()
        const app = runtime.options.app
        if (!app) {
            // No HTTP app means previews can still be stored
            // programmatically but the URL won't be reachable. That's
            // a valid configuration for batch / one-shot uses; we
            // just don't mount the route.
            logger.debug('Preview plugin: no runtime.options.app — cache available, route not mounted')
            return
        }

        const cfg = config()
        const routePath = `${cfg.path.replace(/\/$/, '')}/:filename`
        app.get(routePath, (req, res) => {
            const entry = get(req.params.filename)
            if (!entry) {
                res.status(404).type('text/plain').send('Preview expired or not found')
                return
            }
            res.type(entry.mime).send(entry.bytes)
        })
        // Preview URLs are meant to be fetched (by a browser, an agent
        // following a returned link), so the route is public + non-
        // streaming. The /:filename segment is left off the logged URL —
        // it's filled at request time per preview.
        registerRoute({
            path:        cfg.path,
            plugin:      'preview',
            reachability: 'public',
            streaming:   false,
            label:       'Preview route',
            detail:      `(cache cap: ${Math.round(cfg.maxBytes / 1024 / 1024)} MB)`,
        })
    })

    return { name: 'preview', module: import.meta.url }
    }
}

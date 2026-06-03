// Preview plugin. Owns the "render an entity transiently and surface
// the bytes at a clickable URL" workflow. Three responsibilities:
//
//   1. An in-memory cache (Map<filename, { bytes, mime, expiresAt, size }>)
//      with LRU eviction past a configurable byte cap.
//   2. An Express GET /preview/:filename route that serves cache entries.
//   3. The mikser_preview MCP tool, registered on the substrate when
//      --mcp is active.
//
// Lives outside the api plugin because preview is not a REST catalog
// concern — it's a render-and-cache workflow whose lifetime is the
// process, not the catalog. Lives outside core because it's domain
// (a workflow), not transport substrate. Per ADR-0006: plugin.
//
// Composes independently: needs `runtime.options.app` (any Express
// app — engine-supplied or external) and `useRenderer` (a core helper).
// Does NOT need the api plugin. Loading just `preview` + `mcp` is
// a valid combination for AI-driven workflows that skip the REST API.
//
// Library-mode surface: this plugin exposes
//   runtime.options.preview = { store, get, stats }
// so any plugin or programmatic caller can stash bytes and get a URL
// back without going through MCP. The mikser_preview tool is a thin
// wrapper over this surface.

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { useRenderer } from '../api.js'
import { mimeForEntity } from './api.js'
import { whenMcpActive } from '../mcp.js'

export default ({
    runtime,
    onLoaded,
    useLogger,
}) => {
    // Factory-scope cache. One per engine instance. Module-scope would
    // share across multiple engines in the same Node process, which is
    // a scenario mikser doesn't really support.
    const previews = new Map()   // filename → { bytes, mime, expiresAt, size }
    let bytesInUse = 0

    // Config knobs with sensible defaults. The defaults match the
    // values 7.2.x shipped under the api plugin so existing callers
    // see no change in behavior — just a different plugin owner.
    const config = () => ({
        maxBytes:    runtime.config.preview?.maxBytes    ?? (100 * 1024 * 1024),
        defaultTtl:  runtime.config.preview?.defaultTtl  ?? 600,
        ttlMin:      runtime.config.preview?.ttlMin      ?? 30,
        ttlMax:      runtime.config.preview?.ttlMax      ?? 3600,
        path:        runtime.config.preview?.path        ?? '/preview',
    })

    // ---- cache primitives ------------------------------------------

    function store({ filename, bytes, mime, ttlMs }) {
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
        previews.set(filename, { bytes, mime, expiresAt: Date.now() + ttlMs, size })
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

    // Expose the cache surface at runtime.options.preview so other
    // plugins / library callers can use it without going through MCP.
    // Done at factory-eval time (before any onLoaded fires) so a
    // later plugin's onLoad / onLoaded can already see it.
    runtime.options.preview = { store, get, stats }

    // ---- HTTP route ------------------------------------------------

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
        logger.info('Preview route mounted: %s (cache cap: %d MB)', cfg.path, Math.round(cfg.maxBytes / 1024 / 1024))
    })

    // ---- MCP tool --------------------------------------------------

    whenMcpActive((mcp) => {
        const { render: previewRender } = useRenderer(runtime, {
            defaultTimeout: runtime.config.preview?.renderTimeout ?? 30_000,
        })

        mcp.simpleTool(
            'mikser_preview',
            'Render an entity through the engine pipeline AND surface the output as a clickable URL served by the running --server. Use this instead of mikser_render when the user needs to see the result in a browser. Requires --server. Previews live in memory (not on disk, never under outputFolder) and auto-expire — default 10 minutes, clamped 30..3600 seconds.',
            {
                entity:  z.record(z.any()).describe('Entity shape with at least { id, collection } and any meta/content the renderer needs. Same shape as mikser_render.'),
                options: z.record(z.any()).optional().describe('Renderer options. Same as mikser_render, plus { expiresInSeconds: number = 600 } controlling preview TTL.'),
            },
            async ({ entity = {}, options = {} }) => {
                const logger = useLogger()
                const ok = (data) => ({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
                })
                const fail = (msg) => ({
                    isError: true,
                    content: [{ type: 'text', text: msg }],
                })

                try {
                    if (!runtime.options.port) {
                        return fail('mikser_preview requires --server to be running so the preview URL is reachable. Use mikser_render to get raw bytes inline instead.')
                    }

                    const { expiresInSeconds = config().defaultTtl, ...renderOptions } = options ?? {}
                    const { output, entity: rendered } = await previewRender(entity, {
                        ...renderOptions,
                        save: false,
                        catalog: false,
                    })
                    const result = output?.result
                    if (result == null) {
                        return fail('Render produced no output. Check that the entity has a resolvable layout and the layout matched a registered renderer.')
                    }

                    const destExt = path.extname(rendered.destination || '').slice(1)
                    const ext = destExt || 'html'
                    const filename = `${randomUUID()}.${ext}`
                    const mime = mimeForEntity(rendered) ?? 'application/octet-stream'
                    const cfg = config()
                    const ttlSec = Math.max(cfg.ttlMin, Math.min(cfg.ttlMax, expiresInSeconds))

                    store({ filename, bytes: result, mime, ttlMs: ttlSec * 1000 })

                    const url = `http://localhost:${runtime.options.port}${cfg.path}/${filename}`
                    const bytes = Buffer.isBuffer(result) ? result.length : Buffer.byteLength(result)

                    logger.info('MCP mikser_preview cached %s (%d bytes, ttl %ds): %s', filename, bytes, ttlSec, url)

                    return ok({
                        previewUrl: url,
                        mimeType: mime,
                        bytes,
                        expiresInSeconds: ttlSec,
                        instructions: 'Open previewUrl in a browser to view. The preview lives in mikser memory and auto-expires after expiresInSeconds — re-run mikser_preview to refresh.',
                    })
                } catch (err) {
                    logger.error('MCP mikser_preview error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        const logger = useLogger()
        logger.info('MCP tool registered: mikser_preview (preview plugin)')
    })

    return { name: 'preview' }
}

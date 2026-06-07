// Preview plugin. Owns the "render an entity transiently and surface
// the bytes at a clickable URL" workflow. Three responsibilities:
//
//   1. An in-memory cache (Map<filename, { bytes, mime, expiresAt, size }>)
//      with LRU eviction past a configurable byte cap.
//   2. An Express GET /preview/:filename route that serves cache entries.
//   3. The mikser_preview_render MCP tool, registered on the substrate when
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
// back without going through MCP. The mikser_preview_render tool is a thin
// wrapper over this surface.

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { useRenderer } from '../api.js'
import { mimeForEntity, matchEntity } from '../utils.js'

export default ({
    runtime,
    onLoaded,
    useLogger,
    findEntity,
    findEntities,
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

    // Three primitives the rest of the plugin (and library-mode
    // callers) build on: store(), get(), stats(). All operate against
    // the closed-over `previews` Map and `bytesInUse` counter.
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

    // HTTP route: served regardless of whether MCP is on, so previews
    // are also reachable from library-mode callers that stored bytes
    // via runtime.options.preview.store() directly.
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
        // Full URL when port is known; bare path otherwise. The /:filename
        // segment is left off — it's filled at request time per preview.
        const location = runtime.options.port
            ? `http://localhost:${runtime.options.port}${cfg.path}`
            : cfg.path
        logger.info('Preview route mounted: %s (cache cap: %d MB)', location, Math.round(cfg.maxBytes / 1024 / 1024))
    })

    // Gating on runtime.options.mcp inside onLoaded matches the route-
    // mount pattern above. Same shape as `if (!app)`: check the flag
    // in the hook, register if present. No special wrapper needed.
    onLoaded(() => {
        if (!runtime.options.mcp) return
        const mcp = runtime.options.mcp
        const { render: previewRender } = useRenderer(runtime, {
            defaultTimeout: runtime.config.preview?.renderTimeout ?? 30_000,
        })

        mcp.simpleTool(
            'mikser_preview_render',
            'Render an entity through the engine pipeline AND surface the FINAL output as a clickable URL served by the running --server. Use this instead of mikser_api_render when the user needs to see the result in a browser. The URL serves the pipeline\'s final output — PDF for a `*.html-pdf.*` layout, MJML-derived HTML for `*.html-mjml.*`, etc. Requires --server. Previews live in memory (not on disk, never under outputFolder) and auto-expire — default 10 minutes, clamped 30..3600 seconds.',
            {
                entity:  z.record(z.any()).describe('Entity shape with at least { id, collection } and any meta/content the renderer needs. Same shape as mikser_api_render.'),
                options: z.record(z.any()).optional().describe('Renderer options. Same as mikser_api_render, plus { expiresInSeconds: number = 600 } controlling preview TTL.'),
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
                        return fail('mikser_preview_render requires --server to be running so the preview URL is reachable. Use mikser_api_render to get raw bytes inline instead.')
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

                    logger.debug('MCP mikser_preview_render cached %s (%d bytes, ttl %ds): %s', filename, bytes, ttlSec, url)

                    return ok({
                        previewUrl: url,
                        mimeType: mime,
                        bytes,
                        expiresInSeconds: ttlSec,
                        instructions: 'Open previewUrl in a browser to view. The preview lives in mikser memory and auto-expires after expiresInSeconds — re-run mikser_preview_render to refresh.',
                    })
                } catch (err) {
                    logger.error('MCP mikser_preview_render error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        const logger = useLogger()
        logger.debug('MCP tool registered: mikser_preview_render (preview plugin)')
    })

    // mikser_preview_ui — render an entity through a layout that declares
    // `mcpUi` frontmatter and return the HTML inline so the host can
    // surface it as a UI block in the agent conversation. Sibling of
    // mikser_preview_render: same render machinery, different delivery.
    //
    // Dispatch — match entity → layout — is driven entirely by data on
    // the layout entity itself:
    //   layout.meta.match         which entity pattern this UI serves
    //   layout.meta.mcpUi.mode    'preview' | 'edit' | 'approval' | ...
    //   layout.meta.mcpUi.actions postMessage actions the UI emits back
    //   layout.meta.mcpUi.sandbox sandbox flags the host should apply
    //
    // The plugin owns its own index (just a catalog filter at handler
    // time — small N, no need to materialize a registry). No other plugin
    // needs to know about mcpUi metadata; the catalog IS the shared
    // interface.
    onLoaded(() => {
        if (!runtime.options.mcp) return
        const mcp = runtime.options.mcp
        const { render: previewRender } = useRenderer(runtime, {
            defaultTimeout: runtime.config.preview?.renderTimeout ?? 30_000,
        })

        // Discovery resource. Read this BEFORE calling mikser_preview_ui
        // to learn which modes exist in the current project and which
        // entity patterns each one covers — saves a round of guess-and-
        // retry on mode names. Derived live from the catalog, so newly
        // added layouts show up without restarts or tool re-registration.
        mcp.registerResource(
            'mikser-mcp-ui-modes',
            'mikser://mcp-ui/modes',
            {
                title: 'MCP-UI modes available in this project',
                description: 'Live list of mcpUi modes and their candidate layouts, derived from layout frontmatter. Read this to discover what mikser_preview_ui can do before calling it.',
                mimeType: 'application/json',
            },
            async (uri) => {
                const all = await findEntities()
                const layouts = all.filter(l =>
                    l.collection === 'layouts' && l.meta?.mcpUi)
                const modes = {}
                for (const layout of layouts) {
                    const m = layout.meta.mcpUi
                    const mode = m.mode ?? 'preview'
                    if (!modes[mode]) modes[mode] = []
                    modes[mode].push({
                        layoutId:    layout.id,
                        match:       layout.meta.match ?? null,
                        description: m.description ?? null,
                        actions:     m.actions     ?? [],
                        sandbox:     m.sandbox     ?? ['allow-scripts'],
                    })
                }
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify({
                            modes,
                            totalLayouts: layouts.length,
                            notes: [
                                "Modes are derived from layout.meta.mcpUi.mode (defaults to 'preview' when omitted).",
                                'Each candidate has a `match` pattern. mikser_preview_ui matches your entityId against these patterns when you call it with that mode.',
                                'Layouts without `mcpUi` frontmatter are not listed here and not eligible for mikser_preview_ui.',
                            ],
                        }, null, 2),
                    }],
                }
            },
        )

        mcp.simpleTool(
            'mikser_preview_ui',
            'Render an entity to inline HTML using a layout that declares `mcpUi` frontmatter. Selects the layout by matching `entityId` against `layout.meta.match` and filtering on `mode`. Returns the rendered HTML plus action metadata (postMessage names the UI emits) so the host can surface it as a UI block in the conversation. **Read `mikser://mcp-ui/modes` first** to discover which modes and entity patterns this project supports — the resource is derived live from layout frontmatter. Layouts without `mcpUi` frontmatter are not eligible.',
            {
                entityId: z.string().describe('Entity to render, e.g. "/articles/2026-launch".'),
                mode: z.string().optional().describe('Which UI mode to render. Defaults to "preview". Available modes are whatever your layouts declare as `mcpUi.mode`.'),
            },
            async ({ entityId, mode = 'preview' }) => {
                const logger = useLogger()
                const fail = (msg) => ({
                    isError: true,
                    content: [{ type: 'text', text: msg }],
                })

                try {
                    // Find candidate layouts for this mode. The catalog
                    // already has frontmatter-parsed meta — front-matter
                    // plugin ran at onProcess. No re-parse needed.
                    const all = await findEntities()
                    const candidates = all.filter(l =>
                        l.collection === 'layouts'
                        && l.meta?.mcpUi
                        && (l.meta.mcpUi.mode ?? 'preview') === mode
                    )
                    if (candidates.length === 0) {
                        return fail(`No layouts found with mcpUi.mode="${mode}". Author a layout with YAML frontmatter at the top: \`---\\nmatch: "@/articles/*"\\nmcpUi:\\n  mode: ${mode}\\n  description: "..."\\n  actions: [...]\\n---\``)
                    }

                    const entity = await findEntity({ id: entityId })
                    if (!entity) return fail(`Entity not found: ${entityId}`)

                    const matched = candidates.find(l =>
                        l.meta?.match && matchEntity(entity, l.meta.match))
                    if (!matched) {
                        const patterns = candidates
                            .map(l => `  ${l.id}: match=${JSON.stringify(l.meta?.match ?? null)}`)
                            .join('\n')
                        return fail(`No mcpUi layout matched ${entityId} in mode=${mode}.\nCandidates for this mode:\n${patterns}`)
                    }

                    // Force the chosen layout — bypass autoLayouts /
                    // layouts.match resolution that onProcessed would do.
                    // Both `entity.layout` AND `entity.meta.layout` need
                    // to be set: the layouts plugin's onProcessed
                    // re-resolves entity.layout from entity.meta.layout
                    // on every cycle, and previewRender goes through
                    // the full lifecycle. Without overriding meta.layout
                    // the agent's `mcp-ui/post-approval` choice gets
                    // silently replaced by the production `post` layout.
                    const renderEntity = {
                        ...entity,
                        layout: matched,
                        meta: { ...(entity.meta || {}), layout: matched.name },
                    }
                    const { output } = await previewRender(renderEntity, {
                        save: false,
                        catalog: false,
                    })
                    const result = output?.result
                    if (result == null) {
                        return fail(`Render produced no output for ${entityId} via ${matched.id}. Check that the layout's template engine has a matching renderer plugin loaded.`)
                    }

                    const html = typeof result === 'string'
                        ? result
                        : Buffer.isBuffer(result)
                            ? result.toString('utf8')
                            : String(result)

                    const mcpUiMeta = matched.meta?.mcpUi ?? {}
                    logger.debug('MCP mikser_preview_ui rendered %s via %s (mode=%s, %d chars)',
                        entityId, matched.id, mode, html.length)

                    return {
                        content: [
                            // HTML inline. Hosts that understand the
                            // Apps extension can lift this into a
                            // sandboxed iframe; hosts that don't will
                            // surface it as text/preformatted.
                            { type: 'text', text: html, mimeType: 'text/html' },
                        ],
                        // Side-channel metadata so hosts that wire up
                        // postMessage back-channels know which actions
                        // the UI emits and which sandbox flags to apply.
                        _meta: {
                            mcpUi: {
                                layoutId:    matched.id,
                                mode,
                                description: mcpUiMeta.description ?? null,
                                actions:     mcpUiMeta.actions     ?? [],
                                sandbox:     mcpUiMeta.sandbox     ?? ['allow-scripts'],
                            },
                        },
                    }
                } catch (err) {
                    logger.error('MCP mikser_preview_ui error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        const logger = useLogger()
        logger.debug('MCP tool registered: mikser_preview_ui + mikser://mcp-ui/modes resource (preview plugin)')
    })

    return { name: 'preview' }
}

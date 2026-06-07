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
import { randomUUID, createHmac } from 'node:crypto'
import { z } from 'zod'
import { useRenderer } from '../api.js'
import { mimeForEntity, matchEntity } from '../utils.js'

// Forward an MCP-UI action to an external handler URL. Returns the
// handler's JSON response, which becomes the tool result. Throws on
// network error, non-2xx status, timeout, or invalid response shape —
// callers fall back to pure-relay on throw.
//
// HMAC signing: when handler.secret is set, we sign the request body
// with sha256(secret) and pass it in X-Mikser-Signature. Receivers
// MUST verify before processing. When secret is unset, no signature
// is sent (acceptable for dev; not recommended in production — see
// ADR-0008 §B2).
//
// Extracted as a standalone function so it can be unit-tested with a
// mock URL and so the endpoint handler's main path stays readable.
export async function forwardToHandler(handler, body) {
    const { url, secret, timeout = 5000 } = handler
    if (!url) throw new Error('forwardToHandler: handler.url is required')

    const json = JSON.stringify({
        ...body,
        // Timestamp is set inside the forward, not by the caller, so
        // a stale callback that came in via a slow network still has
        // a fresh timestamp on the outgoing forward. Receivers that
        // care can put their own.
        timestamp: new Date().toISOString(),
    })

    const headers = {
        'content-type':         'application/json',
        'x-mikser-layout-id':   body.layoutId   ?? '',
        'x-mikser-mode':        body.mode       ?? '',
        'x-mikser-request-id':  randomUUID(),
    }
    if (secret) {
        const sig = createHmac('sha256', secret).update(json).digest('hex')
        headers['x-mikser-signature'] = `sha256=${sig}`
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)

    let res
    try {
        res = await fetch(url, {
            method:  'POST',
            headers,
            body:    json,
            signal:  ac.signal,
        })
    } catch (err) {
        clearTimeout(timer)
        if (err.name === 'AbortError') {
            throw new Error(`Handler timeout (${timeout}ms) — ${url}`)
        }
        throw new Error(`Handler unreachable: ${err.message} — ${url}`)
    }
    clearTimeout(timer)

    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Handler ${res.status} ${res.statusText} — ${text.slice(0, 200)}`)
    }

    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
        return await res.json()
    }
    // Non-JSON response — wrap as a structured result so the agent
    // sees something meaningful. The handler is technically a-spec
    // here (Part B3 says return JSON), but we don't punish callers
    // for a casual `res.send('ok')` from the handler side.
    const text = await res.text()
    return { ok: true, handlerResponse: text }
}

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

    // Pending action map for awaitable mikser_preview_ui calls.
    // Key: callId; value: { resolve, reject, allowedActions, handler,
    //   layoutId, mode }. Populated when the tool suspends; drained
    // when the iframe POSTs the action (or the timeout fires).
    //
    // In-memory by design — ADR-0008 §A4 accepts that an engine
    // restart drops in-flight tool calls; the agent retries on error.
    const pendingMcpUiActions = new Map()

    // mikser_preview_ui — render an entity through a layout that declares
    // `mcpUi` frontmatter and suspend the tool call until the iframe POSTs
    // an action back. Per ADR-0008:
    //
    //   Part A — awaitable default. The tool resolves with { action,
    //            entityId, payload } once the user clicks something in
    //            the iframe. Pure relay; the agent owns semantics.
    //
    //   Part B — optional webhook. When the layout declares handler.url,
    //            the action POST is forwarded to that URL and its JSON
    //            response becomes the tool result. Lets external apps
    //            take ownership without mikser becoming a workflow engine.
    //
    // Dispatch — match entity → layout — is driven entirely by data on
    // the layout entity itself:
    //   layout.meta.match            which entity pattern this UI serves
    //   layout.meta.mcpUi.mode       'preview' | 'edit' | 'approval' | ...
    //   layout.meta.mcpUi.actions    action names the UI may emit
    //   layout.meta.mcpUi.sandbox    sandbox flags the host should apply
    //   layout.meta.mcpUi.handler    optional { url, secret, timeout }
    //                                — see ADR-0008 §B
    //
    // The plugin owns its own index (just a catalog filter at handler
    // time — small N, no need to materialize a registry). No other plugin
    // needs to know about mcpUi metadata; the catalog IS the shared
    // interface.
    onLoaded(async () => {
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

        // Mount the HTTP endpoint that receives action POSTs from
        // iframes. Per ADR-0008 §A2 this is the canonical delivery
        // path (postMessage stays as a best-effort optimization for
        // hosts that bridge it). Validation: callId must be in the
        // pending map; action must be in the layout's declared
        // actions list. Anything else returns 4xx without touching
        // the pending entry.
        const app = runtime.options.app
        if (app) {
            const express = (await import('express')).default
            app.post('/api/mcp-ui/action/:callId', express.json(), async (req, res) => {
                const { callId } = req.params
                const { action, entityId, payload = {} } = req.body || {}

                const pending = pendingMcpUiActions.get(callId)
                if (!pending) {
                    return res.status(404).json({
                        error: 'No pending MCP-UI action for that callId. The tool call may have already resolved, timed out, or never existed.',
                    })
                }
                if (typeof action !== 'string' || !pending.allowedActions.includes(action)) {
                    return res.status(400).json({
                        error: `Action "${action}" is not in the layout's allowed list.`,
                        allowed: pending.allowedActions,
                    })
                }

                // The callId is single-use. Remove from the map BEFORE
                // forwarding/resolving so a race between two POSTs
                // (e.g. user clicked twice) gets a clean 404 on the
                // second hit instead of double-resolving the promise.
                pendingMcpUiActions.delete(callId)

                if (pending.handler?.url) {
                    try {
                        const result = await forwardToHandler(pending.handler, {
                            callId,
                            entityId,
                            action,
                            payload,
                            layoutId: pending.layoutId,
                            mode:     pending.mode,
                        })
                        pending.resolve(result)
                        return res.json(result)
                    } catch (err) {
                        // Per ADR-0008 §B4 — handler failure falls back
                        // to pure relay with the error surfaced as a
                        // handlerError field. The user's click is never
                        // silently lost.
                        const logger = useLogger()
                        logger.warn('MCP-UI handler failed (%s): %s', pending.handler.url, err.message)
                        const fallback = { action, entityId, payload, handlerError: err.message }
                        pending.resolve(fallback)
                        return res.json(fallback)
                    }
                }

                // No handler — pure relay. Resolve the tool call with
                // the action data; the agent decides what it means.
                const result = { action, entityId, payload }
                pending.resolve(result)
                return res.json(result)
            })
            const logger = useLogger()
            logger.debug('MCP-UI action endpoint mounted: POST /api/mcp-ui/action/:callId')
        }

        mcp.simpleTool(
            'mikser_preview_ui',
            'Render an entity to inline HTML using a layout that declares `mcpUi` frontmatter and **suspend the tool call until the user clicks an action in the iframe** (or timeoutSeconds elapses). Selects the layout by matching `entityId` against `layout.meta.match` and filtering on `mode`. The resolved tool result has shape { action, entityId, payload } — or, when the layout declares a `handler.url` in its frontmatter, whatever JSON the handler returns (typically a summary + url for the agent to relay). Set `awaitAction: false` to return the HTML immediately without waiting, for hosts that prefer fire-and-forget display. **Read `mikser://mcp-ui/modes` first** to discover which modes and entity patterns this project supports.',
            {
                entityId: z.string().describe('Entity to render, e.g. "/articles/2026-launch".'),
                mode: z.string().optional().describe('Which UI mode to render. Defaults to "preview". Available modes are whatever your layouts declare as `mcpUi.mode`.'),
                awaitAction: z.boolean().optional().describe('When true (default), the tool call suspends until the iframe POSTs an action (or timeoutSeconds elapses). When false, returns the HTML immediately without waiting — for hosts that just want to display without interaction.'),
                timeoutSeconds: z.number().optional().describe('How long to wait for an action when awaitAction is true. Default 300 (5 minutes).'),
            },
            async ({ entityId, mode = 'preview', awaitAction = true, timeoutSeconds = 300 }) => {
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

                    // Mint a callId for this tool invocation. The iframe's
                    // script POSTs the action to /api/mcp-ui/action/<callId>;
                    // the endpoint resolves the pending promise registered
                    // below. The id also serves as auth — a POST with an
                    // unknown callId returns 404. See ADR-0008 §A1, B5 last
                    // bullet.
                    const callId = `mui_${randomUUID()}`

                    // Force the chosen layout — bypass autoLayouts /
                    // layouts.match resolution that onProcessed would do.
                    // Both `entity.layout` AND `entity.meta.layout` need
                    // to be set: the layouts plugin's onProcessed
                    // re-resolves entity.layout from entity.meta.layout
                    // on every cycle, and previewRender goes through
                    // the full lifecycle. Without overriding meta.layout
                    // the agent's `mcp-ui/post-approval` choice gets
                    // silently replaced by the production `post` layout.
                    //
                    // _mcpUi is injected so the layout's script can read
                    // callId and actionUrl via {{document.meta._mcpUi.…}}.
                    // The underscore-prefix is the engine-injected
                    // convention — layout authors don't write _mcpUi
                    // into their files; mikser provides it at render.
                    const mcpUiContext = {
                        callId,
                        actionUrl: `/api/mcp-ui/action/${callId}`,
                    }
                    const renderEntity = {
                        ...entity,
                        layout: matched,
                        meta: {
                            ...(entity.meta || {}),
                            layout: matched.name,
                            _mcpUi: mcpUiContext,
                        },
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
                    logger.debug('MCP mikser_preview_ui rendered %s via %s (mode=%s, %d chars, callId=%s)',
                        entityId, matched.id, mode, html.length, callId)

                    // Synchronous opt-out — return the HTML immediately
                    // without registering a pending action or waiting.
                    // Useful for hosts that just want to display the
                    // result and don't need the click round-trip.
                    if (!awaitAction) {
                        return {
                            content: [
                                { type: 'text', text: html, mimeType: 'text/html' },
                            ],
                            _meta: {
                                mcpUi: {
                                    layoutId:    matched.id,
                                    mode,
                                    callId,
                                    description: mcpUiMeta.description ?? null,
                                    actions:     mcpUiMeta.actions     ?? [],
                                    sandbox:     mcpUiMeta.sandbox     ?? ['allow-scripts'],
                                },
                            },
                        }
                    }

                    // Awaitable path — register the pending entry and
                    // suspend until the action POST arrives (or timeout).
                    // Resolve value is the tool result the agent sees:
                    //   - { action, entityId, payload } when no handler
                    //   - whatever the handler returned otherwise
                    //   - { …, handlerError } when handler is set but fails
                    const actionResult = await new Promise((resolve, reject) => {
                        pendingMcpUiActions.set(callId, {
                            resolve,
                            reject,
                            allowedActions: mcpUiMeta.actions ?? [],
                            handler:        mcpUiMeta.handler,
                            layoutId:       matched.id,
                            mode,
                        })
                        setTimeout(() => {
                            if (pendingMcpUiActions.delete(callId)) {
                                reject(new Error(`MCP-UI action timeout after ${timeoutSeconds}s — no click received for ${entityId} (mode=${mode}, callId=${callId})`))
                            }
                        }, timeoutSeconds * 1000)
                    })

                    logger.debug('MCP mikser_preview_ui action received for %s: %s',
                        callId, JSON.stringify(actionResult).slice(0, 200))

                    return {
                        content: [
                            // Action result as the primary text — the
                            // agent parses this to know what the user
                            // chose. The HTML has already been rendered
                            // to the host's iframe; we don't ship it
                            // back as part of the tool result.
                            { type: 'text', text: JSON.stringify(actionResult, null, 2) },
                        ],
                        _meta: {
                            mcpUi: {
                                layoutId: matched.id,
                                mode,
                                callId,
                                action:   actionResult.action ?? null,
                                handler:  Boolean(mcpUiMeta.handler?.url),
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

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
import { useRenderer } from '../render.js'
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
// ADR-0008).
//
// Extracted as a standalone function so it can be unit-tested with a
// mock URL and so mikser_ui_action's main path stays readable.
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
    // sees something meaningful. The handler is technically off-spec
    // here (ADR-0008 says return JSON), but we don't punish callers
    // for a casual `res.send('ok')` from the handler side.
    const text = await res.text()
    return { ok: true, handlerResponse: text }
}

// The MCP-UI shell HTML. Served as a single `ui://mikser/preview-ui-shell`
// resource that mikser_preview_ui's _meta.ui.resourceUri points at, per
// the MCP Apps spec (2026-01-26). Spec-conformant hosts fetch this once
// per call, load it in a sandboxed iframe, then push the tool's
// structuredContent via `ui/notifications/tool-result`.
//
// What the shell does:
//   - ui/initialize handshake with the host (timeouts at 2s)
//   - Listens for ui/notifications/tool-result → injects structuredContent.html
//     into #mikser-ui-root, re-executes any <script> tags the layout brought
//   - Exposes window.sendAction(action, payload) — the API layouts use to
//     deliver clicks back as `tools/call` against mikser_ui_action
//   - Logs every protocol event to an in-iframe debug panel so authors can
//     see exactly where the spec round-trip fails on hosts that don't bridge
//
// Why a shell at all: per spec, tool UIs are RESOURCES. The host fetches
// the resource (static) and receives the dynamic per-call data via the
// tool-result notification. Layouts can stay server-side-templated against
// the entity (mikser's strength) — they just produce *body content*, not
// full HTML documents. The shell handles the protocol; layouts handle the
// content. See ADR-0008.
const PREVIEW_UI_SHELL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>mikser · MCP-UI</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #1f2937; background: #ffffff; }
  #mikser-ui-root { padding: 0; }
  #mikser-debug {
    display: none;
    position: fixed;
    bottom: 0; left: 0; right: 0;
    max-height: 30vh;
    overflow: auto;
    padding: 0.5em 1em;
    border-top: 1px solid #d1d5db;
    background: #f9fafb;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #4b5563;
    z-index: 9999;
  }
  #mikser-debug.shown { display: block; }
  #mikser-debug strong { display: block; margin-bottom: 0.3em; color: #374151; font: 600 11px ui-sans-serif, system-ui; text-transform: uppercase; letter-spacing: 0.04em; }
  #mikser-debug ol { margin: 0; padding: 0; list-style: none; }
  #mikser-debug li { padding: 1px 0; }
  #mikser-debug li.ok { color: #047857; }
  #mikser-debug li.fail { color: #b91c1c; }
  #mikser-debug .t { color: #9ca3af; margin-right: 0.4em; }
</style>
</head>
<body>
  <div id="mikser-ui-root"></div>
  <div id="mikser-debug">
    <strong>mikser · MCP Apps protocol</strong>
    <ol id="mikser-debug-log"></ol>
  </div>
<script>
(function () {
  var nextId = 1, hostOrigin = '*';
  var pending = new Map();
  var debugLog = document.getElementById('mikser-debug-log');
  var debugPanel = document.getElementById('mikser-debug');
  var t0 = Date.now();
  var ctx = { entityId: null, layoutId: null };

  function log(msg, cls) {
    debugPanel.classList.add('shown');
    var li = document.createElement('li');
    if (cls) li.className = cls;
    var dt = ((Date.now() - t0) / 1000).toFixed(2);
    li.innerHTML = '<span class="t">+' + dt + 's</span>' + msg;
    debugLog.appendChild(li);
  }

  function rpc(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      log('→ ' + method + ' (id=' + id + ')');
      window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params, id: id }, hostOrigin);
      if (timeoutMs) {
        setTimeout(function () {
          if (!pending.has(id)) return;
          pending.delete(id);
          log('✗ ' + method + ' — no reply after ' + timeoutMs + 'ms', 'fail');
          reject(new Error(method + ' timeout (' + timeoutMs + 'ms — host did not reply)'));
        }, timeoutMs);
      }
    });
  }

  function injectContent(structured) {
    if (!structured) { log('tool-result had no structuredContent', 'fail'); return; }
    ctx.entityId = structured.entityId || null;
    ctx.layoutId = structured.layoutId || null;
    var root = document.getElementById('mikser-ui-root');
    root.innerHTML = structured.html || '';
    // innerHTML doesn't execute embedded <script> tags — re-create them.
    Array.prototype.forEach.call(root.querySelectorAll('script'), function (oldScript) {
      var newScript = document.createElement('script');
      Array.prototype.forEach.call(oldScript.attributes, function (a) {
        newScript.setAttribute(a.name, a.value);
      });
      newScript.textContent = oldScript.textContent;
      oldScript.parentNode.replaceChild(newScript, oldScript);
    });
    log('✓ content injected (' + (structured.html || '').length + ' bytes, entityId=' + JSON.stringify(ctx.entityId) + ')', 'ok');
  }

  window.addEventListener('message', function (e) {
    var data = e.data;
    if (data && typeof data.id !== 'undefined' && pending.has(data.id)) {
      var entry = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) entry.reject(data.error);
      else entry.resolve(data.result);
      return;
    }
    if (data && data.method === 'ui/notifications/tool-result') {
      log('← ui/notifications/tool-result');
      injectContent(data.params && data.params.structuredContent);
      return;
    }
  });

  // Public API. Layouts call this from button click handlers to deliver
  // an action back to mikser. Returns a Promise that resolves with
  // mikser_ui_action's tool result (pure relay or handler-forwarded).
  window.sendAction = function (action, payload) {
    payload = payload || {};
    log('sendAction: ' + action);
    return rpc('tools/call', {
      name: 'mikser_ui_action',
      arguments: {
        entityId: ctx.entityId,
        layoutId: ctx.layoutId,
        action: action,
        payload: payload,
      },
    }, 5000).then(function (r) {
      log('✓ mikser_ui_action returned', 'ok');
      return r;
    }).catch(function (err) {
      log('✗ mikser_ui_action failed: ' + err.message, 'fail');
      throw err;
    });
  };

  // Handshake — sent immediately on load. If the host doesn't reply,
  // content will still inject when tool-result arrives, but clicks
  // won't deliver (no AppBridge translating tools/call frames).
  log('shell loaded');
  rpc('ui/initialize', {
    appCapabilities: { availableDisplayModes: ['inline'] },
  }, 2000).then(function (init) {
    var hostName = (init && init.hostInfo && init.hostInfo.name) || 'unknown';
    log('✓ ui/initialize replied — host=' + hostName, 'ok');
    if (init && init.hostInfo && init.hostInfo.origin) {
      hostOrigin = init.hostInfo.origin;
    }
  }).catch(function () {
    log('Diagnosis: host did NOT respond to ui/initialize. The MCP Apps AppBridge is not implemented (or disabled) on this host. Click actions will not reach mikser. See ADR-0008.', 'fail');
  });
})();
</script>
</body>
</html>`

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

        // ui://mikser/preview-ui-shell — the MCP-UI shell resource.
        // mikser_preview_ui's _meta.ui.resourceUri points here. Hosts
        // that implement MCP Apps fetch this once via resources/read,
        // load it in a sandboxed iframe, then deliver the per-call
        // structuredContent via ui/notifications/tool-result. The shell
        // is static and version-independent across tool calls.
        //
        // mimeType MUST be 'text/html;profile=mcp-app' per the spec —
        // basic-host and other conformant hosts reject anything else.
        mcp.registerResource(
            'mikser-preview-ui-shell',
            'ui://mikser/preview-ui-shell',
            {
                title: 'MCP-UI shell for mikser_preview_ui',
                description: 'The static iframe shell that mikser_preview_ui renders into. Handles the MCP Apps protocol (ui/initialize, tool-result injection, tools/call relay) so layouts can be content-only HTML.',
                mimeType: 'text/html;profile=mcp-app',
            },
            async (uri) => ({
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/html;profile=mcp-app',
                    text: PREVIEW_UI_SHELL_HTML,
                }],
            }),
        )

        // mikser_preview_ui — uses registerTool (not simpleTool) so we
        // can set _meta.ui.resourceUri pointing at the shell. Per the
        // MCP Apps spec, this signals to hosts: "this tool renders UI
        // — fetch the resource at ui:// for the iframe template, and
        // pass the tool's structuredContent to the iframe via
        // ui/notifications/tool-result." Hosts without MCP Apps
        // support fall back to displaying content[0].text.
        mcp.registerTool(
            'mikser_preview_ui',
            {
                description: 'Render an entity through a layout that declares `mcpUi` frontmatter and return it as a UI block. Selects the layout by matching `entityId` against `layout.meta.match` and filtering on `mode`. **Read `mikser://mcp-ui/modes` first** to discover which modes and entity patterns this project supports. Layouts without `mcpUi` frontmatter are not eligible. Spec-conformant hosts render the result inside an iframe loaded from `ui://mikser/preview-ui-shell`; non-UI hosts display the rendered HTML as text.',
                inputSchema: {
                    entityId: z.string().describe('Entity to render, e.g. "/articles/2026-launch".'),
                    mode: z.string().optional().describe('Which UI mode to render. Defaults to "preview". Available modes are whatever your layouts declare as `mcpUi.mode`.'),
                },
                _meta: {
                    ui: {
                        // Spec-required: tells MCP Apps hosts to render
                        // this tool's result inside the shell iframe.
                        resourceUri: 'ui://mikser/preview-ui-shell',
                    },
                },
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

                    // Structured payload the iframe receives via
                    // ui/notifications/tool-result. The shell reads
                    // structuredContent.html and injects it into its
                    // #mikser-ui-root div; entityId + layoutId are what
                    // window.sendAction() forwards back to mikser_ui_action.
                    const structured = {
                        entityId,
                        layoutId:    matched.id,
                        mode,
                        html,
                        mcpUi: {
                            layoutId:    matched.id,
                            mode,
                            description: mcpUiMeta.description ?? null,
                            actions:     mcpUiMeta.actions     ?? [],
                            sandbox:     mcpUiMeta.sandbox     ?? ['allow-scripts'],
                            actionTool:  'mikser_ui_action',
                        },
                    }
                    return {
                        // content[0] is the fallback for hosts that don't
                        // implement MCP Apps. They'll display this as
                        // text — the layout's body HTML — so the user
                        // at least sees the rendered content even if
                        // the iframe doesn't load.
                        content: [
                            { type: 'text', text: html, mimeType: 'text/html' },
                        ],
                        // structuredContent — the spec-mandated way to
                        // deliver per-call data to a UI tool's iframe.
                        // Hosts pass this to the iframe via
                        // ui/notifications/tool-result after the shell
                        // (loaded from _meta.ui.resourceUri) completes
                        // ui/initialize.
                        structuredContent: structured,
                        // _meta.mcpUi kept for backward compatibility
                        // with hosts/tools that read it directly.
                        // structuredContent.mcpUi is the canonical copy
                        // going forward.
                        _meta: { mcpUi: structured.mcpUi },
                    }
                } catch (err) {
                    logger.error('MCP mikser_preview_ui error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        // mikser_ui_action — app-callable tool that delivers a user
        // click from inside an mcpUi iframe back to the agent (or to
        // an external webhook handler).
        //
        // Visibility model (MCP Apps spec 2026-01-26):
        //   _meta.ui.visibility = ['app']
        //
        // means this tool is invisible to the agent — it's never
        // listed in the model's tool surface — but iframes opened by
        // mikser_preview_ui can invoke it over the host's AppBridge
        // (tools/call over postMessage). The host bridges the call
        // into a real MCP tools/call, and the agent sees the result
        // as a separate tool turn in the conversation.
        //
        // Auth boundary: the action MUST appear in the layout's
        // declared mcpUi.actions list. Unknown actions return an
        // error result. There is no callId / random URL / signature
        // on this channel — the iframe's only path to mikser is
        // through the host's authenticated MCP transport, which is
        // already trusted.
        //
        // Resolution: pure relay (return { entityId, action, payload }
        // as the tool result) unless the layout declared
        // mcpUi.handler.url, in which case mikser POSTs the action
        // to that URL (HMAC-signed if handler.secret is set) and
        // returns the handler's response. See forwardToHandler above.
        mcp.registerTool(
            'mikser_ui_action',
            {
                description: 'Deliver a user action emitted from an mcpUi iframe. App-callable only — invisible to the agent, invoked exclusively by iframes opened via mikser_preview_ui. Validates the action against the layout\'s declared mcpUi.actions list, then either returns { entityId, action, payload } as a pure relay or forwards to the layout\'s handler.url webhook if one is declared.',
                inputSchema: {
                    entityId: z.string().describe('Entity the action targets (the same id the iframe was rendered for).'),
                    layoutId: z.string().describe('Layout that rendered the iframe — used to look up the allowed-actions list and optional handler config.'),
                    action:   z.string().describe('Action name. Must appear in the layout\'s mcpUi.actions list.'),
                    payload:  z.record(z.any()).optional().describe('Structured payload — form fields, selected status, etc. Schema is layout-defined; mikser passes it through.'),
                },
                _meta: {
                    ui: {
                        // App-callable only — invisible to the model
                        // per MCP Apps spec. Hosts MUST NOT include
                        // it in the agent's tools/list response and
                        // MUST allow iframes opened via mikser_preview_ui
                        // to invoke it.
                        visibility: ['app'],
                    },
                },
            },
            async ({ entityId, layoutId, action, payload = {} }) => {
                const logger = useLogger()
                const fail = (msg) => ({
                    isError: true,
                    content: [{ type: 'text', text: msg }],
                })
                const ok = (data) => ({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
                })

                try {
                    const layout = await findEntity({ id: layoutId })
                    if (!layout || layout.collection !== 'layouts') {
                        return fail(`Layout not found or not a layout: ${layoutId}`)
                    }
                    const mcpUiMeta = layout.meta?.mcpUi
                    if (!mcpUiMeta) {
                        return fail(`Layout ${layoutId} does not declare mcpUi frontmatter — not eligible as an action source.`)
                    }
                    const allowed = mcpUiMeta.actions ?? []
                    if (!allowed.includes(action)) {
                        return fail(`Action "${action}" not in allowed list for ${layoutId}. Declared: [${allowed.join(', ')}]`)
                    }

                    const result = { entityId, action, payload }

                    if (mcpUiMeta.handler?.url) {
                        try {
                            const handlerResult = await forwardToHandler(mcpUiMeta.handler, {
                                ...result,
                                layoutId,
                                mode: mcpUiMeta.mode ?? 'preview',
                            })
                            logger.debug('MCP mikser_ui_action forwarded %s/%s → %s OK',
                                entityId, action, mcpUiMeta.handler.url)
                            return ok(handlerResult)
                        } catch (err) {
                            // Fail-safe: never lose the user's click.
                            // Surface handler failure to the agent as
                            // structured metadata alongside the relay
                            // payload so the agent can decide whether
                            // to retry or proceed without backend ack.
                            logger.warn('MCP mikser_ui_action handler failed (%s) — falling back to pure relay: %s',
                                mcpUiMeta.handler.url, err.message)
                            return ok({ ...result, handlerError: err.message })
                        }
                    }

                    logger.debug('MCP mikser_ui_action %s/%s (pure relay)', entityId, action)
                    return ok(result)
                } catch (err) {
                    logger.error('MCP mikser_ui_action error: %s', err.message)
                    return fail(err.message)
                }
            },
        )

        const logger = useLogger()
        logger.debug('MCP tools registered: mikser_preview_ui + mikser_ui_action + mikser://mcp-ui/modes resource (preview plugin)')
    })

    return { name: 'preview' }
}

import path from 'node:path'
import { access, writeFile, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import _ from 'lodash'
import sift from 'sift'
import { useRenderer, useCollection } from '../api.js'

// Mongo-style operators recognised in URL query params as `<path>.$<op>=...`.
// $in / $nin take comma-separated values; $exists takes a truthy/falsy
// string; everything else coerces the value (numbers, booleans, null) and
// hands it to sift. Anything sift accepts works on the POST body path too.
const QUERY_OPS = new Set([
    'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'exists', 'regex',
])

function coerceScalar(v) {
    if (typeof v !== 'string') return v
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null') return null
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    return v
}

function coerceForOp(value, op) {
    if (op === 'in' || op === 'nin') {
        return String(value).split(',').map(s => coerceScalar(s.trim()))
    }
    if (op === 'exists') return value === 'true' || value === '1'
    if (op === 'regex') return String(value)
    return coerceScalar(value)
}

// "name,-date" → { name: 1, date: -1 }
function parseSortString(spec) {
    const sort = {}
    if (!spec) return sort
    for (const raw of String(spec).split(',')) {
        const t = raw.trim()
        if (!t) continue
        if (t.startsWith('-')) sort[t.slice(1)] = -1
        else sort[t.replace(/^\+/, '')] = 1
    }
    return sort
}

// "id,meta.title" → ['id', 'meta.title']
function parseFieldsString(spec) {
    if (!spec) return null
    return String(spec).split(',').map(s => s.trim()).filter(Boolean)
}

// Reserved query-string keys that aren't filter fields.
const RESERVED = new Set(['page', 'limit', 'skip', 'sort', 'fields'])

function parseQueryString(params) {
    const filter = {}
    let page = 1, limit, skip, sort, fields
    for (const [key, raw] of Object.entries(params)) {
        if (key === 'page')   { page = Math.max(1, parseInt(raw) || 1); continue }
        if (key === 'limit')  { limit = parseInt(raw); continue }
        if (key === 'skip')   { skip = parseInt(raw); continue }
        if (key === 'sort')   { sort = parseSortString(raw); continue }
        if (key === 'fields') { fields = parseFieldsString(raw); continue }

        // <path>.$<op>=... groups under the same dotted-path key so
        // multiple operators on one field compose:
        // meta.price.$gt=10&meta.price.$lt=50 → { 'meta.price': { $gt:10, $lt:50 } }
        // We use dotted keys (Mongo-style) rather than nested objects so
        // sift treats them as path matchers, not deep-equality.
        const m = key.match(/^(.+)\.\$([a-zA-Z]+)$/)
        if (m && QUERY_OPS.has(m[2])) {
            const [, fieldPath, op] = m
            const ops = (filter[fieldPath] && typeof filter[fieldPath] === 'object' && !Array.isArray(filter[fieldPath]))
                ? filter[fieldPath]
                : {}
            ops[`$${op}`] = coerceForOp(raw, op)
            filter[fieldPath] = ops
        } else {
            filter[key] = coerceScalar(raw)
        }
    }
    return { filter, page, limit, skip, sort, fields }
}

// Apply filter → endpoint scope → sort → skip/limit → projection.
// `findEntities()` returns the live in-memory catalog; for ≤100k docs the
// per-request scan is plenty fast. Backing this with an index becomes
// interesting past that — same endpoint contract.
async function runQuery({ filter, sort, fields, skip, limit, scope, findEntities }) {
    let all = await findEntities()
    if (scope) all = all.filter(scope)

    if (filter && Object.keys(filter).length) {
        const match = sift(filter)
        all = all.filter(match)
    }

    const total = all.length

    if (sort && Object.keys(sort).length) {
        const entries = Object.entries(sort)
        all.sort((a, b) => {
            for (const [key, dir] of entries) {
                const av = _.get(a, key)
                const bv = _.get(b, key)
                if (av == null && bv == null) continue
                if (av == null) return 1
                if (bv == null) return -1
                if (av < bv) return -dir
                if (av > bv) return dir
            }
            return 0
        })
    }

    let items = all.slice(skip, skip + limit)
    if (fields?.length) items = items.map(e => _.pick(e, fields))
    return { items, total }
}

// Derive the cache filename from the raw query string the client sent.
//   no query string (`/entities`)       → 'index'
//   query string ('a=1&b=2')            → 'a=1&b=2'
//
// We deliberately keep the raw, undecoded form because:
//   - that's what nginx's `$args` variable contains
//   - stock nginx can pass it straight into `try_files` without
//     hashing modules or Lua
//   - the URL is its own cache key — no extra contract for clients
//     or proxies to agree on beyond "use the request URL"
//
// Trade-off: structurally-equal queries with different parameter
// orders produce different cache files (`?a=1&b=2` vs `?b=2&a=1`).
// Soft inefficiency, not a correctness bug — the SDK uses a stable
// order and most consumers are SDK-driven. Filesystem rules apply:
// most chars (`=`, `&`, `[`, `]`, `%`) are safe; 255-byte filename
// limits cap query length on typical fs. Document these in the
// caching README.
function cacheNameForQueryString(rawQueryString) {
    if (!rawQueryString) return 'index'
    return rawQueryString
}

// Write the response envelope to <out>/<base>/<endpoint>/entities/<name>.json.
// The path matches what nginx's `try_files /<base>/<endpoint>/entities/$args.json
// /<base>/<endpoint>/entities/index.json` looks up on upstream failure.
async function writeQueryCache({ outputFolder, base, name, cacheName, envelope, logger }) {
    const relBase = base.replace(/^\//, '')
    const dir = path.join(outputFolder, relBase, name, 'entities')
    const file = path.join(dir, `${cacheName}.json`)
    try {
        await mkdir(dir, { recursive: true })
        await writeFile(file, JSON.stringify(envelope), 'utf8')
        logger.trace('Api[%s] cache write: %s (%d items)', name, file, envelope.items.length)
    } catch (err) {
        // Filename-length / illegal-char failures land here. Logged but
        // not propagated — the live response is already on the wire.
        logger.error('Api[%s] cache write failed (%s): %s', name, file, err.message)
    }
}

// Clear the entire per-endpoint cache directory. Called when any
// catalog entity changes — coarse but correct, and on-demand writes
// rebuild the cache as queries come back in. The cost of warm-up
// after invalidation is bounded by traffic, which is what you'd want
// from a write-through cache anyway.
async function clearEndpointCache({ outputFolder, base, name, logger }) {
    const relBase = base.replace(/^\//, '')
    const dir = path.join(outputFolder, relBase, name, 'entities')
    try {
        await rm(dir, { recursive: true, force: true })
        logger.trace('Api[%s] cache cleared: %s', name, dir)
    } catch (err) {
        logger.error('Api[%s] cache clear failed (%s): %s', name, dir, err.message)
    }
}

// MIME type lookup used when streaming a postprocessor's output back over
// HTTP. The renderer's output extension lives on entity.destination
// (assigned by the layouts plugin), so we use it as the source of truth.
const MIME_BY_EXT = {
    pdf: 'application/pdf',
    html: 'text/html; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    xhtml: 'application/xhtml+xml; charset=utf-8',
    rss: 'application/rss+xml; charset=utf-8',
    atom: 'application/atom+xml; charset=utf-8',
    json: 'application/json; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
}

export function mimeForEntity(entity) {
    if (!entity?.destination) return null
    const ext = path.extname(entity.destination).toLowerCase().replace(/^\./, '')
    return MIME_BY_EXT[ext] ?? null
}

// Decide how to send the render output over HTTP. Exported (and pure-ish)
// so tests can exercise the branching without spinning up a real server.
export async function sendRenderOutput(res, output, entity) {
    if (output == null || output.result == null) {
        return res.status(204).send()
    }
    const result = output.result
    const mime = mimeForEntity(entity)

    if (Buffer.isBuffer(result)) {
        if (mime) res.type(mime)
        return res.send(result)
    }
    if (typeof result === 'string') {
        // A few postprocessors might return an absolute path to a generated
        // file rather than its contents. Only attempt this when the string
        // looks plausibly path-shaped — short, starts with a slash, and the
        // file actually exists. Otherwise treat it as content.
        if (result.length < 4096 && (result.startsWith('/') || /^[A-Za-z]:[\\/]/.test(result))) {
            try {
                await access(result)
                return res.sendFile(result)
            } catch { /* not a path, fall through */ }
        }
        if (mime) res.type(mime)
        return res.send(result)
    }
    // Anything else (plain object, etc.) is sent as JSON.
    return res.json(result)
}

// Subscription bookkeeping shared across all endpoints. Each entry holds
// the live Express response, the compiled sift filter, the endpoint
// scope, and a heartbeat timer. Per-cycle the onFinalized hook iterates
// the journal and dispatches matching changes to every subscription.
const subscriptions = new Map()
let subscriptionCounter = 0

function sseInit(res) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')  // disable nginx buffering
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
}

function sseSend(res, eventName, payload) {
    try {
        res.write(`event: ${eventName}\n`)
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch { /* connection dropped — cleanup runs via 'close' */ }
}

export default ({
    runtime,
    onLoaded,
    onFinalize,
    useLogger,
    useJournal,
    findEntities,
    constants: { OPERATION },
}) => {
    // Shared between onLoaded (populates) and onFinalize (consumes).
    // Hoisted so the lifecycle hooks see the same registry; the body
    // inside onLoaded is what actually fills it in based on
    // runtime.config.api.endpoints.
    let apiBase = '/api'
    const cachedEndpoints = []

    onLoaded(async () => {
        const logger = useLogger()

        // The api plugin no longer creates its own Express app. It mounts
        // onto an existing app provided either by --server (engine
        // creates one) or by a caller that programmatically passed
        // setup({ app: ... }). Without an app there's nowhere to mount
        // routes, so fail fast with a message that points at the fix.
        const app = runtime.options.app
        if (!app) {
            throw new Error(
                'API plugin requires runtime.options.app — run mikser with --server, ' +
                'or pass { app: yourExpressInstance } to setup() before loading the api plugin'
            )
        }

        const endpoints = runtime.config.api?.endpoints
        if (!endpoints || !Object.keys(endpoints).length) {
            logger.warn('Api plugin loaded but no endpoints configured (api.endpoints) — nothing to mount')
            return
        }

        const { default: express } = await import('express').catch(() => {
            throw new Error('Express is required for the api plugin — run: npm install express')
        })

        apiBase = runtime.config.api?.base ?? '/api'
        const base = apiBase   // alias so existing local references still work
        const globalPageSize = runtime.config.api?.pageSize ?? 10
        const globalRenderTimeout = runtime.config.api?.renderTimeout ?? 30_000

        // cachedEndpoints is hoisted above (shared with onFinalize).
        // Per-endpoint setup loop pushes into it when cache: true is set.

        // The plugin mirrors the vector / data plugin shape: a named map
        // of endpoints, each with its own optional `token`, `query`
        // scope, allowed `operations`, and overrides for pageSize /
        // renderTimeout. Each endpoint mounts under <base>/<name>.
        //
        //   api.endpoints.public  { query: e => e.meta?.published, operations: ['list'] }
        //   api.endpoints.admin   { token: '...', operations: ['list','update','delete','render'] }
        for (const [name, ep] of Object.entries(endpoints)) {
            const router = express.Router()
            router.use(express.json())

            // Operations default to the safer shape when no token is set
            // (read-only) and full access when token-gated. `subscribe`
            // holds an open SSE connection per client — opt in for
            // public endpoints; included in the token-gated default
            // because tokens already gate the trust. Explicit
            // `operations` always wins.
            const defaultOps = ep.token
                ? ['list', 'update', 'delete', 'render', 'subscribe']
                : ['list']
            const allowedOps = new Set(ep.operations ?? defaultOps)

            const query = typeof ep.query === 'function' ? ep.query : null
            const pageSize = ep.pageSize ?? globalPageSize
            const renderTimeout = ep.renderTimeout ?? globalRenderTimeout

            // Endpoints with cache: true cache GET /entities responses
            // to disk on a per-query-string basis. Path scheme:
            //   <out>/<base>/<name>/entities/<raw-query-string>.json
            //   <out>/<base>/<name>/entities/index.json    (no params)
            //
            // On any catalog change, the whole cache directory is
            // dropped — the next requests through repopulate whatever's
            // needed. Coarse but correct, no per-query tracking.
            //
            // Reverse-proxy failover (stock nginx, no Lua):
            //   location /api/sitemap/entities {
            //       proxy_pass http://localhost:3001;
            //       proxy_intercept_errors on;
            //       error_page 502 503 504 = @cache;
            //   }
            //   location @cache {
            //       root /var/www/out;
            //       try_files /api/sitemap/entities/$args.json
            //                 /api/sitemap/entities/index.json
            //                 =502;
            //   }
            //
            // POST /entities/query responses aren't cached — there's no
            // URL the proxy could derive a cache file path from. Use
            // GET for cacheable queries (the SDK's client.list({...}) →
            // GET URL is the canonical pattern).
            if (ep.cache === true) {
                cachedEndpoints.push({ name })
            }
            const cacheEnabled = ep.cache === true

            const auth = (req, res, next) => {
                if (!ep.token) return next()
                if (req.headers.authorization === `Bearer ${ep.token}`) return next()
                res.status(401).json({ error: 'Unauthorized' })
            }

            const allow = (op) => (req, res, next) => {
                if (!allowedOps.has(op)) {
                    return res.status(403).json({
                        error: `Operation '${op}' is not allowed on endpoint '${name}'`,
                    })
                }
                next()
            }

            // Reuse the transport-agnostic primitives from src/api.js so
            // the library entry point and the HTTP endpoints share the
            // exact same batching/timeouts/error semantics. One renderer
            // per endpoint so per-endpoint renderTimeout overrides land.
            const { render } = useRenderer(runtime, { defaultTimeout: renderTimeout })

            router.get('/entities', allow('list'), auth, async (req, res) => {
                const t0 = Date.now()
                try {
                    const parsed = parseQueryString(req.query)
                    const limit = Math.min(100, Math.max(1, parsed.limit ?? pageSize))
                    const skip = parsed.skip ?? (parsed.page - 1) * limit

                    const { items, total } = await runQuery({
                        filter: parsed.filter,
                        sort: parsed.sort,
                        fields: parsed.fields,
                        skip,
                        limit,
                        scope: query,
                        findEntities,
                    })

                    const page = Math.floor(skip / limit) + 1
                    const totalPages = Math.ceil(total / limit) || 1
                    const envelope = {
                        items, page, limit, total, totalPages,
                        hasNext: skip + limit < total,
                        hasPrev: skip > 0,
                    }
                    res.json(envelope)
                    logger.trace('Api[%s] list %dms (%d/%d items)', name, Date.now() - t0, items.length, total)

                    // Write-through cache: write the response to a file
                    // path that mirrors the request URL — same `$args`
                    // nginx's `try_files` sees, no hashing on either
                    // side. See the caching docs for the nginx config
                    // that wires the failover.
                    if (cacheEnabled && runtime.options.outputFolder) {
                        const url = req.originalUrl || req.url || ''
                        const qIdx = url.indexOf('?')
                        const rawQueryString = qIdx >= 0 ? url.slice(qIdx + 1) : ''
                        const cacheName = cacheNameForQueryString(rawQueryString)
                        // Fire-and-forget — the response is already sent.
                        writeQueryCache({
                            outputFolder: runtime.options.outputFolder,
                            base: apiBase,
                            name,
                            cacheName,
                            envelope,
                            logger,
                        }).catch(() => {})
                    }
                } catch (err) {
                    logger.error('Api[%s] list error (%dms): %s', name, Date.now() - t0, err.message)
                    res.status(500).json({ error: err.message })
                }
            })

            // POST /entities/query — body-based query for anything that
            // doesn't fit cleanly in a URL: $and/$or, nested operators,
            // regex, projections, etc. Same shape as a Mongo find.
            router.post('/entities/query', allow('list'), auth, async (req, res) => {
                const t0 = Date.now()
                try {
                    const { filter = {}, sort, fields, page: rawPage = 1, limit: rawLimit, skip: rawSkip } = req.body ?? {}
                    const limit = Math.min(100, Math.max(1, rawLimit ?? pageSize))
                    const skip = rawSkip ?? (Math.max(1, parseInt(rawPage) || 1) - 1) * limit

                    const { items, total } = await runQuery({
                        filter, sort, fields, skip, limit,
                        scope: query,
                        findEntities,
                    })

                    const page = Math.floor(skip / limit) + 1
                    const totalPages = Math.ceil(total / limit) || 1
                    const envelope = {
                        items, page, limit, total, totalPages,
                        hasNext: skip + limit < total,
                        hasPrev: skip > 0,
                    }
                    res.json(envelope)
                    logger.trace('Api[%s] query %dms (%d/%d items)', name, Date.now() - t0, items.length, total)

                    // POST queries aren't disk-cached. The reverse proxy
                    // failover scheme is URL-based (cache file path =
                    // request URL), but POST has no URL-equivalent for
                    // its body. Cacheable queries should use GET — which
                    // the SDK's list() does by default. Body-only queries
                    // are by definition complex/non-canonicalizable so
                    // they're treated as live-only.
                } catch (err) {
                    logger.error('Api[%s] query error (%dms): %s', name, Date.now() - t0, err.message)
                    res.status(500).json({ error: err.message })
                }
            })

            // GET /entities/subscribe — open an SSE stream. Each subsequent
            // process cycle (file-watcher fired OR programmatic API write)
            // emits create/update/delete events for entities matching the
            // subscription's filter and the endpoint's scope. Heartbeats
            // every 25s keep proxies happy. Connection close cleans up.
            router.get('/entities/subscribe', allow('subscribe'), auth, (req, res) => {
                let filterFn = null
                try {
                    const parsed = parseQueryString(req.query)
                    if (Object.keys(parsed.filter).length) filterFn = sift(parsed.filter)
                } catch (err) {
                    return res.status(400).json({ error: `Invalid filter: ${err.message}` })
                }

                sseInit(res)
                const subscriptionId = `sub_${Date.now()}_${++subscriptionCounter}`
                sseSend(res, 'init', { subscriptionId, endpoint: name })

                // Heartbeat — silent enough to not confuse the SDK but
                // frequent enough that idle proxies don't kill the
                // connection.
                const heartbeat = setInterval(() => sseSend(res, 'heartbeat', {}), 25_000)
                if (typeof heartbeat.unref === 'function') heartbeat.unref()

                subscriptions.set(subscriptionId, {
                    endpointName: name,
                    scope: query,
                    filter: filterFn,
                    res,
                })

                req.on('close', () => {
                    clearInterval(heartbeat)
                    subscriptions.delete(subscriptionId)
                    logger.debug('Api[%s] subscription closed: %s', name, subscriptionId)
                })

                logger.debug('Api[%s] subscription opened: %s', name, subscriptionId)
            })

            router.put('/entities', allow('update'), auth, async (req, res) => {
                try {
                    const { collection, relativePath, content = '' } = req.body
                    await useCollection(runtime, collection).write(relativePath, content)
                    res.status(202).json({ ok: true })
                } catch (err) {
                    logger.error('Api[%s] update error: %s', name, err.message)
                    res.status(/Unknown collection/.test(err.message) ? 400 : 500).json({ error: err.message })
                }
            })

            router.delete('/entities', allow('delete'), auth, async (req, res) => {
                try {
                    const { collection, relativePath } = req.body
                    await useCollection(runtime, collection).remove(relativePath)
                    res.status(202).json({ ok: true })
                } catch (err) {
                    logger.error('Api[%s] delete error: %s', name, err.message)
                    res.status(/Unknown collection/.test(err.message) ? 400 : 500).json({ error: err.message })
                }
            })

            router.post('/render', allow('render'), auth, async (req, res) => {
                try {
                    // Body shape mirrors the JS API: entity fields at top
                    // level, control flags grouped under `options`. Forwarded
                    // straight to render(entity, options). Defaults match
                    // mikser's lifecycle (save and keep the catalog row);
                    // strict opt-outs via the literal `false`:
                    //   options.catalog: false → prune the catalog row
                    //   options.save:    false → skip the final disk write
                    //                            (bytes still in the response)
                    const { options = {}, ...entityShape } = req.body
                    // When the endpoint declares a scope, reject anything
                    // outside it BEFORE pushing through the renderer.
                    if (query && !query(entityShape)) {
                        return res.status(403).json({ error: 'Entity is outside this endpoint\'s scope' })
                    }
                    const { output, entity } = await render(entityShape, options)
                    await sendRenderOutput(res, output, entity)
                } catch (err) {
                    logger.error('Api[%s] render error: %s', name, err.message)
                    if (!res.headersSent) {
                        res.status(500).json({ error: err.message })
                    }
                }
            })

            app.use(`${base}/${name}`, router)
            logger.info('Api endpoint mounted: %s/%s (ops=[%s] %s)',
                base, name, [...allowedOps].join(','),
                ep.token ? '[token]' : '[public]')
        }
    })

    // Dispatcher: once per lifecycle cycle, walk the journal and push
    // matching CREATE/UPDATE/DELETE events to every active subscription
    // (regardless of which endpoint opened it). Each subscription has
    // its own scope + filter; we apply both before sending. Empty when
    // nothing's subscribed, so it costs ~nothing in normal builds.
    //
    // Hook onFinalize, NOT onFinalized — journal.js registers its own
    // clearJournal callback on onFinalized at module load, which runs
    // before plugin onFinalized hooks. By Finalize we still have the
    // cycle's journal entries; by Finalized they're already gone.
    onFinalize(async (signal) => {
        const logger = useLogger()
        const evMap = {
            [OPERATION.CREATE]: 'create',
            [OPERATION.UPDATE]: 'update',
            [OPERATION.DELETE]: 'delete',
        }

        // Cache invalidation is intentionally coarse: if ANY entity
        // changed in this cycle, rebuild every cached endpoint. Per-
        // endpoint scope matching would shave a few file writes off a
        // churning catalog but adds bug surface for no real win —
        // buildDefaultEnvelope is microseconds (in-memory sift),
        // writeFile is milliseconds. Simpler and safer to just rebuild.
        let anyChange = false

        // Single journal iteration drives both SSE push and the
        // any-change flag — one pass per cycle.
        for await (const { operation, entity } of useJournal(
            'Api subscriptions',
            [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
            signal,
        )) {
            anyChange = true

            // SSE push to live subscribers
            for (const [subId, sub] of subscriptions) {
                if (sub.scope && !sub.scope(entity)) continue
                if (sub.filter && !sub.filter(entity)) continue
                const payload = operation === OPERATION.DELETE
                    ? { id: entity.id }
                    : { id: entity.id, entity }
                sseSend(sub.res, evMap[operation], payload)
                logger.trace('Api subscription %s %s: %s', subId, evMap[operation], entity.id)
            }
        }

        // Clear each cached endpoint's directory on any entity change.
        // Subsequent list requests re-warm the cache via the write-
        // through path in the GET/POST handlers above. Coarse but
        // correct — any stale entry, anywhere in the per-endpoint
        // cache, gets dropped without us having to track which queries
        // were affected by which entity changes.
        if (anyChange && cachedEndpoints.length > 0 && runtime.options.outputFolder) {
            for (const ep of cachedEndpoints) {
                await clearEndpointCache({
                    outputFolder: runtime.options.outputFolder,
                    base: apiBase,
                    name: ep.name,
                    logger,
                })
            }
        }
    })
}

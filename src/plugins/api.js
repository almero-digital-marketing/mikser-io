import path from 'node:path'
import { access, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import _ from 'lodash'
import sift from 'sift'
import { z } from 'zod'
import { useRenderer } from '../render.js'
import { mimeForEntity, isLoopback, expandEntity, projectMeta, ExpandError, useCollection } from '../utils.js'

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

// Reserved query-string keys — never routed to the sift filter, even
// if a parser below doesn't know what to do with them.
//
// Every key listed here must EITHER be parsed by the switch in
// parseQueryString OR be intentionally ignored (e.g. `cache`, which is
// a nginx-fast-path routing hint the SDK appends — the server reads it
// for filename derivation in cacheNameForQueryString, not for query
// semantics).
//
// The single source of truth here prevents the silent-empty-results
// bug class where a reserved-routing-key falls through to sift, gets
// applied as `entity.<key> === '<value>'`, and matches nothing on a
// typical catalog. Adding a new reserved key without updating the
// parser is now safe: missing case → no parsing, but the filter
// pathway is still skipped.
const RESERVED = new Set([
    'page', 'limit', 'skip', 'sort', 'fields', 'expand',
    'cache',
])

function parseQueryString(params) {
    const filter = {}
    let page = 1, limit, skip, sort, fields, expand
    for (const [key, raw] of Object.entries(params)) {
        if (RESERVED.has(key)) {
            switch (key) {
                case 'page':   page  = Math.max(1, parseInt(raw) || 1); break
                case 'limit':  limit = parseInt(raw); break
                case 'skip':   skip  = parseInt(raw); break
                case 'sort':   sort  = parseSortString(raw); break
                case 'fields': fields = parseFieldsString(raw); break
                // ADR-0007 B1: expand list, comma-separated. Empty
                // entries are filtered out so a trailing comma doesn't
                // count toward the maxPaths cap.
                case 'expand':
                    expand = String(raw).split(',').map(s => s.trim()).filter(Boolean)
                    break
                // `cache`: nginx fast-path routing hint. The SDK
                // appends `&cache=<hash>` matching the server's hash;
                // the server reads it ONLY in cacheNameForQueryString.
                // No effect on query semantics — dropped here on
                // purpose. (User filter fields live under `meta.*`
                // paths, so bare `cache=` at the URL root has no
                // realistic collision with entity content.)
                case 'cache': break
            }
            continue
        }

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
    return { filter, page, limit, skip, sort, fields, expand }
}

// Build a findRef closure that takes a ref string and returns the
// catalog entity it resolves to, or null. The convention is hrefs (ADR-
// 0007 A2) — leading slash, no extension. We tolerate three lookup
// shapes so projects with different addressing schemes work:
//   - exact id        — for callers that addressed by raw catalog id
//   - meta.href       — the canonical published-href field
//   - id-minus-ext    — `/authors/dick` matches `/authors/dick.yml`
//
// The same heuristic the schemas plugin uses for ref-existence checks;
// extracted here so the api expand walker resolves the same way.
function findRefFactory(findEntities) {
    return async function findRef(ref) {
        if (!ref || typeof ref !== 'string') return null
        const matches = await findEntities(e =>
            !!e && (
                e.id === ref ||
                e.meta?.href === ref ||
                (typeof e.id === 'string' && e.id.replace(/\.[^./]+$/, '') === ref)
            ),
        )
        return matches[0] ?? null
    }
}

// Per-endpoint expansion caps. Plumbed from mikser.config.js:
//   api: { expand: { maxDepth, maxPaths, maxResolved } }
// Defaults match ADR-0007 B7. Centralised here so list, query, and
// read paths apply the same limits.
function expandLimits(runtime) {
    const cfg = runtime?.config?.api?.expand ?? {}
    return {
        maxDepth:    typeof cfg.maxDepth    === 'number' ? cfg.maxDepth    : 5,
        maxPaths:    typeof cfg.maxPaths    === 'number' ? cfg.maxPaths    : 20,
        maxResolved: typeof cfg.maxResolved === 'number' ? cfg.maxResolved : 100,
    }
}

// Apply expand-then-project to one entity. When `expand` has entries
// the walker inlines resolved refs first; in all cases the final meta
// is normalized (`$`-keys stripped) so the wire shape matches what the
// SDK consumers and templates expect per ADR-0007 A3.
//
// projectMeta on a meta with no $-keys is a structural no-op (same
// values, new object identity). The small clone cost is acceptable
// for the consistency benefit — every api response is normalized.
async function expandAndProject(entity, expand, runtime, findEntities) {
    let result = entity
    if (expand?.length) {
        result = await expandEntity(entity, expand, {
            findRef: findRefFactory(findEntities),
            ...expandLimits(runtime),
        })
    }
    if (!result?.meta) return result
    return { ...result, meta: projectMeta(result.meta) }
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
//   query string ('a=1&b=2&id=/foo/bar') → 16-hex sha256 prefix
//
// We hash because query strings can contain any character a URL spec
// allows — slashes (`?id=/blog/launch.md`), unicode in `meta.tag.$eq`,
// percent-encodings, brackets — and direct filename use breaks on path
// separators, reserved chars, and 255-byte filename limits.
//
// A 16-char sha256 prefix (64 bits of address space) is comfortably
// collision-resistant for the cache-file population a real project
// generates.
//
// The `cache` query param is STRIPPED before hashing. The SDK
// (and any consumer that wants the nginx fast path) computes the same
// hash client-side and appends `&cache=<hash>` to the URL so nginx can
//
//     try_files /api/<endpoint>/entities/$arg_cache.json @proxy
//
// without a Lua snippet — `$arg_cache` is the client-provided hash, and
// because the param is invisible to the hash input, client and server
// always agree on the filename. A client that lies about the hash
// produces a cache miss in nginx (file at the wrong name) and falls
// through to mikser, which writes the file at the correct name; no
// cache poisoning is possible because the server is always the source
// of truth for filename choice.
//
// Structurally-equal queries with different parameter orders still
// produce different cache files (`?a=1&b=2` vs `?b=2&a=1`). Soft
// inefficiency, not a correctness bug — the SDK uses a stable order
// and most consumers are SDK-driven.
function cacheNameForQueryString(rawQueryString) {
    if (!rawQueryString) return 'index'
    const params = new URLSearchParams(rawQueryString)
    // Strip the routing-hint param. URLSearchParams.toString() emits the
    // remaining params in their original order, percent-encoded
    // canonically — both sides of the contract get the same bytes.
    params.delete('cache')
    const stripped = params.toString()
    if (!stripped) return 'index'
    return createHash('sha256').update(stripped).digest('hex').slice(0, 16)
}

// Wide-list defaults — tuned for "an SPA accidentally pulled the whole
// catalog because it forgot a `fields` projection." Operators can grep
// the warning out of logs; SDK users see the same shape client-side via
// the SDK's dev-mode warning.
const WIDE_RESPONSE_ITEMS = 100
const WIDE_RESPONSE_BYTES = 256 * 1024

function maybeWarnWide({ logger, endpoint, envelope, req }) {
    const items = envelope?.items?.length ?? 0
    if (items <= WIDE_RESPONSE_ITEMS) return
    const bytes = Buffer.byteLength(JSON.stringify(envelope))
    if (bytes <= WIDE_RESPONSE_BYTES && items <= WIDE_RESPONSE_ITEMS) return
    const queryStr = (req.originalUrl || req.url || '').split('?')[1] || '(none)'
    const sizeLabel = bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(bytes / 1024)} KB`
    logger.warn(
        'Api[%s] wide list response: %d items, %s — query=%s',
        endpoint, items, sizeLabel, queryStr,
    )
    logger.warn(
        '  ↳ Consider a `fields:` projection, or move this query to a `data.catalog.<name>` snapshot loaded via the SDK\'s `data.catalog` option.',
    )
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

// mimeForEntity lives in ../utils.js (pure helper, shared by several
// plugins). Imported at top of file.

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

// Per-cache-file graph subscriptions for expand-cached queries (ADR-0007
// B9). When a GET /entities response with `expand` is written to the
// cache, we register a runtime.refs.subscribeGraph against the same
// filter + expand. When any entity inside the expansion graph mutates,
// the subscription evicts the specific cache file and disposes itself.
// The next request re-warms the cache and registers a fresh
// subscription.
//
// Key shape: `${endpointName}/${cacheName}` so collisions across
// endpoints can't happen.
const cacheSubscriptions = new Map()

// Evict a single cache file. Used by graph-driven precise invalidation.
// Failure is logged but never throws — the next request rewrites the
// cache regardless.
async function evictCacheFile({ outputFolder, base, name, cacheName, logger }) {
    const dir = path.join(outputFolder, base.replace(/^\//, ''), name, 'entities')
    const file = path.join(dir, `${cacheName}.json`)
    try {
        await rm(file, { force: true })
        logger.trace('Api[%s] cache evict: %s', name, file)
    } catch (err) {
        logger.error('Api[%s] cache evict failed (%s): %s', name, file, err.message)
    }
}
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

        // Preview workflow (render → cache → URL) lives in its own
        // plugin (src/plugins/preview.js) as of v7.3.0. The api plugin
        // stays focused on REST catalog access; preview is a separate
        // domain. To use mikser_preview_render, load `preview` alongside `api`.

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

            // Server-enforced field projection. When set, every list /
            // query / subscribe response is narrowed to exactly these
            // dotted paths — regardless of what the client asks for.
            //
            // The right tool when an endpoint backs a broad list query
            // and only a handful of fields per entity are actually
            // useful to the client — sitemap, navigation menus,
            // faceted search dimensions. A SPA's first paint shouldn't
            // download every markdown body just to find out which
            // routes exist.
            //
            // Skip it for endpoints that serve individual full
            // documents (the typical `public` shape used by
            // useDocument(id)) — those queries return one entity at a
            // time so narrowing has no real benefit.
            const allowedFields = Array.isArray(ep.fields) && ep.fields.length
                ? ep.fields
                : null

            // Pick the effective projection for a request. If the
            // endpoint declares allowedFields, that's the ceiling: a
            // client requesting more gets only the intersection. A
            // client requesting nothing gets exactly allowedFields.
            // No allowedFields → whatever the client asked for (or
            // all fields when omitted).
            function resolveFields(requested) {
                if (!allowedFields) return requested ?? null
                if (!requested || !requested.length) return allowedFields
                const allowSet = new Set(allowedFields)
                return requested.filter(f => allowSet.has(f))
            }

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

            // Uniform mikser auth rule (same as MCP endpoints):
            //   - Token presented and matches → allow (from anywhere)
            //   - Token presented and doesn't match → 401
            //   - No token presented → require loopback unless allowRemote
            //
            // Endpoints with a token are still reachable from loopback
            // without the token — the "trusted local host" model. To
            // require the token everywhere, run mikser bound to a
            // non-loopback interface only (or behind a proxy that
            // doesn't forward loopback origin).
            const expectedAuth = ep.token ? `Bearer ${ep.token}` : null
            const auth = (req, res, next) => {
                const presented = req.headers.authorization
                if (expectedAuth && presented && presented !== expectedAuth) {
                    return res.status(401).json({ error: 'Unauthorized' })
                }
                if (presented === expectedAuth && expectedAuth) {
                    return next()   // valid token from anywhere
                }
                if (ep.allowRemote || isLoopback(req.ip)) {
                    return next()
                }
                res.status(403).json({
                    error: expectedAuth
                        ? 'Token required from non-loopback sources'
                        : 'Endpoint accepts loopback connections only — configure a token or set allowRemote: true to enable remote access',
                })
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

                    let { items, total } = await runQuery({
                        filter: parsed.filter,
                        sort: parsed.sort,
                        fields: resolveFields(parsed.fields),
                        skip,
                        limit,
                        scope: query,
                        findEntities,
                    })

                    // Expand + project per ADR-0007 B1 / A3. Always
                    // project so the wire shape is normalized; only
                    // walk the expansion paths when the caller asked.
                    items = await Promise.all(items.map(item =>
                        expandAndProject(item, parsed.expand, runtime, findEntities),
                    ))

                    const page = Math.floor(skip / limit) + 1
                    const totalPages = Math.ceil(total / limit) || 1
                    const envelope = {
                        items, page, limit, total, totalPages,
                        hasNext: skip + limit < total,
                        hasPrev: skip > 0,
                    }
                    res.json(envelope)
                    logger.trace('Api[%s] list %dms (%d/%d items)', name, Date.now() - t0, items.length, total)
                    maybeWarnWide({ logger, endpoint: name, envelope, req })

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

                        // Precise invalidation for expand-cached queries
                        // (ADR-0007 B9). Register a graph subscription
                        // against the same filter + expand; on any
                        // mutation in the expansion graph, the
                        // subscription evicts THIS cache file and
                        // disposes itself. Without expand, the coarse
                        // "any change → rebuild" pass below handles
                        // eviction.
                        if (parsed.expand?.length && runtime.refs?.subscribeGraph) {
                            const cacheKey = `${name}/${cacheName}`
                            // Dispose any prior subscription for this
                            // cache key — could happen if the same URL
                            // was served twice in a row without an
                            // intervening mutation.
                            cacheSubscriptions.get(cacheKey)?.dispose()

                            const requestFilter = parsed.filter && Object.keys(parsed.filter).length
                                ? sift(parsed.filter)
                                : null
                            const handle = runtime.refs.subscribeGraph({
                                filter: (entity) => {
                                    if (query && !query(entity)) return false
                                    if (requestFilter && !requestFilter(entity)) return false
                                    return true
                                },
                                expand: parsed.expand,
                                onAffected: async () => {
                                    // Evict and self-dispose. Future
                                    // requests rewrite the cache and
                                    // register a fresh subscription.
                                    try {
                                        await evictCacheFile({
                                            outputFolder: runtime.options.outputFolder,
                                            base: apiBase,
                                            name,
                                            cacheName,
                                            logger,
                                        })
                                    } finally {
                                        cacheSubscriptions.get(cacheKey)?.dispose()
                                        cacheSubscriptions.delete(cacheKey)
                                    }
                                },
                            })
                            cacheSubscriptions.set(cacheKey, handle)
                        }
                    }
                } catch (err) {
                    // ExpandError carries a 4xx status; everything else
                    // is a 500. Same shape used by the POST handler below.
                    const status = err instanceof ExpandError ? err.status : 500
                    if (status >= 500) {
                        logger.error('Api[%s] list error (%dms): %s', name, Date.now() - t0, err.message)
                    } else {
                        logger.debug('Api[%s] list rejected (%dms): %s', name, Date.now() - t0, err.message)
                    }
                    res.status(status).json({ error: err.message })
                }
            })

            // POST /entities/query — body-based query for anything that
            // doesn't fit cleanly in a URL: $and/$or, nested operators,
            // regex, projections, etc. Same shape as a Mongo find.
            router.post('/entities/query', allow('list'), auth, async (req, res) => {
                const t0 = Date.now()
                try {
                    const { filter = {}, sort, fields, expand, page: rawPage = 1, limit: rawLimit, skip: rawSkip } = req.body ?? {}
                    const limit = Math.min(100, Math.max(1, rawLimit ?? pageSize))
                    const skip = rawSkip ?? (Math.max(1, parseInt(rawPage) || 1) - 1) * limit

                    let { items, total } = await runQuery({
                        filter, sort,
                        fields: resolveFields(fields),
                        skip, limit,
                        scope: query,
                        findEntities,
                    })

                    items = await Promise.all(items.map(item =>
                        expandAndProject(item, expand, runtime, findEntities),
                    ))

                    const page = Math.floor(skip / limit) + 1
                    const totalPages = Math.ceil(total / limit) || 1
                    const envelope = {
                        items, page, limit, total, totalPages,
                        hasNext: skip + limit < total,
                        hasPrev: skip > 0,
                    }
                    res.json(envelope)
                    logger.trace('Api[%s] query %dms (%d/%d items)', name, Date.now() - t0, items.length, total)
                    maybeWarnWide({ logger, endpoint: name, envelope, req })

                    // POST queries aren't disk-cached. The reverse proxy
                    // failover scheme is URL-based (cache file path =
                    // request URL), but POST has no URL-equivalent for
                    // its body. Cacheable queries should use GET — which
                    // the SDK's list() does by default. Body-only queries
                    // are by definition complex/non-canonicalizable so
                    // they're treated as live-only.
                } catch (err) {
                    const status = err instanceof ExpandError ? err.status : 500
                    if (status >= 500) {
                        logger.error('Api[%s] query error (%dms): %s', name, Date.now() - t0, err.message)
                    } else {
                        logger.debug('Api[%s] query rejected (%dms): %s', name, Date.now() - t0, err.message)
                    }
                    res.status(status).json({ error: err.message })
                }
            })

            // GET /entities/subscribe — open an SSE stream. Each subsequent
            // process cycle (file-watcher fired OR programmatic API write)
            // emits create/update/delete events for entities matching the
            // subscription's filter and the endpoint's scope. Heartbeats
            // every 25s keep proxies happy. Connection close cleans up.
            router.get('/entities/subscribe', allow('subscribe'), auth, (req, res) => {
                let filterFn = null
                let expand = null
                try {
                    const parsed = parseQueryString(req.query)
                    if (Object.keys(parsed.filter).length) filterFn = sift(parsed.filter)
                    expand = parsed.expand?.length ? parsed.expand : null
                    // Subject `expand` to the same caps as one-shot reads
                    // so a misconfigured subscriber can't open a session
                    // that's expensive to dispatch on every cycle.
                    if (expand) {
                        const { maxPaths, maxDepth } = expandLimits(runtime)
                        if (expand.length > maxPaths) {
                            throw new Error(`expand has ${expand.length} paths, exceeds maxPaths (${maxPaths})`)
                        }
                        for (const p of expand) {
                            const parts = p.split('.').filter(Boolean)
                            if (parts.length > maxDepth) {
                                throw new Error(`Path '${p}' has length ${parts.length}, exceeds maxDepth (${maxDepth})`)
                            }
                        }
                    }
                } catch (err) {
                    return res.status(400).json({ error: err.message })
                }

                sseInit(res)
                const subscriptionId = `sub_${Date.now()}_${++subscriptionCounter}`
                sseSend(res, 'init', { subscriptionId, endpoint: name, expand: expand ?? [] })

                // Heartbeat — silent enough to not confuse the SDK but
                // frequent enough that idle proxies don't kill the
                // connection.
                const heartbeat = setInterval(() => sseSend(res, 'heartbeat', {}), 25_000)
                if (typeof heartbeat.unref === 'function') heartbeat.unref()

                subscriptions.set(subscriptionId, {
                    endpointName: name,
                    scope: query,
                    filter: filterFn,
                    allowedFields,
                    expand,
                    res,
                })

                // When `expand` is requested, also register a graph
                // subscription with the engine's refs index so mutations
                // to entities at any depth within the expansion graph
                // trigger a re-expand + emit. Without expand, the
                // existing journal-walk loop covers all cases (it emits
                // when the mutated entity itself matches the filter).
                let graphSub = null
                if (expand && runtime.refs?.subscribeGraph) {
                    graphSub = runtime.refs.subscribeGraph({
                        filter: (entity) => {
                            // Combine the endpoint's scope and the
                            // subscription's filter, exactly the gates
                            // the no-expand path applies.
                            if (query && !query(entity)) return false
                            if (filterFn && !filterFn(entity)) return false
                            return true
                        },
                        expand,
                        onAffected: async ({ root, mutated }) => {
                            try {
                                const expanded = await expandAndProject(
                                    root, expand, runtime, findEntities,
                                )
                                const projected = allowedFields
                                    ? _.pick(expanded, allowedFields)
                                    : expanded
                                sseSend(res, 'update', {
                                    id: root.id,
                                    entity: projected,
                                    // Surface what triggered the update
                                    // so consumers can debug, log, or
                                    // skip self-triggered events.
                                    causedBy: mutated?.id ?? null,
                                })
                                logger.trace(
                                    'Api subscription %s graph update: root=%s caused-by=%s',
                                    subscriptionId, root.id, mutated?.id ?? '<none>',
                                )
                            } catch (err) {
                                logger.warn(
                                    'Api[%s] graph subscription dispatch failed for sub %s: %s',
                                    name, subscriptionId, err.message,
                                )
                            }
                        },
                    })
                }

                req.on('close', () => {
                    clearInterval(heartbeat)
                    subscriptions.delete(subscriptionId)
                    graphSub?.dispose()
                    logger.debug('Api[%s] subscription closed: %s', name, subscriptionId)
                })

                logger.debug(
                    'Api[%s] subscription opened: %s%s',
                    name, subscriptionId,
                    expand ? ` (expand=[${expand.join(',')}])` : '',
                )
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
                        // useRenderer tags an unrenderable entity (no layout)
                        // with err.status = 422; everything else is a 500.
                        res.status(err.status ?? 500).json({ error: err.message })
                    }
                }
            })

            app.use(`${base}/${name}`, router)
            // Mirror MCP's boot log shape — same three reachability states.
            const authLabel = ep.token
                ? 'token'
                : (ep.allowRemote ? 'public, REMOTE OPEN' : 'public, loopback-only')
            // Full URL when the engine owns the listener (port is known).
            // Falls back to the path alone for external-app setups.
            const location = runtime.options.port
                ? `http://localhost:${runtime.options.port}${base}/${name}`
                : `${base}/${name}`
            logger.info('Api endpoint mounted: %s (ops=[%s] [%s])',
                location, [...allowedOps].join(','), authLabel)
        }

        // MCP tool registrations. MCP is in-process: whoever can reach
        // the /mcp transport already controls the engine. So the tool
        // surface mirrors the *admin*-
        // shape (list/query/read/update/delete/render) without the HTTP
        // endpoint's token gate or query scope — the catalog is global.
        // Tools register once (not per HTTP endpoint); plugin-author
        // facing API is `mcp.simpleTool` from the substrate.
        const mcp = runtime.options.mcp
        if (mcp) {
            const { render: mcpRender } = useRenderer(runtime, { defaultTimeout: globalRenderTimeout })

            // Helpers — small enough to inline, but factoring them keeps
            // each tool body to a single shape: parse → query → return.
            const ok = (data) => ({
                content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
            })
            const fail = (msg) => ({
                isError: true,
                content: [{ type: 'text', text: msg }],
            })

            mcp.simpleTool(
                'mikser_api_list_entities',
                'List entities from mikser\'s catalog with optional filter / sort / projection. Use this for "show me all documents about X" or "what entities are in collection Y." Returns paginated results in the same envelope shape as the HTTP /entities endpoint. Pass `expand` to inline referenced entities (per ADR-0007): paths like "author", "author.organization", or "sections.*.image" walk through $-keyed reference fields and replace the ref string with the resolved entity in one round-trip.',
                {
                    filter: z.record(z.any()).optional().describe('Mongo-style filter (sift-compatible). Defaults to no filter — every entity.'),
                    sort:   z.record(z.number()).optional().describe('Sort spec, e.g. { "meta.date": -1, "name": 1 }.'),
                    fields: z.array(z.string()).optional().describe('Dotted-path projection. Omit to return whole entities.'),
                    skip:   z.number().int().min(0).optional().describe('Skip N items.'),
                    limit:  z.number().int().min(1).max(100).optional().describe('Page size, defaults to 25, capped at 100.'),
                    expand: z.array(z.string()).optional().describe('Inline-expand referenced entities. Each entry is a dotted path that walks through $-keyed reference fields, replacing the ref string with the resolved entity. Use `*` for array iteration. Examples: ["author"], ["author.organization"], ["sections.*.image"]. Default caps: maxDepth 5, maxPaths 20, maxResolved 100 per request.'),
                },
                async ({ filter, sort, fields, skip, limit, expand }) => {
                    try {
                        const effectiveLimit = Math.min(100, Math.max(1, limit ?? 25))
                        const effectiveSkip = Math.max(0, skip ?? 0)
                        let { items, total } = await runQuery({
                            filter: filter ?? {},
                            sort, fields,
                            skip: effectiveSkip,
                            limit: effectiveLimit,
                            scope: null,
                            findEntities,
                        })
                        items = await Promise.all(items.map(item =>
                            expandAndProject(item, expand, runtime, findEntities),
                        ))
                        return ok({
                            items, total,
                            skip: effectiveSkip,
                            limit: effectiveLimit,
                            hasNext: effectiveSkip + effectiveLimit < total,
                        })
                    } catch (err) {
                        logger.error('MCP mikser_api_list_entities error: %s', err.message)
                        return fail(err.message)
                    }
                },
            )

            mcp.simpleTool(
                'mikser_api_read_entity',
                'Read a single entity by its catalog id (e.g. "/documents/about.md"). Returns the full entity record or null when not found. Pass include: ["content"] to also fetch the source file content from disk — useful for reading a layout template, document frontmatter+body, or any text-format source without dropping out to the filesystem. Pass `expand` to inline referenced entities in the response (per ADR-0007): paths like "author", "author.organization", or "sections.*.image" replace the ref string with the resolved entity in one trip.',
                {
                    id: z.string().describe('Catalog id of the entity to read.'),
                    include: z.array(z.enum(['content'])).optional().describe('Optional list of extra fields to populate. Currently only "content" is supported: reads the file at entity.uri and attaches it as .content (text formats only — md, html, yml, liquid, hbs, eta, json, css, js, svg, xml, mjml).'),
                    expand: z.array(z.string()).optional().describe('Inline-expand referenced entities. Each entry is a dotted path through $-keyed reference fields. Use `*` for array iteration. Examples: ["author"], ["author.organization"], ["sections.*.image"]. Same caps as list_entities.'),
                },
                async ({ id, include, expand }) => {
                    try {
                        if (!id) return fail('id is required')
                        const { items } = await runQuery({
                            filter: { id },
                            skip: 0, limit: 1,
                            scope: null,
                            findEntities,
                        })
                        let entity = items[0]
                        if (!entity) return ok(null)

                        entity = await expandAndProject(entity, expand, runtime, findEntities)

                        if (include?.includes('content') && entity.uri) {
                            // Heuristic — read content only for text-like
                            // formats. Binary types (png, pdf, mp4, etc.)
                            // get a marker so the caller knows to use a
                            // different tool (mikser_api_render, or fetch
                            // directly) rather than expecting bytes back.
                            const TEXT_EXTS = new Set([
                                'md', 'markdown', 'html', 'htm', 'xhtml',
                                'yml', 'yaml', 'json', 'jsonc',
                                'txt', 'csv', 'tsv',
                                'css', 'js', 'mjs', 'cjs', 'ts',
                                'liquid', 'hbs', 'handlebars', 'eta', 'mustache',
                                'svg', 'xml', 'mjml', 'rss', 'atom',
                                'aml',
                            ])
                            const ext = path.extname(entity.uri).slice(1).toLowerCase()
                            if (TEXT_EXTS.has(ext)) {
                                try {
                                    entity.content = await readFile(entity.uri, 'utf8')
                                } catch (err) {
                                    entity.contentError = err.message
                                }
                            } else {
                                entity.contentSkipped = `Non-text format (.${ext}). Use mikser_api_render to materialize output or read the file directly at entity.uri.`
                            }
                        }

                        return ok(entity)
                    } catch (err) {
                        logger.error('MCP mikser_api_read_entity error: %s', err.message)
                        return fail(err.message)
                    }
                },
            )

            mcp.simpleTool(
                'mikser_api_update_entity',
                'Create or update a content file inside a mikser collection. The file is written to disk and the next lifecycle cycle picks it up — same path the HTTP PUT /entities endpoint takes. Use this to author new documents, layouts, or other content from AI.',
                {
                    collection:   z.string().describe('Collection name (e.g. "documents", "layouts").'),
                    relativePath: z.string().describe('Path relative to the collection folder (e.g. "blog/2026-06-02-launch.md").'),
                    content:      z.string().optional().describe('File content to write. Frontmatter is parsed by the corresponding plugin.'),
                },
                async ({ collection, relativePath, content = '' }) => {
                    try {
                        await useCollection(runtime, collection).write(relativePath, content)
                        return ok({ ok: true, collection, relativePath })
                    } catch (err) {
                        logger.error('MCP mikser_api_update_entity error: %s', err.message)
                        return fail(err.message)
                    }
                },
            )

            mcp.simpleTool(
                'mikser_api_delete_entity',
                'Remove a content file from a mikser collection. Mirrors HTTP DELETE /entities — deletes the source file, and the next lifecycle cycle prunes its rendered outputs from the manifest.',
                {
                    collection:   z.string().describe('Collection name.'),
                    relativePath: z.string().describe('Path relative to the collection folder.'),
                },
                async ({ collection, relativePath }) => {
                    try {
                        await useCollection(runtime, collection).remove(relativePath)
                        return ok({ ok: true, collection, relativePath })
                    } catch (err) {
                        logger.error('MCP mikser_api_delete_entity error: %s', err.message)
                        return fail(err.message)
                    }
                },
            )

            mcp.simpleTool(
                'mikser_api_render',
                'Render a transient entity through the engine pipeline (parse → layouts → resources → render → postprocess) and return the FINAL produced bytes. Use this for "preview this layout against this data" without writing the entity to disk. The returned bytes are the pipeline\'s final output — PDF for a `*.html-pdf.*` layout, MJML-derived HTML for `*.html-mjml.*`, etc. Set options.save=false to skip the disk write; options.catalog=false to prune the catalog row after rendering. For a clickable preview URL instead of raw bytes, use mikser_preview_render (preview plugin).',
                {
                    entity:  z.record(z.any()).describe('Entity shape with at least { id, collection } and any meta/content the renderer needs.'),
                    options: z.record(z.any()).optional().describe('Renderer options: { save: false, catalog: false, renderer: "...", postprocessor: "..." }.'),
                },
                async ({ entity = {}, options = {} }) => {
                    try {
                        const { output, entity: rendered } = await mcpRender(entity, options)
                        const result = output?.result
                        if (result == null) {
                            return ok({ ok: true, entity: rendered, output: null })
                        }
                        const mime = mimeForEntity(rendered) ?? 'application/octet-stream'
                        if (Buffer.isBuffer(result)) {
                            return {
                                content: [{
                                    type: 'resource',
                                    resource: {
                                        uri: `mikser://render/${rendered.id ?? 'inline'}`,
                                        mimeType: mime,
                                        blob: result.toString('base64'),
                                    },
                                }],
                            }
                        }
                        // String result — most renderers (HTML, MJML, etc.).
                        return {
                            content: [{
                                type: 'resource',
                                resource: {
                                    uri: `mikser://render/${rendered.id ?? 'inline'}`,
                                    mimeType: mime,
                                    text: String(result),
                                },
                            }],
                        }
                    } catch (err) {
                        logger.error('MCP mikser_api_render error: %s', err.message)
                        return fail(err.message)
                    }
                },
            )

            logger.debug('MCP tools registered: mikser_api_{list_entities,read_entity,update_entity,delete_entity,render} (api plugin)')
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
                // Subscriptions with `expand` get their updates via the
                // runtime.refs graph dispatch (which emits the
                // re-expanded entity on any mutation within the
                // expansion graph, including the root itself). Skip
                // them here to avoid double-emission.
                if (sub.expand) continue
                if (sub.scope && !sub.scope(entity)) continue
                if (sub.filter && !sub.filter(entity)) continue
                // Apply the endpoint's field projection to SSE payloads
                // too — so live updates leak no more than list/query
                // responses do.
                const projected = sub.allowedFields
                    ? _.pick(entity, sub.allowedFields)
                    : entity
                const payload = operation === OPERATION.DELETE
                    ? { id: entity.id }
                    : { id: entity.id, entity: projected }
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
        //
        // For expand-cached queries the precise eviction in the GET
        // handler's onAffected callback has already happened (one
        // subscribeGraph dispatch per affected cache file). This block
        // is the safety net for cached queries WITHOUT expand. We also
        // dispose any straggler cache subscriptions for this endpoint
        // so they don't leak past the rebuild (next read re-registers).
        if (anyChange && cachedEndpoints.length > 0 && runtime.options.outputFolder) {
            for (const ep of cachedEndpoints) {
                await clearEndpointCache({
                    outputFolder: runtime.options.outputFolder,
                    base: apiBase,
                    name: ep.name,
                    logger,
                })
                const prefix = `${ep.name}/`
                for (const key of [...cacheSubscriptions.keys()]) {
                    if (!key.startsWith(prefix)) continue
                    cacheSubscriptions.get(key)?.dispose()
                    cacheSubscriptions.delete(key)
                }
            }
        }
    })
}

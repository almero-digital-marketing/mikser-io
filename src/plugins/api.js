import path from 'node:path'
import { access, writeFile, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import _ from 'lodash'
import sift from 'sift'
import { resolveAuth, requireAuth, hasCapability, reachabilityOf } from '../auth.js'
import { useRenderer } from '../render.js'
import { mimeForEntity, isLoopback, ExpandError, useCollection } from '../utils.js'
import { registerRoute } from '../routes.js'
import { queryEntities, queryContext } from '../catalog.js'
import { subscribe } from '../subscriptions.js'

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

// Per-cache-file query filter tracking. cacheKey → array of filter
// objects (or null sentinel for unserializable filters) that the
// request consulted while building this cache file. At catalog
// mutation time, sift each filter against the mutated entity; on
// match, evict that single cache file. Replaces the coarse "wipe
// the entire endpoint directory" pass for non-expand queries.
//
// In-memory only — on process restart the map is empty and the
// fallback in onFinalize coarse-clears any cache that doesn't have
// recorded filters. Acceptable: restarts are rare, coarse-clear is
// correct, and the next read re-warms with fresh filter tracking.
//
// Same key shape as cacheSubscriptions: `${endpointName}/${cacheName}`.
const cacheFilters = new Map()

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

export function api(options = {}) {
    return ({
        runtime,
        onLoaded,
        onFinalize,
        useLogger,
        useJournal,
        constants: { OPERATION },
    }) => {
    // Shared between onLoaded (populates) and onFinalize (consumes).
    // Hoisted so the lifecycle hooks see the same registry; the body
    // inside onLoaded is what actually fills it in based on
    // `options.endpoints`.
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

        const endpoints = options.endpoints
        if (!endpoints || !Object.keys(endpoints).length) {
            logger.warn('Api plugin loaded but no endpoints configured (pass { endpoints: {...} } to api()) — nothing to mount')
            return
        }

        const { default: express } = await import('express').catch(() => {
            throw new Error('Express is required for the api plugin — run: npm install express')
        })

        apiBase = options.base ?? '/api'
        const base = apiBase   // alias so existing local references still work
        const globalPageSize = options.pageSize ?? 10
        const globalRenderTimeout = options.renderTimeout ?? 30_000
        // express.json() defaults to 100kb, which is a sensible ceiling for a
        // REST body and much too small for `render`: the caller posts an entity
        // whose meta carries everything the layout needs, and a mail template
        // given a list of a customer's recent bookings runs 150–400kb. That
        // exceeds the default without being remotely large.
        //
        // The failure is quiet at the wrong end. The renderer never sees the
        // request — raw-body rejects it while reading the stream — so nothing
        // appears in mikser's log, and the caller gets an HTML error page for a
        // JSON API. On gpoint that was 168 renders lost in under two hours,
        // including the customer booking confirmations, and it looked from the
        // outside like the mail was broken rather than the render.
        //
        // 2mb, and configurable per endpoint like every other limit here. Not
        // unbounded: a token-gated endpoint is still a body an attacker can
        // choose the size of.
        const globalBodyLimit = options.bodyLimit ?? '2mb'

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

            // Nothing is served until the first build cycle has finished.
            //
            // The server binds at the end of the loaded phase — before
            // process() has emitted an entity — so without this the endpoint
            // spends the whole first build answering against an empty catalog.
            // Renders fail outright (the layouts registry fills during
            // process()), and reads are worse than that: a list returns
            // whichever subset exists at that instant, which is a wrong answer
            // wearing a 200. A consumer seeding its routes from that gets zero
            // routes and renders blank pages.
            //
            // 503, not 4xx, and Retry-After: this is the one honest status
            // here. It says the request was fine and the server was not, which
            // is exactly the case, and it is the status every HTTP client
            // already knows to retry. A 422 or a 500 invites the caller to
            // treat a transient build as a permanent defect and give up.
            //
            // The window is normally sub-second and easy to miss. It stretches
            // whenever the cache has to be rebuilt from scratch — most notably
            // after an engine upgrade, where the schema stamp no longer matches
            // and the catalog is wiped before the rebuild.
            router.use((req, res, next) => {
                if (runtime.ready) return next()
                res.set('Retry-After', '1')
                res.status(503).json({
                    error: 'Mikser is still building — the catalog is not ready yet',
                    ready: false,
                })
            })

            router.use(express.json({ limit: ep.bodyLimit ?? globalBodyLimit }))

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

            // The endpoint's scope. A sift filter is the form to prefer —
            // queryEntities merges it into the WHERE clause, so the endpoint
            // never materializes rows it would only reject. A function still
            // works and is applied post-fetch, which costs every row the
            // caller's filter matched.
            const query = (typeof ep.query === 'function' || (ep.query && typeof ep.query === 'object'))
                ? ep.query
                : null

            // Principal-bound scope (ADR-0012). A credential may carry its
            // OWN row filter — "gpoint-web sees only /web" — which is ANDed
            // with the endpoint's, never ORed: a credential can narrow what
            // an endpoint exposes, never widen it. That direction is the
            // whole safety property, so the combination is $and and there is
            // no code path that produces anything else.
            //
            // Both halves stay sift OBJECTS so queryEntities can push them
            // into the WHERE clause. A function scope is applied post-fetch
            // — the form that pinned a box at 111% CPU on 1,367 entities —
            // so a principal scope is REQUIRED to be an object, and a
            // function endpoint scope keeps its post-fetch path while the
            // principal's half still pushes down.
            const scopeFor = (req) => {
                const principal = req.principal?.scope
                if (!principal) return { query, matchesScope, principalScoped: false }
                if (typeof principal !== 'object' || Array.isArray(principal)) {
                    throw new Error(
                        'api: a principal scope must be a sift filter object — ' +
                        'a function cannot be pushed into the query and would be ' +
                        'applied to every row the caller matched'
                    )
                }
                // queryEntities takes ONE scope, so the two halves have to
                // become one value of a form it understands:
                //
                //   object endpoint scope → { $and: [ … ] }, fully pushed
                //     into the WHERE clause. The form to prefer, and the
                //     one gpoint uses.
                //   function endpoint scope → one combined function, applied
                //     post-fetch. No pushdown, but that endpoint already
                //     chose post-fetch; the principal's half just narrows it
                //     further. Returning the object here instead would
                //     SILENTLY DROP the endpoint's own filter.
                const principalMatches = sift(principal)
                const merged = typeof query === 'function'
                    ? (entity) => query(entity) && principalMatches(entity)
                    : query
                        ? { $and: [query, principal] }
                        : principal
                return {
                    query: merged,
                    matchesScope: matchesScope
                        ? (entity) => matchesScope(entity) && principalMatches(entity)
                        : principalMatches,
                    principalScoped: true,
                }
            }

            // The same scope as a PREDICATE. Two paths hold one entity in
            // hand and have no query to push a filter into — admitting a
            // POST /render body, and the graph-subscription filter — so
            // they have to test it directly. Calling `query` there works
            // only while the scope is a function; the sift-object form
            // this endpoint now accepts is not callable, and the failure
            // is a bare `query is not a function` surfacing from whichever
            // route touched it first.
            const matchesScope = typeof ep.query === 'function'
                ? ep.query
                : query
                    ? sift(query)
                    : null
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

            // Uniform mikser auth rule (matches what mikser-io-mcp uses
            // for its endpoints):
            //   - Token presented and matches → allow (from anywhere)
            //   - Token presented and doesn't match → 401
            //   - No token presented → require loopback unless allowRemote
            //
            // Endpoints with a token are still reachable from loopback
            // without the token — the "trusted local host" model. To
            // require the token everywhere, run mikser bound to a
            // non-loopback interface only (or behind a proxy that
            // doesn't forward loopback origin).
            // The uniform rule now lives in the engine (ADR-0012), so this
            // endpoint, mcp's and forms' cannot drift apart again. `auth`
            // takes any verifier — a list of them, HTTP Basic, OAuth — while
            // `token` keeps the trusted-local-host model it always had.
            const verifier      = resolveAuth(ep.auth ?? ep.token)
            const trustLoopback = !ep.auth && !!ep.token
            const auth = requireAuth(verifier, { allowRemote: ep.allowRemote, trustLoopback, logger })

            // ORDER IS LOAD-BEARING: every route lists `auth` BEFORE
            // `allow(op)`. The capability half reads req.principal, which
            // only exists once auth has run — with the old order it read
            // undefined, and an undefined principal passes every check.
            // That is a silent bypass, not a failure, so it stays written
            // down rather than remembered.
            //
            // Reach is the INTERSECTION of two independent limits: what the
            // endpoint exposes, and what the caller's credential carries. A
            // credential declaring `api:delete` still cannot delete on an
            // endpoint whose `operations` omits it, and a bare token (which
            // declares nothing, capabilities === null) is bounded by the
            // endpoint alone — which is exactly how every endpoint behaved
            // before this existed.
            const allow = (op) => (req, res, next) => {
                if (!allowedOps.has(op)) {
                    return res.status(403).json({
                        error: `Operation '${op}' is not allowed on endpoint '${name}'`,
                    })
                }
                if (!hasCapability(req.principal, `api:${op}`)) {
                    return res.status(403).json({
                        error: `Your credential does not carry 'api:${op}'`,
                    })
                }
                next()
            }

            // useRenderer (from ../render.js) is the transport-agnostic
            // render primitive — HTTP endpoints, mikser-io-mcp's
            // mikser_render tool, and library callers all share the
            // exact same batching/timeouts/error semantics. One renderer
            // per endpoint so per-endpoint renderTimeout overrides land.
            const { render } = useRenderer(runtime, { defaultTimeout: renderTimeout })

            router.get('/entities', auth, allow('list'), async (req, res) => {
                const t0 = Date.now()
                try {
                    const parsed = parseQueryString(req.query)
                    const limit = Math.min(100, Math.max(1, parsed.limit ?? pageSize))
                    const skip = parsed.skip ?? (parsed.page - 1) * limit

                    // queryEntities performs the full sift+expand+project
                    // chain (ADR-0007 B1 / A3) so wire shape is normalized
                    // even when the caller didn't request expand. fields
                    // projection is applied after expand so dotted-path
                    // picks see the resolved structure.
                    //
                    // Wrap in queryContext.run so the catalog records
                    // every filter the request consulted into capturedQueries.
                    // After the cache is written below, capturedQueries
                    // becomes the per-cache-file dep list used for precise
                    // eviction on mutation.
                    const capturedQueries = []
                    const queryTrack = { query(filter) { capturedQueries.push(filter) } }
                    const { items, total } = await queryContext.run({ track: queryTrack }, () => queryEntities({
                        filter: parsed.filter,
                        sort: parsed.sort,
                        fields: resolveFields(parsed.fields),
                        skip,
                        limit,
                        expand: parsed.expand,
                        scope: scopeFor(req).query,
                    }))

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
                    // NEVER cache a principal-scoped response. The cache
                    // mirrors the request URL into the OUTPUT folder, where
                    // nginx try_files serves it without ever reaching this
                    // process — so one caller's scoped rows would be handed
                    // to every later caller of the same URL, unauthenticated.
                    // The cache key is endpoint+querystring by design (it has
                    // to match what nginx sees), so it cannot be salted with
                    // the principal; the only safe answer is not to write.
                    if (cacheEnabled && scopeFor(req).principalScoped) {
                        logger.debug(
                            'Api[%s] response not cached — caller %j carries its own scope',
                            name, req.principal?.subject ?? 'unknown')
                    }
                    if (cacheEnabled && !scopeFor(req).principalScoped && runtime.options.outputFolder) {
                        const url = req.originalUrl || req.url || ''
                        const qIdx = url.indexOf('?')
                        const rawQueryString = qIdx >= 0 ? url.slice(qIdx + 1) : ''
                        const cacheName = cacheNameForQueryString(rawQueryString)
                        const cacheKey = `${name}/${cacheName}`
                        // Fire-and-forget — the response is already sent.
                        writeQueryCache({
                            outputFolder: runtime.options.outputFolder,
                            base: apiBase,
                            name,
                            cacheName,
                            envelope,
                            logger,
                        }).catch(() => {})

                        // Record the filters this request consulted so
                        // the onFinalize hook below can evict ONLY this
                        // cache file when a mutation matches any of them.
                        cacheFilters.set(cacheKey, capturedQueries.slice())

                        // Precise invalidation for expand-cached queries
                        // (ADR-0007 B9). Register a graph subscription
                        // against the same filter + expand; on any
                        // mutation in the expansion graph, the
                        // subscription evicts THIS cache file and
                        // disposes itself. Non-expand queries get
                        // filter-based precise invalidation via the
                        // cacheFilters map populated above.
                        if (parsed.expand?.length && runtime.refs?.subscribeGraph) {
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
                                    if (matchesScope && !matchesScope(entity)) return false
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
                        logger.error(
                            'Api[%s] list error (%dms): %s\n%s',
                            name, Date.now() - t0, err.message, err.stack || '(no stack)',
                        )
                    } else {
                        logger.debug('Api[%s] list rejected (%dms): %s', name, Date.now() - t0, err.message)
                    }
                    res.status(status).json({ error: err.message })
                }
            })

            // POST /entities/query — body-based query for anything that
            // doesn't fit cleanly in a URL: $and/$or, nested operators,
            // regex, projections, etc. Same shape as a Mongo find.
            router.post('/entities/query', auth, allow('list'), async (req, res) => {
                const t0 = Date.now()
                try {
                    const { filter = {}, sort, fields, expand, page: rawPage = 1, limit: rawLimit, skip: rawSkip } = req.body ?? {}
                    const limit = Math.min(100, Math.max(1, rawLimit ?? pageSize))
                    const skip = rawSkip ?? (Math.max(1, parseInt(rawPage) || 1) - 1) * limit

                    const { items, total } = await queryEntities({
                        filter, sort,
                        fields: resolveFields(fields),
                        skip, limit,
                        expand,
                        scope: scopeFor(req).query,
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
            //
            // Dispatch lives in core (src/subscriptions.js). This handler
            // just translates HTTP/query-string into a subscribe() call
            // whose onChange writes SSE frames to `res`. subscribe()
            // throws on invalid input; we wrap it so the error becomes a
            // 400 BEFORE SSE headers are sent.
            router.get('/entities/subscribe', auth, allow('subscribe'), (req, res) => {
                let filterFn = null
                let expand = null
                try {
                    const parsed = parseQueryString(req.query)
                    if (Object.keys(parsed.filter).length) filterFn = sift(parsed.filter)
                    expand = parsed.expand?.length ? parsed.expand : null
                } catch (err) {
                    return res.status(400).json({ error: err.message })
                }

                const subscriptionId = `sub_${Date.now()}_${++subscriptionCounter}`

                // Bridge core subscribe() to SSE frames. The same
                // onChange handles every event — DELETE has just an id,
                // graph-dispatched updates carry a `causedBy`, plain
                // updates don't. Register BEFORE sseInit so a rejection
                // from subscribe() can still return 400 cleanly with no
                // headers flushed. onChange won't fire mid-handler —
                // dispatchers run on onFinalize, never inside a request.
                let sub
                try {
                    sub = subscribe({
                        scope:  scopeFor(req).query,
                        filter: filterFn,
                        expand,
                        onChange: ({ operation, entity, causedBy }) => {
                            const projected = allowedFields
                                ? _.pick(entity, allowedFields)
                                : entity
                            const payload = operation === 'delete'
                                ? { id: entity.id }
                                : causedBy !== undefined
                                    ? { id: entity.id, entity: projected, causedBy }
                                    : { id: entity.id, entity: projected }
                            sseSend(res, operation, payload)
                            logger.trace(
                                'Api subscription %s %s: %s%s',
                                subscriptionId, operation, entity.id,
                                causedBy ? ` (caused-by=${causedBy})` : '',
                            )
                        },
                    })
                } catch (err) {
                    return res.status(400).json({ error: err.message })
                }

                sseInit(res)
                sseSend(res, 'init', { subscriptionId, endpoint: name, expand: expand ?? [] })

                // Heartbeat — silent enough to not confuse the SDK but
                // frequent enough that idle proxies don't kill the
                // connection.
                const heartbeat = setInterval(() => sseSend(res, 'heartbeat', {}), 25_000)
                if (typeof heartbeat.unref === 'function') heartbeat.unref()

                req.on('close', () => {
                    clearInterval(heartbeat)
                    sub.dispose()
                    logger.debug('Api[%s] subscription closed: %s', name, subscriptionId)
                })

                logger.debug(
                    'Api[%s] subscription opened: %s%s',
                    name, subscriptionId,
                    expand ? ` (expand=[${expand.join(',')}])` : '',
                )
            })

            router.put('/entities', auth, allow('update'), async (req, res) => {
                try {
                    const { collection, relativePath, content = '' } = req.body
                    await useCollection(runtime, collection).write(relativePath, content)
                    res.status(202).json({ ok: true })
                } catch (err) {
                    logger.error('Api[%s] update error: %s', name, err.message)
                    res.status(/Unknown collection/.test(err.message) ? 400 : 500).json({ error: err.message })
                }
            })

            router.delete('/entities', auth, allow('delete'), async (req, res) => {
                try {
                    const { collection, relativePath } = req.body
                    await useCollection(runtime, collection).remove(relativePath)
                    res.status(202).json({ ok: true })
                } catch (err) {
                    logger.error('Api[%s] delete error: %s', name, err.message)
                    res.status(/Unknown collection/.test(err.message) ? 400 : 500).json({ error: err.message })
                }
            })

            router.post('/render', auth, allow('render'), async (req, res) => {
                // Hoisted so the catch can name WHICH entity failed. A
                // render that throws before this is assigned is itself the
                // finding — it means the body never parsed.
                let renderId
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
                    renderId = entityShape.id
                    // When the endpoint declares a scope, reject anything
                    // outside it BEFORE pushing through the renderer.
                    const { matchesScope: inScope } = scopeFor(req)
                    if (inScope && !inScope(entityShape)) {
                        return res.status(403).json({ error: 'Entity is outside this endpoint\'s scope' })
                    }
                    const { output, entity } = await render(entityShape, options)
                    await sendRenderOutput(res, output, entity)
                } catch (err) {
                    // useRenderer tags an unrenderable entity (no layout)
                    // with err.status = 422; everything else is a 500.
                    const status = err.status ?? 500
                    if (status >= 500) {
                        // The stack, not just the message — and this is the
                        // one route where that is not optional. A render
                        // reaches here through a renderer, a postprocessor
                        // chain and any template helper they call, so the
                        // message is routinely a bare TypeError from a frame
                        // the operator cannot name. Logging `{error: message}`
                        // alone leaves bisecting deployed versions as the only
                        // way to find out where it came from, which is exactly
                        // as expensive as it sounds. The id says which entity;
                        // `undefined` there means the body never parsed.
                        logger.error(
                            'Api[%s] render error for %s: %s\n%s',
                            name, renderId ?? '(no id in body)', err.message,
                            err.stack || '(no stack)',
                        )
                    } else {
                        logger.debug(
                            'Api[%s] render rejected for %s (%d): %s',
                            name, renderId ?? '(no id in body)', status, err.message,
                        )
                    }
                    if (!res.headersSent) {
                        res.status(status).json({ error: err.message })
                    }
                }
            })

            app.use(`${base}/${name}`, router)
            // Reachability → registry enum + the louder bracket label.
            // 'public' here means a deliberate unauthenticated exposure
            // (allowRemote), so we keep the REMOTE OPEN warning in the
            // log. streaming:true — the `subscribe` op holds an open SSE
            // stream, so a facade must not buffer this route.
            const reachability = ep.token ? 'token' : (ep.allowRemote ? 'public' : 'loopback')
            const authLabel = ep.token
                ? 'token'
                : (ep.allowRemote ? 'public, REMOTE OPEN' : 'loopback-only')
            registerRoute({
                path:         `${base}/${name}`,
                plugin:       'api',
                reachability,
                streaming:    allowedOps.has('subscribe'),
                label:        'Api endpoint',
                detail:       `(ops=[${[...allowedOps].join(',')}])`,
                authLabel,
            })
        }

    })

    // Cache-invalidation dispatcher. Once per cycle, walk the journal
    // mutations and evict only the cache files whose recorded filters
    // match the mutated entity. Replaces the previous coarse "wipe the
    // endpoint directory on any change" pass — works for both expand
    // and non-expand cached queries.
    //
    // Expand-cached queries also get evicted earlier via the
    // subscribeGraph callback registered in the GET handler. Hitting
    // an already-evicted file via rm is harmless (force:true).
    //
    // Cache files written before this process started (or in cycles
    // before queryContext was available) have no entry in cacheFilters
    // — they're covered by the safety-net pass at the end which clears
    // any leftover files for endpoints that had ANY mutation this
    // cycle. Coarse but bounded, and re-warms naturally.
    //
    // Hook onFinalize, NOT onFinalized — journal.js registers its own
    // clearJournal callback on onFinalized at module load, which runs
    // before plugin onFinalized hooks. By Finalize we still have the
    // cycle's journal entries; by Finalized they're already gone.
    onFinalize(async (signal) => {
        if (!cachedEndpoints.length || !runtime.options.outputFolder) return
        const logger = useLogger()

        // Collect this cycle's mutated entities. Multiple mutations to
        // the same id (rare but possible) collapse to the latest entity
        // payload — exactly what we want for filter matching.
        const mutations = []
        for await (const { entity } of useJournal(
            'Api cache invalidation',
            [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
            signal,
        )) {
            if (entity?.id) mutations.push(entity)
        }
        if (mutations.length === 0) return

        // Precise eviction: for each tracked cache file, check whether
        // any of its recorded filters matches any mutation. On match,
        // evict the file, drop its filter record, dispose any sibling
        // subscribeGraph handle.
        const evicted = new Set()
        for (const [cacheKey, filters] of cacheFilters) {
            const matched = filters.some(filter =>
                // Null filter = unserializable predicate that got into
                // the cache — conservative: evict on any mutation.
                !filter || mutations.some(entity => sift(filter)(entity))
            )
            if (!matched) continue

            const slashIdx = cacheKey.indexOf('/')
            const endpointName = cacheKey.slice(0, slashIdx)
            const cacheName = cacheKey.slice(slashIdx + 1)
            await evictCacheFile({
                outputFolder: runtime.options.outputFolder,
                base: apiBase,
                name: endpointName,
                cacheName,
                logger,
            })
            cacheFilters.delete(cacheKey)
            cacheSubscriptions.get(cacheKey)?.dispose()
            cacheSubscriptions.delete(cacheKey)
            evicted.add(cacheKey)
        }

        // Safety net: cache files written before this process started
        // (or before any tracking was wired) have no cacheFilters entry
        // — clear them coarsely per endpoint that saw a mutation this
        // cycle. Once a request re-warms a file, future invalidations
        // hit the precise path above.
        for (const ep of cachedEndpoints) {
            // Skip endpoints that already had a precise eviction —
            // their other cache files (if any) we have no info about,
            // but the most common case is "one cached query per
            // endpoint" so this conservative skip keeps the warm cache
            // warm in the common case. If you have many cached queries
            // per endpoint and rely on legacy untracked cache files,
            // restart mikser to fully reset.
            const hadPrecise = [...evicted].some(key => key.startsWith(`${ep.name}/`))
            if (hadPrecise) continue
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
    })
    }
}

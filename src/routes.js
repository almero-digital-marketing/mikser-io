// Engine-level HTTP route registry.
//
// Plugins mount Express routes on `runtime.options.app` directly — the
// engine doesn't intercept that. But several consumers need to know
// WHAT got mounted and with which proxy-relevant semantics, and the
// Express router stack can't tell them: it has the paths but not the
// intent (is this route loopback-only? does it stream?). So plugins
// declare each mount here as they make it.
//
// `runtime.routes` is the inventory — one descriptor per mounted base
// path. Consumers (a Caddy/nginx facade generator, a healthcheck list,
// an `mikser://routes` introspection resource, API docs) read it; none
// of them is baked in here. The registry is pure inventory — it takes
// no position on what to do with the routes.
//
// `registerRoute` also absorbs two things every route-mounting plugin
// was hand-rolling and copy-pasting:
//   - the origin/location URL building (url ?? localhost:port, + path)
//   - the standard "<label> mounted: <location> [<reachability>]" boot
//     log line
// so the convention lives in one place instead of being duplicated
// across api / preview / mcp / vector / forms / decap.
//
// Lives in core per ADR-0006's five-test: substrate (inventory of the
// Express mounts the engine already owns via runtime.options.app),
// strategic (operationalises reachability, where runtime.options.url
// already lives), the plugin alternative is the god-plugin this avoids
// (a facade plugin that introspected every other plugin's routes),
// plugins register independently, and route metadata moves at engine
// cadence. Exposed at `runtime.routes` per the `runtime.<name>`
// convention.

import runtime from './runtime.js'
import { useLogger } from './engine/index.js'

// Inventory of mounted routes. Plain array, mirroring runtime.validators
// — appended to at mount time (onLoaded-ish), read by consumers later.
runtime.routes = runtime.routes ?? []

// Reachability → default bracketed log label. Plugins can override via
// `authLabel` when they want a louder signal (api/mcp print
// "public, REMOTE OPEN" for a deliberate unauthenticated exposure).
const DEFAULT_AUTH_LABEL = {
    public:   'public',
    token:    'token',
    loopback: 'loopback-only',
}

// Build the operator-facing location string for a route. Full URL when
// an origin is known — public --url / config.url wins (clickable,
// shareable), localhost:port is the dev fallback — bare path when the
// engine doesn't own a listener (external-app embedding, no url set).
export function routeLocation(displayPath) {
    const origin = runtime.options.url
        ?? (runtime.options.port ? `http://localhost:${runtime.options.port}` : null)
    return origin ? `${origin}${displayPath}` : displayPath
}

// The registered route a request path falls inside, or null.
//
// Longest prefix wins, so a mount nested under another ('/drive/notes' under
// '/drive') answers for its own requests rather than its parent's. Exported
// because the CORS middleware needs the same answer Express will reach, and a
// second implementation of "which mount is this" would drift from this one.
export function routeFor(requestPath) {
    if (!requestPath) return null
    let best = null
    for (const route of runtime.routes ?? []) {
        const base = route.path
        if (requestPath !== base && !requestPath.startsWith(`${base}/`)) continue
        if (!best || base.length > best.path.length) best = route
    }
    return best
}

// Declare a mounted route. Records the proxy-relevant descriptor on
// runtime.routes AND emits the standard mount log.
//
//   path          required. The base path the plugin mounted (the key
//                 a facade routes on), e.g. '/api/public', '/mcp'.
//   plugin        required. Owner name ('api', 'mcp', ...).
//   reachability  'public' | 'token' | 'loopback'. Drives the facade's
//                 forward/skip decision: loopback → don't proxy;
//                 public/token → proxy (auth, if any, is app-layer).
//                 Default 'public'.
//   streaming     true when the route streams (SSE / WebSocket). A
//                 facade must disable buffering for it (Caddy
//                 flush_interval -1, nginx proxy_buffering off).
//                 Default false.
//   cors          `false` to emit no CORS headers for this mount. The
//                 same word as the global `--no-cors` /
//                 `config.server.cors: false`, meaning the same thing,
//                 scoped to one route. Default undefined — inherit the
//                 global setting.
//
//                 For a mount whose clients are not browsers: an OS
//                 WebDAV redirector, a CLI tool and curl never consult
//                 CORS, so a header naming who may read the endpoint
//                 from a web page is a claim with no beneficiary — and
//                 on an authenticated endpoint it is better made
//                 deliberately than inherited.
//   methods       the HTTP verbs this mount actually serves. Two
//                 consequences, and the second one is load-bearing:
//                 CORS advertises these for the route instead of a
//                 fixed five, and listing OPTIONS declares that the
//                 mount answers OPTIONS ITSELF — so the global
//                 preflight steps aside rather than terminating it.
//                 Default null, meaning "ordinary REST verbs, and the
//                 preflight is CORS's to answer".
//   label         log prefix. Defaults to `plugin`.
//   detail        optional already-formatted log suffix, e.g.
//                 '(ops=[list,subscribe])'.
//   displayPath   path shown in the logged URL; defaults to `path`
//                 (used when the real mount has a param the log should
//                 show differently, e.g. '/vector/:storeName').
//   authLabel     bracketed reachability text override for the log.
//
// Returns the recorded descriptor.
// WHERE a plugin mounts: `/<name>`, overridable.
//
// Not a new rule — the one every plugin already follows. api at /api, auth at
// /auth, drive at /drive, forms at /forms, mcp at /mcp, preview at /preview,
// vector at /vector, decap at /admin. Each takes a `base` or `path` option so
// a project whose content wants that path can move it.
//
// The output folder is served from `/`, so a plugin route can shadow a page.
// That is a real cost and this is the accepted answer to it: a predictable
// name, and a way to change it. A reserved prefix like `/$name` would make
// the collision impossible, and would also make this plugin the only one
// shaped differently from the other eight — which is a worse trade than the
// collision it avoids, because the collision is rare and visible and the
// inconsistency is permanent.
//
export function registerRoute({
    path,
    plugin,
    reachability = 'public',
    streaming = false,
    methods = null,
    cors,
    label,
    detail,
    displayPath,
    authLabel,
}) {
    if (!path)   throw new Error('registerRoute: `path` is required')
    if (!plugin) throw new Error('registerRoute: `plugin` is required')
    if (!DEFAULT_AUTH_LABEL[reachability]) {
        throw new Error(
            `registerRoute: reachability must be 'public' | 'token' | 'loopback'; got ${JSON.stringify(reachability)}`
        )
    }

    if (methods != null && (!Array.isArray(methods) || methods.some(m => typeof m !== 'string'))) {
        throw new Error('registerRoute: `methods` must be an array of verb strings')
    }

    if (cors !== undefined && cors !== false) {
        throw new Error('registerRoute: `cors` accepts only false — omit it to inherit the global setting')
    }

    const descriptor = { path, plugin, reachability, streaming }
    if (methods) descriptor.methods = methods.map(m => m.toUpperCase())
    if (cors === false) descriptor.cors = false

    // Dedup by path — a re-register (same path) replaces rather than
    // duplicates. Mounts happen once per process, but this keeps the
    // inventory clean if a plugin re-runs its onLoaded.
    const existing = runtime.routes.findIndex(r => r.path === path)
    if (existing >= 0) runtime.routes[existing] = descriptor
    else               runtime.routes.push(descriptor)

    const logger = useLogger()
    if (logger) {
        const location = routeLocation(displayPath ?? path)
        const bracket  = authLabel ?? DEFAULT_AUTH_LABEL[reachability]
        logger.info('%s mounted: %s [%s]%s',
            label ?? plugin, location, bracket, detail ? ` ${detail}` : '')
    }

    return descriptor
}

// Snapshot of the registry. Consumers that want an array copy rather
// than the live `runtime.routes` reference use this.
export function listRoutes() {
    return [...runtime.routes]
}

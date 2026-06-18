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
import { useLogger } from './engine.js'

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
//   label         log prefix. Defaults to `plugin`.
//   detail        optional already-formatted log suffix, e.g.
//                 '(ops=[list,subscribe])'.
//   displayPath   path shown in the logged URL; defaults to `path`
//                 (used when the real mount has a param the log should
//                 show differently, e.g. '/vector/:storeName').
//   authLabel     bracketed reachability text override for the log.
//
// Returns the recorded descriptor.
export function registerRoute({
    path,
    plugin,
    reachability = 'public',
    streaming = false,
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

    const descriptor = { path, plugin, reachability, streaming }

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

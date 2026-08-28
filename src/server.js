// HTTP server bring-up. Two paths:
//
//   1. runtime.options.app — pre-supplied Express app (mikser embedded
//      inside an existing service). The caller owns listen + static-route
//      policy; engine stays out of routing/listening so it doesn't clobber
//      their setup. Plugins still mount their own routers on it.
//
//   2. --server [port] (runtime.options.server) — engine creates the
//      Express app, mounts a static handler for the output folder, and
//      listens on the port. The listen() is deferred via onLoad → onLoaded
//      so it runs LAST in the onLoaded phase, after every plugin has had
//      a chance to register routes.
//
// If both are present, the externally-supplied app wins; --server becomes
// a no-op (the caller is in charge).
//
// CORS, trust-proxy, and the extensible CORS header arrays
// (corsAllowHeaders, corsExposeHeaders for plugins like mikser-io-mcp
// to push transport-specific headers onto) all live in the bring-up
// block — same Express app, all the substrate-level concerns in one
// place.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onInitialized, onLoad, onLoaded } from './lifecycle.js'

// Extend the engine's commander with server-related flags. Called by
// engine.js's onInitialize callback AFTER engine's own options chain
// and BEFORE the .parse() call — preserves the order of options in
// --help output.
// Two hours. Long enough for a gigabyte at 1.2 Mbps, which is below any link
// this runs on, and short enough to remain a bound. Applied only when a
// streaming route exists, so a plain build server keeps Node's default.
const STREAMING_REQUEST_TIMEOUT = 2 * 60 * 60 * 1000

export function attachServerCliOptions(commander) {
    commander
        ?.option('-s --server [port]', 'start an Express server on the given port (defaults to 3001)')
        .option('--cors [origin]', 'restrict server CORS to a specific origin (default *)')
        .option('--no-cors', 'disable server CORS headers')
        .option('-u --url <url>', 'public URL where this mikser is reachable (e.g. https://blog.me.com). Webhook-capable plugins use https URLs for push notifications; other plugins use this when generating absolute URLs (email tracking links, forms share links, MCP previews, etc.).')
}

// Wire the server lifecycle hooks. Called by engine.js's setup() AFTER
// engine's own onInitialized/onLoad registrations so the log-line order
// stays "engine folder logs → server bring-up" rather than the reverse.
// True when this module created the Express app. The late hook applies config-derived
// settings only then — a caller-supplied app owns its own configuration.
let ownsApp = false

export function setupServer() {
    onInitialized(async () => {
        const logger = useLogger()

        if (runtime.options.app) {
            logger.info('Using externally-supplied Express app on runtime.options.app')
            return
        }
        if (!runtime.options.server) return

        const { default: express } = await import('express').catch(() => {
            throw new Error('Express is required for --server. Run: npm install express')
        })
        runtime.options.app = express()
        ownsApp = true
        runtime.options.port = runtime.options.server === true
            ? 3001
            : Number(runtime.options.server) || 3001
        logger.debug('Server starting on port %d', runtime.options.port)

        // Trust-proxy: when mikser is behind a reverse proxy (nginx,
        // Caddy, an Express app, ngrok with edge), the socket peer is
        // the proxy — not the real client. Setting trust proxy makes
        // Express's req.ip walk X-Forwarded-For back to the original
        // requester, which is what mikser's loopback-only auth check
        // compares against.
        //
        // Accepted values (Express semantics):
        //   true               — trust every hop (only safe when the
        //                        proxy strips/rewrites X-Forwarded-*)
        //   'loopback'         — trust 127.0.0.1, ::1, and other
        //                        loopback addresses (correct for a
        //                        proxy on the same host) — THE DEFAULT
        //   'uniquelocal'      — also trust RFC1918 private ranges
        //                        (10/8, 172.16/12, 192.168/16) — for a
        //                        proxy in a sibling container/host on a
        //                        private network
        //   '10.0.0.0/8'       — trust a specific subnet
        //   false              — no trust; req.ip == socket peer
        //
        // Default 'loopback' instead of Express's `false`, because the
        // dominant deployment puts a same-host reverse proxy (Caddy /
        // nginx) in front: there the socket peer is always 127.0.0.1, so
        // with no trust mikser would read EVERY proxied request as
        // loopback and unauthenticated requests through the proxy would
        // pass the loopback gate — the enforcement inverts the moment a
        // facade is added. 'loopback' closes that with no operator
        // action and is safe everywhere: a remote attacker's socket peer
        // is their real IP (the kernel sets it), never 127.0.0.1, so
        // their X-Forwarded-For is never trusted and they can't forge a
        // loopback req.ip. Standalone mikser is unaffected — direct
        // clients aren't loopback, so their XFF is ignored. A proxy on a
        // DIFFERENT host fails closed (non-loopback peer → XFF ignored →
        // loopback endpoints 403) until the operator sets 'uniquelocal'
        // or the specific subnet.
        // `trust proxy` is applied in the late hook at the bottom of this file: runtime.config
        // is not populated during the initialized phase.

        // CORS — a server exists to be fetched, and in dev the frontend
        // is almost always on a different origin (a dev server on
        // another port, a separate domain). So CORS is ON by default
        // with Access-Control-Allow-Origin: *. The token on /api (not
        // CORS) is what gates mutations, and '*' can't carry
        // credentials, so this is low-risk. Pin it down with
        // --cors <origin> / config.server.cors, or disable entirely
        // with --no-cors / config.server.cors:false (recommended for
        // private/admin deployments). Mounted first so it covers static
        // routes and every plugin router.
        // Default on (?? true) so programmatic setup({ server }) — which
        // bypasses commander's --no-cors default — matches the CLI.
        // Explicit false (config or --no-cors) still disables.
        // Registered unconditionally, decided per request. The middleware's position is fixed
        // here — ahead of static and every plugin router — while its setting lives in
        // runtime.config, which is only populated in the load phase. The per-request callback
        // is what lets both hold.
        //
        // Extensible header arrays. Plugins push values into these at factory time to teach
        // CORS about headers they care about — e.g. the mikser-io-mcp plugin adds
        // mcp-session-id, mcp-protocol-version, last-event-id so browser-side MCP clients can
        // complete the Streamable HTTP handshake. Default to the minimum every server needs.
        runtime.options.corsAllowHeaders  = ['Content-Type', 'Authorization']
        runtime.options.corsExposeHeaders = []
        const { default: cors } = await import('cors')
        runtime.options.app.use(cors((req, callback) => {
            const configured = runtime.config.server?.cors ?? runtime.options.cors ?? true
            // `origin: false` is how the cors package emits no CORS headers at all, which is
            // what --no-cors / config.server.cors:false asks for.
            if (!configured) return callback(null, { origin: false })
            callback(null, {
                origin:         configured === true ? '*' : String(configured),
                methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
                allowedHeaders: runtime.options.corsAllowHeaders,
                exposedHeaders: runtime.options.corsExposeHeaders,
            })
        }))
    })

    // Late-binding static + listen. Registered here (inside another
    // onLoad) so the inner onLoaded fires LAST in the onLoaded phase —
    // after every plugin has had a chance to register its own routes.
    // Plugin routes match first; anything that didn't match falls
    // through to the static handler and gets served from outputFolder.
    //
    // Only auto-mount when the engine owns the app (created via
    // --server). When an external app was supplied, port is unset and
    // we stay out of the way — the caller manages both routing
    // decisions and the listen lifecycle themselves.
    onLoad(() => {
        if (!runtime.options.app || runtime.options.port == null) return
        onLoaded(async () => {
            const logger = useLogger()
            const { default: express } = await import('express')

            // Config-derived settings belong here rather than in the onInitialized block that
            // creates the app. Phases run initialize -> initialized -> load -> loaded, and
            // config.js populates runtime.config from a `load` hook — so anything read during
            // `initialized` sees an empty object and takes its default. `loaded` runs after
            // every `load`, so runtime.config is complete here whatever the import order.
            //
            // Express evaluates `trust proxy` per request, so setting it before listen is
            // equivalent to setting it at creation.
            if (ownsApp) {
                const trustProxy = runtime.config.server?.trustProxy ?? 'loopback'
                runtime.options.app.set('trust proxy', trustProxy)
                logger.info('Server trust proxy: %s', String(trustProxy))
                const corsOrigin = runtime.config.server?.cors ?? runtime.options.cors ?? true
                logger.debug('CORS: %s', corsOrigin === false ? 'disabled' : (corsOrigin === true ? '*' : String(corsOrigin)))
            }

            runtime.options.app.use(express.static(runtime.options.outputFolder))

            // A favicon, so the server has a mark instead of a browser's
            // blank default. AFTER the static mount, which is the whole
            // design: a project that puts favicon.ico in its output folder
            // is served its own and never reaches this line. This is the
            // fallback for everything else.
            //
            // Worth having because --server is not only a preview of the
            // site. It is the surface WebDAV, the API and MCP mount on, and
            // those pages sit above whatever the output folder contains —
            // on a multi-language build the output root holds no page at
            // all, so /favicon.ico there is a 404 by construction and every
            // project would have to solve it the same way.
            //
            // Flattened artwork: the mark's mix-blend-mode has nothing to
            // multiply against on a transparent backdrop and rasterises with
            // a hole through it, so favicon.ico is the pre-composited copy.
            const faviconFile = path.join(
                path.dirname(fileURLToPath(import.meta.url)), '..', 'favicon.ico')
            runtime.options.app.get('/favicon.ico', (req, res) => {
                res.type('image/x-icon')
                   .set('Cache-Control', 'public, max-age=3600')
                   .sendFile(faviconFile)
            })

            await new Promise(resolve => {
                const httpServer = runtime.options.app.listen(runtime.options.port, () => {
                    // Public URL wins for operator-clickable log lines —
                    // a reverse-proxy/tunnel/ngrok setup binds locally but
                    // is reached externally at runtime.options.url. Fall
                    // back to the bind URL when no public origin is set.
                    const externalUrl = runtime.options.url ?? `http://localhost:${runtime.options.port}`
                    logger.info('Server listening: %s', externalUrl)
                    resolve()
                })

                // Node caps a single request at 5 minutes (requestTimeout,
                // default 300_000ms), which is not a timeout in the usual
                // sense here — it is an upload size limit expressed in
                // seconds. A large file over a slow link is indistinguishable
                // from a stalled request, so it gets cut off, and the caller
                // sees a truncated write rather than an error it can read.
                //
                // Only reachable from the http.Server, which the engine owns
                // — a plugin that mounts an upload surface (webdav, forms with
                // large attachments) cannot raise it for itself. Hence a
                // config knob here rather than in the plugin.
                //
                // Raised automatically when a streaming route is mounted; see
                // below. `0` disables the cap entirely. That is a deliberate choice
                // for a trusted-network build server and a bad one facing the
                // internet, where it removes the only bound on how long a
                // client can hold a connection open doing nothing.
                // A streaming route is one a facade must not buffer — an
                // upload surface, an SSE stream — and it is exactly the shape
                // Node's 5-minute cap mismeasures. `registerRoute` already
                // records which routes those are, so the engine can tell
                // without being told twice.
                //
                // Two hours rather than `0`: a 1GB upload needs better than
                // 1.2 Mbps to fit, which any real link clears, while a finite
                // bound still stops a client holding a connection open
                // forever. Disabling it entirely stays available and stays a
                // deliberate choice.
                const streaming = (runtime.routes ?? []).filter(r => r.streaming)
                const configured = runtime.config.server?.requestTimeout
                const requestTimeout = configured ?? (streaming.length ? STREAMING_REQUEST_TIMEOUT : undefined)
                if (requestTimeout != null) {
                    httpServer.requestTimeout = requestTimeout
                    // headersTimeout must not exceed requestTimeout, or Node
                    // warns and the shorter one silently wins. Keep it at the
                    // smaller of its default and the new request timeout.
                    if (requestTimeout !== 0) {
                        httpServer.headersTimeout = Math.min(httpServer.headersTimeout, requestTimeout)
                    }
                    logger.info('Server request timeout: %s%s',
                        requestTimeout === 0 ? 'disabled' : `${Math.round(requestTimeout / 60000)}m`,
                        configured == null
                            ? ` (raised from Node's 5m default for ${streaming.length} streaming route(s): `
                              + `${streaming.map(r => r.path).join(', ')} — set config.server.requestTimeout to override)`
                            : '')
                }
                runtime.options.httpServer = httpServer
            })
        })
    })
}

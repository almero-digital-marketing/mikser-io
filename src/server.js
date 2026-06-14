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

import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onInitialized, onLoad, onLoaded } from './lifecycle.js'

// Extend the engine's commander with server-related flags. Called by
// engine.js's onInitialize callback AFTER engine's own options chain
// and BEFORE the .parse() call — preserves the order of options in
// --help output.
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
        //                        proxy on the same host)
        //   '10.0.0.0/8'       — trust a specific subnet
        //   false (default)    — no trust; req.ip == socket peer
        //
        // Without this and behind a proxy, mikser sees every request as
        // coming from the proxy's loopback address and unauthenticated
        // requests through the proxy would pass the loopback gate.
        const trustProxy = runtime.config.server?.trustProxy
        if (trustProxy !== undefined) {
            runtime.options.app.set('trust proxy', trustProxy)
            logger.info('Server trust proxy: %s', String(trustProxy))
        }

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
        const corsOrigin = runtime.config.server?.cors ?? runtime.options.cors ?? true
        if (corsOrigin) {
            const origin = corsOrigin === true ? '*' : String(corsOrigin)
            // Extensible header arrays. Plugins push values into these
            // at factory time to teach CORS about headers they care
            // about — e.g. the mikser-io-mcp plugin adds mcp-session-id,
            // mcp-protocol-version, last-event-id so browser-side MCP
            // clients can complete the Streamable HTTP handshake.
            // Default to the minimum every server needs.
            runtime.options.corsAllowHeaders  = ['Content-Type', 'Authorization']
            runtime.options.corsExposeHeaders = []
            const { default: cors } = await import('cors')
            runtime.options.app.use(cors((req, callback) => {
                callback(null, {
                    origin,
                    methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
                    allowedHeaders: runtime.options.corsAllowHeaders,
                    exposedHeaders: runtime.options.corsExposeHeaders,
                })
            }))
            logger.debug('CORS enabled: %s', origin)
        }
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

            runtime.options.app.use(express.static(runtime.options.outputFolder))

            await new Promise(resolve => {
                runtime.options.app.listen(runtime.options.port, () => {
                    logger.info('Server listening: http://localhost:%d', runtime.options.port)
                    resolve()
                })
            })
        })
    })
}

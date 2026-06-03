// MCP substrate. The engine creates a `substrate` when `--mcp` is on
// and exposes it at runtime.options.mcp. Plugins register their own
// tools, resources, and prompts on it via the same shape as the SDK's
// McpServer — the engine doesn't know what tools exist.
//
// Operating model:
//   - One shared mikser engine, many observing clients.
//   - Per-session McpServer + per-session transport (required by the
//     SDK: a single Server instance can't be initialized twice).
//     The substrate maintains a registry of tool/resource/prompt
//     declarations and replays them onto every new session's server,
//     so plugins register ONCE.
//   - Broadcast logging: every connected client gets every log line.
//     Client-side filtering is honored via the SDK's per-session
//     `logging/setLevel` state.
//
// See documentation/decisions/0006-when-to-add-to-core.md for the
// reasoning that justified putting this in core rather than as a
// plugin.
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import packageInfo from '../package.json' with { type: 'json' }
import runtime from './runtime.js'

let pinoLevelToMcp = (pinoLevel) => {
    if (pinoLevel >= 50) return 'error'
    if (pinoLevel >= 40) return 'warning'
    if (pinoLevel >= 30) return 'info'
    if (pinoLevel >= 20) return 'debug'
    return 'debug'
}

/**
 * Build the MCP substrate. The returned object exposes the same
 * registerTool / registerResource / registerPrompt shape as
 * @modelcontextprotocol/sdk's McpServer, so plugins use it as a
 * drop-in. Internally it records each registration and replays them
 * on every new per-session Server.
 */
export function createMcpSubstrate() {
    // Recorded registrations, replayed on each new session server so
    // late-arriving clients see the same tool surface as early ones.
    const registrations = { tools: [], resources: [], prompts: [] }
    // Per-session McpServer instances currently connected to a
    // transport. Used to fan log notifications and list-changed
    // events out to every active client.
    const activeServers = new Set()
    // Rolling buffer of recent log lines, surfaced via the
    // mikser://logs/recent resource. Sized to cover one or two
    // typical lifecycle cycles — large enough to debug a render
    // failure that scrolled off the live stream, small enough that
    // keeping it in memory isn't a concern. Tail-truncated; oldest
    // line drops when the cap is exceeded.
    const LOG_BUFFER_CAP = 500
    const logBuffer = []

    function bind(server) {
        for (const args of registrations.tools) server.registerTool(...args)
        for (const args of registrations.resources) server.registerResource(...args)
        for (const args of registrations.prompts) server.registerPrompt(...args)
    }

    const substrate = {
        // The SDK's register* methods take different argument counts
        // (3 for tools, 4 for resources, 3 for prompts). We spread the
        // recorded args verbatim — substrate doesn't peek at the
        // shape, it just records and replays.
        registerTool(...args) {
            registrations.tools.push(args)
            for (const s of activeServers) {
                try { s.registerTool(...args) } catch { /* dup, etc. */ }
            }
            return substrate
        },
        registerResource(...args) {
            registrations.resources.push(args)
            for (const s of activeServers) {
                try { s.registerResource(...args) } catch { /* dup */ }
            }
            return substrate
        },
        registerPrompt(...args) {
            registrations.prompts.push(args)
            for (const s of activeServers) {
                try { s.registerPrompt(...args) } catch { /* dup */ }
            }
            return substrate
        },

        // Convenience helper for the common case: 3-arg tool with
        // description and input schema.
        simpleTool(name, description, inputSchema, handler) {
            return substrate.registerTool(name, { description, inputSchema }, handler)
        },

        // Create a fresh McpServer pre-loaded with every recorded
        // registration. Called by the transport mount per new session.
        _createServer() {
            const server = new McpServer(
                { name: 'mikser-io', version: packageInfo.version },
                { capabilities: { tools: {}, resources: {}, logging: {} } },
            )
            bind(server)
            return server
        },
        _attach(server) { activeServers.add(server) },
        _detach(server) { activeServers.delete(server) },
        _activeServerCount() { return activeServers.size },

        // Send a logging-message notification to every connected
        // client. The SDK's per-session level filtering applies.
        broadcastLog(params) {
            for (const s of activeServers) {
                try {
                    // sendLoggingMessage is async; fire-and-forget so
                    // one slow client can't stall the rest. Errors
                    // are swallowed — log loss on a side channel is
                    // less important than not killing engine logs.
                    s.sendLoggingMessage(params).catch(() => {})
                } catch { /* swallow */ }
            }
        },

        // Called by wireLoggerToMcp on every log call. Records a
        // monotonic seq number so clients can poll "give me lines
        // since seq=N" against mikser://logs/recent.
        recordLogLine(line) {
            logBuffer.push({
                seq: (logBuffer.length === 0 ? 1 : logBuffer[logBuffer.length - 1].seq + 1),
                t: runtime.engine?.now ? runtime.engine.now() : null,
                ...line,
            })
            // Tail-truncate so memory stays bounded.
            if (logBuffer.length > LOG_BUFFER_CAP) {
                logBuffer.splice(0, logBuffer.length - LOG_BUFFER_CAP)
            }
        },
        recentLogLines(limit = LOG_BUFFER_CAP) {
            const n = Math.min(LOG_BUFFER_CAP, Math.max(1, limit))
            return logBuffer.slice(-n)
        },
    }

    // Built-in introspection resources. Read-only views into the
    // running engine — let an AI ask "what's the current phase?",
    // "what config is loaded?", "what just happened?" without
    // needing a custom tool.
    //
    // The SDK's registerResource signature is:
    //   registerResource(name, uriOrTemplate, metadata, handler)
    // Static resources pass a URI string; the handler returns
    // { contents: [{ uri, mimeType, text }] }.

    substrate.registerResource(
        'mikser-lifecycle',
        'mikser://lifecycle',
        {
            title: 'Current lifecycle phase',
            description: 'The phase the engine is currently executing. Null when between phases.',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({
                    phase: runtime.phase ?? null,
                    started: runtime.started === true,
                    stamp: runtime.stamp,
                    processTime: runtime.processTime ?? null,
                }, null, 2),
            }],
        }),
    )

    substrate.registerResource(
        'mikser-runtime',
        'mikser://runtime',
        {
            title: 'Engine runtime options',
            description: 'Resolved runtime.options — working folder, output folder, server port, plugin list, etc. Excludes the live engine handles (logger, queue, workers).',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({
                    options: runtime.options,
                    started: runtime.started === true,
                    phase: runtime.phase ?? null,
                }, null, 2),
            }],
        }),
    )

    substrate.registerResource(
        'mikser-config',
        'mikser://config',
        {
            title: 'Effective mikser config',
            description: 'The merged config object as plugins see it (runtime.config). Includes per-plugin keys.',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify(runtime.config, null, 2),
            }],
        }),
    )

    substrate.registerResource(
        'mikser-logs-recent',
        'mikser://logs/recent',
        {
            title: 'Recent engine log lines',
            description: `Rolling buffer of the most recent log lines (up to ${LOG_BUFFER_CAP}). Useful for debugging a render or postprocess failure that scrolled past the live notifications stream.`,
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ lines: substrate.recentLogLines() }, null, 2),
            }],
        }),
    )

    // mikser://server — single-shot answer to "where do I put output
    // so the user can see it?" Combines server state (running? on what
    // URL?) and the path conventions agents should write to for
    // preview-style outputs.
    substrate.registerResource(
        'mikser-server',
        'mikser://server',
        {
            title: 'HTTP server location and preview conventions',
            description: 'Where the running engine is reachable (URL, MCP path, preview path prefix) and what folder it serves. The single resource an agent needs to answer "where can the user see this output?"',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify(serverInfo(), null, 2),
            }],
        }),
    )

    // Built-in liveness/identity tool. Also ensures tools/list works
    // before any plugin has registered (McpServer only advertises
    // tools/list capability after at least one registration).
    substrate.registerTool(
        'mikser_ping',
        {
            description: 'Return mikser engine identity, current lifecycle phase, and (if --server is on) where the HTTP server is reachable. Use to confirm the connection is live before issuing other tool calls and to learn the base URL for preview outputs.',
            inputSchema: {},
        },
        async () => ({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    name: 'mikser-io',
                    version: packageInfo.version,
                    started: runtime.started === true,
                    phase: runtime.phase ?? null,
                    workingFolder: runtime.options.workingFolder,
                    outputFolder: runtime.options.outputFolder,
                    activeClients: substrate._activeServerCount(),
                    server: serverInfo(),
                }, null, 2),
            }],
        }),
    )

    return substrate
}

// Derive a stable snapshot of "where outputs are visible to the user."
// Three cases:
//   1. --server is on  → engine owns Express, knows port → full URL
//   2. external app    → caller supplied runtime.options.app; URL not
//                        visible to engine (port unknown), but the
//                        outputFolder and path conventions are still
//                        useful for preview-writing tools
//   3. no server       → only the static folder layout applies; an
//                        agent should not try to advertise a URL
//
// Kept as a function rather than a const so each call re-reads
// runtime.options — covers the case where --server flips on after
// the substrate was created (rare but possible programmatically).
function serverInfo() {
    const opts = runtime.options
    const hasInternalServer = opts.server != null && opts.port != null
    const hasExternalApp = opts.app && !hasInternalServer

    const base = hasInternalServer
        ? `http://localhost:${opts.port}`
        : null

    return {
        running: hasInternalServer ? 'internal' : (hasExternalApp ? 'external' : 'none'),
        port: opts.port ?? null,
        url: base,
        serves: opts.outputFolder ?? null,
        mcpPath: opts.mcpPath ?? null,
        mcpUrl: base && opts.mcpPath ? `${base}${opts.mcpPath}` : null,
        // Preview URLs are returned directly by mikser_preview_render
        // (preview plugin), so we don't advertise a path convention here —
        // doing so would be a lie when the preview plugin isn't loaded.
    }
}

/**
 * Mount the MCP substrate on an Express app at the given path
 * (default `/mcp`). Each connecting client gets its own
 * McpServer + StreamableHTTPServerTransport pair (SDK constraint).
 * Sessions are tracked by `mcp-session-id` header — initialize
 * requests open a new session; subsequent requests echo their id.
 */
export async function mountMcpOnExpress(app, substrate, path = '/mcp') {
    // sessionId → transport. POSTs with an existing id route back
    // to that transport so the SDK's session state stays consistent.
    const transports = new Map()

    async function handle(req, res, body) {
        const sessionId = req.headers['mcp-session-id']
        if (sessionId && transports.has(sessionId)) {
            return transports.get(sessionId).handleRequest(req, res, body)
        }

        // No matching session — assume a new initialize request
        // (the SDK will reject if it isn't actually an initialize).
        const server = substrate._createServer()
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
                transports.set(id, transport)
                substrate._attach(server)
            },
        })
        transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId)
            substrate._detach(server)
        }
        await server.connect(transport)
        return transport.handleRequest(req, res, body)
    }

    app.post(path, (req, res) => handle(req, res, req.body))
    app.get(path,  (req, res) => handle(req, res))
    app.delete(path, (req, res) => handle(req, res))
}

/**
 * Wrap a pino logger so every call also broadcasts a
 * `notifications/message` to MCP clients AND appends to the
 * substrate's rolling buffer (read via mikser://logs/recent).
 * Wraps in place: returns the same logger reference, with
 * `fatal/error/warn/info/debug/trace` replaced by versions that
 * call the original AND fan out via the substrate.
 *
 * Wrapping (vs. swapping in a pino multistream) lets us keep the
 * existing logger reference that the rest of the engine, plugins,
 * and render workers already hold — no second logger to thread
 * through, no race during initialization.
 */
export function wireLoggerToMcp(logger, substrate) {
    const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace']
    for (const level of levels) {
        const original = logger[level]?.bind(logger)
        if (!original) continue
        logger[level] = (...args) => {
            original(...args)
            try {
                const data = extractData(args)
                const mcpLevel = pinoLevelToMcp(pinoLevelNumber(level))
                substrate.recordLogLine?.({ level: mcpLevel, data })
                substrate.broadcastLog({
                    level: mcpLevel,
                    logger: 'mikser',
                    data,
                })
            } catch { /* swallow — keep stdout pipeline working */ }
        }
    }
    return logger
}

// Reduce pino-style call args to a single { msg, ...fields } payload
// for the MCP notification's `data` field. Mirrors pino's own argument
// handling: leading object = fields, trailing string = msg template,
// remaining args = printf params.
function extractData(args) {
    if (args.length === 0) return { msg: '' }
    const [first, ...rest] = args
    if (typeof first === 'object' && first !== null) {
        const template = typeof rest[0] === 'string' ? rest[0] : ''
        const params = rest.slice(1)
        const msg = template ? format(template, params) : (rest[0] !== undefined ? String(rest[0]) : '')
        return { ...first, msg }
    }
    return { msg: format(String(first), rest) }
}

// %s / %d / %j formatting, matching pino's printf-style behavior.
function format(template, args) {
    if (typeof template !== 'string') return String(template)
    let i = 0
    return template.replace(/%[sdjoO]/g, (token) => {
        if (i >= args.length) return token
        const a = args[i++]
        if (token === '%s') return String(a)
        if (token === '%d') return Number(a).toString()
        return typeof a === 'object' ? JSON.stringify(a) : String(a)
    })
}

function pinoLevelNumber(name) {
    return { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[name] ?? 30
}

// (whenMcpActive was removed in v7.4.0 — plugins now use the same
// inline pattern as Express route registration: gate on the runtime
// option inside whichever lifecycle hook makes sense.
//
//   onLoaded(async () => {
//       if (runtime.options.mcp) {
//           runtime.options.mcp.simpleTool(...)
//       }
//   })
//
// Reveals timing, matches the Express pattern, doesn't lock the
// registration into onLoaded.)

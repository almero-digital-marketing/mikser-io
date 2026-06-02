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
import { onLoaded } from './lifecycle.js'

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

    function bind(server) {
        for (const args of registrations.tools) server.registerTool(...args)
        for (const args of registrations.resources) server.registerResource(...args)
        for (const args of registrations.prompts) server.registerPrompt(...args)
    }

    const substrate = {
        // ---- plugin-facing surface (mirrors McpServer) -----------

        registerTool(name, def, handler) {
            registrations.tools.push([name, def, handler])
            for (const s of activeServers) {
                try { s.registerTool(name, def, handler) } catch { /* dup, etc. */ }
            }
            return substrate
        },
        registerResource(name, def, handler) {
            registrations.resources.push([name, def, handler])
            for (const s of activeServers) {
                try { s.registerResource(name, def, handler) } catch { /* dup */ }
            }
            return substrate
        },
        registerPrompt(name, def, handler) {
            registrations.prompts.push([name, def, handler])
            for (const s of activeServers) {
                try { s.registerPrompt(name, def, handler) } catch { /* dup */ }
            }
            return substrate
        },

        // Convenience helper for the common case: 3-arg tool with
        // description and input schema.
        simpleTool(name, description, inputSchema, handler) {
            return substrate.registerTool(name, { description, inputSchema }, handler)
        },

        // ---- engine-facing surface -------------------------------

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

        // ---- notification broadcast ------------------------------

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
    }

    // Built-in liveness/identity tool. Also ensures tools/list works
    // before any plugin has registered (McpServer only advertises
    // tools/list capability after at least one registration).
    substrate.registerTool(
        'mikser_ping',
        {
            description: 'Return mikser engine identity and the current lifecycle phase. Use to confirm the connection is live before issuing other tool calls.',
            inputSchema: {},
        },
        async () => ({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    name: 'mikser-io',
                    version: packageInfo.version,
                    started: runtime.started === true,
                    workingFolder: runtime.options.workingFolder,
                    outputFolder: runtime.options.outputFolder,
                    activeClients: substrate._activeServerCount(),
                }, null, 2),
            }],
        }),
    )

    return substrate
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
 * `notifications/message` to MCP clients. Wraps in place: returns
 * the same logger reference, with `fatal/error/warn/info/debug/trace`
 * replaced by versions that call the original AND fan out via the
 * substrate to every connected client.
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
                substrate.broadcastLog({
                    level: pinoLevelToMcp(pinoLevelNumber(level)),
                    logger: 'mikser',
                    data: extractData(args),
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

// Convenience for plugins that want to gate their tool registrations
// behind "is MCP active?". Equivalent to checking runtime.options.mcp
// directly but reads better at the call site.
export function whenMcpActive(callback) {
    onLoaded(async () => {
        if (runtime.options.mcp) await callback(runtime.options.mcp)
    })
}

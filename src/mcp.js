// MCP substrate. The engine creates an McpServer when `--mcp` is on
// and exposes it at runtime.options.mcp. Plugins register their own
// tools and resources on it via the SDK's API — the engine doesn't
// know what tools exist (same shape as Express routes).
//
// Operating model:
//   - Single shared mikser engine, many observing clients.
//   - Stateless transport (no per-session state) because mikser itself
//     is single-tenant; all clients see the same catalog, the same
//     file system, the same build cycles.
//   - Broadcast logging: every connected client gets every log line,
//     filtered per-client by their requested level (MCP spec
//     'logging/setLevel').
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
 * Build the MCP server instance with mikser-flavored capabilities.
 * Wrapping is intentionally thin — plugins call the SDK's registerTool
 * / registerResource directly on the returned server.
 */
export function createMcpSubstrate() {
    const server = new McpServer(
        {
            name: 'mikser-io',
            version: packageInfo.version,
        },
        {
            capabilities: {
                tools: {},
                resources: {},
                logging: {},
            },
        },
    )

    // Convenience helper exposed alongside the SDK methods. Plugins
    // can call either form; this one keeps the per-call surface
    // tiny when a tool is straightforward.
    server.simpleTool = (name, description, inputSchema, handler) =>
        server.registerTool(
            name,
            { description, inputSchema },
            handler,
        )

    // Built-in tool so the substrate has something to expose even
    // when no plugin has registered yet. Also serves as a liveness
    // check from an MCP client ("are you really mikser-io?").
    server.registerTool(
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
                }, null, 2),
            }],
        }),
    )

    return server
}

/**
 * Mount the MCP server on an existing Express app at the given path
 * (default `/mcp`). Uses stateful sessions per the MCP spec — each
 * client gets a session ID on initialize and includes it on
 * subsequent requests. The server tracks active sessions so that
 * server-pushed notifications (logging, list-changed) reach every
 * connected client.
 *
 * Stateful is the right call for mikser even though the underlying
 * engine is single-tenant: clients need long-lived SSE streams to
 * receive notifications, and the MCP protocol expects an init →
 * call sequence within a session.
 */
export async function mountMcpOnExpress(app, server, path = '/mcp') {
    // Session registry: sessionId → transport. Used to route POST/GET
    // requests back to the right transport instance.
    const transports = new Map()

    async function handle(req, res, body) {
        const sessionId = req.headers['mcp-session-id']
        if (sessionId && transports.has(sessionId)) {
            // Existing session — route to that transport.
            return transports.get(sessionId).handleRequest(req, res, body)
        }

        // No session id, or unknown. For an initialize call we create
        // a new transport + session. For anything else, the SDK will
        // reject (this matches MCP spec — only initialize may start
        // a session).
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
                transports.set(id, transport)
            },
        })
        transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId)
        }
        await server.connect(transport)
        return transport.handleRequest(req, res, body)
    }

    app.post(path, (req, res) => handle(req, res, req.body))
    app.get(path,  (req, res) => handle(req, res))
    app.delete(path, (req, res) => handle(req, res))
}

/**
 * A pino destination that forwards every log line to the MCP server
 * as a `notifications/message`. Every connected client sees every
 * line; per-client level filtering happens on the client side via
 * the MCP `logging/setLevel` request — handled by the SDK.
 *
 * Returns a write-stream-shaped object that pino can append.
 */
export function createMcpPinoDestination(server) {
    return {
        write(chunk) {
            if (!server.isConnected()) return
            let parsed
            try {
                parsed = typeof chunk === 'string' ? JSON.parse(chunk) : chunk
            } catch {
                // Not JSON — push the raw line as info text.
                server.sendLoggingMessage({
                    level: 'info',
                    logger: 'mikser',
                    data: { msg: String(chunk).trim() },
                }).catch(() => {})
                return
            }

            const { level, msg, time, name, ...data } = parsed
            server.sendLoggingMessage({
                level: pinoLevelToMcp(level ?? 30),
                logger: name ?? 'mikser',
                data: { msg, time, ...data },
            }).catch(() => {
                // Swallow — a misbehaving MCP client shouldn't kill
                // mikser's log pipeline. The local stdout stream
                // still receives the line.
            })
        },
    }
}

// Convenience for plugins that want to gate their tool registrations
// behind "is MCP active?". Equivalent to checking runtime.options.mcp
// directly but reads better at the call site.
export function whenMcpActive(callback) {
    onLoaded(async () => {
        if (runtime.options.mcp) await callback(runtime.options.mcp)
    })
}

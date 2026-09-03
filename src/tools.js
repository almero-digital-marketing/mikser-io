// The tool registry — named, described, invokable capabilities.
//
// There are two agent workflows against mikser and they are equally real: an
// agent speaking MCP over HTTP, and an agent running the CLI and reading its
// output. Every tool used to live in the mcp plugin, reachable only through a
// session, so the second workflow saw a different and much smaller engine than
// the first. Closing that by adding a CLI flag per tool would drift the moment
// anyone added a tool.
//
// Both directions. The mcp plugin mirrors its own registrations into here, and
// binds every tool registered here into each session — prefixing on the way
// out, since `mikser_` belongs to MCP's flat namespace and not to the engine.
// So a plugin registers once, against this registry, and reaches both surfaces
// without depending on the mcp plugin being installed, or on where it sits in
// the plugins array.
//
// `inputSchema` is stored opaquely, which is what makes that possible: a
// plugin may describe its parameters in the neutral vocabulary below or hand
// over a zod shape, and the engine passes either through untouched rather than
// taking a dependency on zod to hold it.
//
// So the REGISTRY is substrate and the transports are consumers. ADR-0006's
// five tests, which MCP itself failed on release cadence:
//
//   1. Substrate — a place plugins register against, like routes.js. Yes.
//   2. Strengthens the strategy — "AI-native, lifecycle-observable" is the
//      positioning; this is the surface that makes it true on both workflows.
//   3. God-plugin check — it REMOVES coupling: the CLI no longer needs the mcp
//      plugin present to expose what the engine can answer.
//   4. Composability — mcp, the api plugin and the CLI read one list rather
//      than each growing their own.
//   5. Release cadence — a registry is small and stable. The churn is in the
//      tools and the transport, and both stay outside.
//
// What is deliberately NOT here: transport, sessions, resources, prompts, and
// the tools themselves. Those are MCP's concepts and MCP's business. This file
// knows a name, a description, an input schema and a function.

import runtime from './runtime.js'

function store() {
    runtime.tools ??= new Map()
    return runtime.tools
}

// Register a tool. Later registration of the same name REPLACES the earlier
// one and says so, rather than silently keeping one of two implementations
// with the same name — which is the failure that would be hardest to see.
export function registerTool(name, definition = {}, handler) {
    if (!name || typeof name !== 'string') throw new Error('registerTool: name is required')
    if (typeof handler !== 'function') throw new Error(`registerTool(${name}): handler must be a function`)
    const tools = store()
    if (tools.has(name)) {
        runtime.engine?.logger?.debug('Tool %s re-registered, replacing the previous handler', name)
    }
    tools.set(name, {
        // The whole definition, not the three fields core happens to read.
        // A transport needs more than core does — `mutates: true` is how a
        // tool says it changes something, and MCP wraps those differently.
        // Dropping unknown keys here meant a plugin could only reach that
        // behaviour by registering with the mcp plugin directly, which is
        // exactly the coupling this registry exists to remove.
        ...definition,
        name,
        description: definition.description ?? '',
        inputSchema: definition.inputSchema ?? {},
        handler,
    })
    return () => tools.delete(name)
}

// Does this tool belong on that surface?
//
// A tool may declare `surfaces: ['mcp']`. Scope used to be enforced by WHICH
// registry a plugin registered against — mikser-io-git's undo tools are
// deliberately MCP-only and reached that by registering with the mcp plugin
// and not the engine. That made the scope decision inseparable from the
// coupling: to be MCP-only you had to depend on mcp.
//
// Declaring it is better in both directions. The scope is now visible where
// the tool is defined rather than inferred from an import, and a plugin can
// say it without taking a dependency on the transport it is naming.
//
// Undeclared means every surface, which is what almost every tool wants.
function onSurface(tool, surface) {
    if (!surface || !tool?.surfaces) return true
    return tool.surfaces.includes(surface)
}

export function toolNames(surface) {
    return [...store().entries()]
        .filter(([, tool]) => onSurface(tool, surface))
        .map(([name]) => name)
        .sort()
}

// Name, description and input schema — everything a caller needs to decide
// whether to call it, and nothing it should not hold onto.
export function toolSchema(name) {
    const tool = store().get(name)
    if (!tool) return null
    const { handler, ...rest } = tool
    return rest
}

export function toolSchemas(surface) {
    return toolNames(surface).map(toolSchema)
}

// Invoke by name. Returns whatever the tool returns — for tools registered by
// the mcp plugin that is the MCP content envelope, so a CLI caller and a
// session caller are looking at the same answer rather than two renderings of
// it.
export async function invokeTool(name, args = {}, { surface } = {}) {
    // Names in this registry are BARE. The `mikser_` prefix belongs to MCP,
    // where tool names share one flat namespace across every connected server
    // and an unprefixed `audit_output` would collide with anyone else's — a
    // constraint of that protocol, not of the engine. `mikser --tool
    // mikser_explain` says mikser twice.
    //
    // A prefixed name is still accepted, because it is what an agent reads in
    // MCP documentation and it should not have to know which surface stripped
    // what.
    const tool = store().get(name)
        ?? store().get(String(name).replace(/^mikser_/, ''))
        ?? store().get(`mikser_${name}`)
    if (!tool) {
        const known = toolNames(surface)
        throw new Error(`Unknown tool: ${name}${known.length ? `. Available: ${known.join(', ')}` : '. None are registered — is the mcp plugin in your config?'}`)
    }
    // Refused rather than hidden. A tool that exists but is not offered here
    // should say so and say where it is offered, because "unknown tool" would
    // send the caller looking for a typo or a missing plugin.
    if (!onSurface(tool, surface)) {
        throw new Error(
            `Tool ${tool.name} is not available on the ${surface} surface. `
            + `It is offered on: ${tool.surfaces.join(', ')}.`)
    }
    return tool.handler(args ?? {})
}

// The text a tool's result carries, for printing.
//
// MCP's envelope is `{ content: [{ type, text }], isError? }`. A tool that
// returns a bare string or object is printed too, so a plugin registering
// directly against this registry does not have to know MCP's shape to be
// usable from the CLI.
export function toolResultText(result) {
    if (result == null) return ''
    if (typeof result === 'string') return result
    if (Array.isArray(result.content)) {
        return result.content.map(part => part?.text).filter(Boolean).join('\n')
    }
    return JSON.stringify(result, null, 2)
}

export function toolResultFailed(result) {
    return Boolean(result?.isError)
}

// Is this a report-and-exit invocation — one that answers a question and never
// runs a build?
//
// Two things depend on knowing: the cache must not be wiped for one (it would
// destroy the state being described, with nothing to repopulate it), and
// anything that waits for a cycle must refuse rather than wait forever. Both
// were real: a `--tool` write with `await: true` exited 0 in one second having
// printed nothing at all, because the promise it was awaiting could never
// settle and Node drained the loop and left.
export function isReportOnlyRun() {
    const options = runtime.options ?? {}
    return Boolean(options.explain || options.auditOutput || options.tool || options.tools
        || options.fingerprint)
}

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import {
    registerTool, toolNames, toolSchema, toolSchemas,
    invokeTool, toolResultText, toolResultFailed, isReportOnlyRun,
} from '../../src/tools.js'

// The registry exists because there are two agent workflows, not one: an agent
// speaking MCP over HTTP and an agent running the CLI and reading its output.
// Both read this list, so a tool registered by any plugin reaches both surfaces
// the moment it exists and there is no second list to keep in step.

beforeEach(() => { runtime.tools = new Map() })

describe('registerTool', () => {
    it('registers a callable tool with its schema', async () => {
        registerTool('mikser_echo', { description: 'Echo', inputSchema: { text: 'string' } },
            async ({ text }) => ({ content: [{ type: 'text', text }] }))
        assert.deepEqual(toolNames(), ['mikser_echo'])
        assert.deepEqual(toolSchema('mikser_echo'),
            { name: 'mikser_echo', description: 'Echo', inputSchema: { text: 'string' } })
    })

    it('never hands the handler out with the schema', () => {
        // A schema is for deciding whether to call something. Leaking the
        // function invites a caller to hold onto it past a re-registration.
        registerTool('mikser_x', { description: 'x' }, async () => 'ok')
        assert.equal(toolSchema('mikser_x').handler, undefined)
        assert.equal(toolSchemas()[0].handler, undefined)
    })

    it('replaces on re-registration rather than keeping one of two silently', async () => {
        registerTool('mikser_dup', { description: 'first' }, async () => 'first')
        registerTool('mikser_dup', { description: 'second' }, async () => 'second')
        assert.equal(toolNames().length, 1)
        assert.equal(await invokeTool('mikser_dup'), 'second')
    })

    it('returns an unregister function', () => {
        const undo = registerTool('mikser_temp', { description: 't' }, async () => 'ok')
        assert.deepEqual(toolNames(), ['mikser_temp'])
        undo()
        assert.deepEqual(toolNames(), [])
    })

    it('refuses a registration that could not be invoked', () => {
        assert.throws(() => registerTool('', {}, async () => {}), /name is required/)
        assert.throws(() => registerTool('mikser_bad', {}, 'not a function'), /must be a function/)
    })

    it('sorts names, so two listings of the same registry compare equal', () => {
        registerTool('mikser_zeta', { description: 'z' }, async () => {})
        registerTool('mikser_alpha', { description: 'a' }, async () => {})
        assert.deepEqual(toolNames(), ['mikser_alpha', 'mikser_zeta'])
    })
})

describe('invokeTool', () => {
    it('passes arguments through and returns what the tool returns', async () => {
        registerTool('mikser_add', { description: 'add' }, async ({ a, b }) => ({ sum: a + b }))
        assert.deepEqual(await invokeTool('mikser_add', { a: 2, b: 3 }), { sum: 5 })
    })

    it('defaults missing arguments to an empty object rather than undefined', async () => {
        // A handler destructuring its argument must not throw because the CLI
        // was invoked without --tool-args.
        registerTool('mikser_none', { description: 'n' }, async ({ x } = {}) => ({ x: x ?? null }))
        assert.deepEqual(await invokeTool('mikser_none'), { x: null })
    })

    it('names what IS available when asked for something that is not', async () => {
        registerTool('mikser_here', { description: 'h' }, async () => {})
        await assert.rejects(() => invokeTool('mikser_missing'),
            /Unknown tool: mikser_missing\. Available: mikser_here/)
    })

    it('points at the mcp plugin when the registry is empty', async () => {
        // "Unknown tool" with no list reads as a typo; the actual cause is
        // almost always that nothing registered any tools.
        await assert.rejects(() => invokeTool('mikser_anything'), /is the mcp plugin in your config/)
    })
})

describe('toolResultText — printing what a tool returned', () => {
    it('unwraps the MCP content envelope, so `--tool X | jq` sees only the payload', () => {
        assert.equal(toolResultText({ content: [{ type: 'text', text: '{"ok":true}' }] }), '{"ok":true}')
    })

    it('joins several content parts', () => {
        assert.equal(toolResultText({ content: [{ text: 'a' }, { text: 'b' }] }), 'a\nb')
    })

    it('prints a plain string or object too', () => {
        // A plugin registering directly against this registry should not have
        // to know MCP's envelope shape to be usable from the CLI.
        assert.equal(toolResultText('hello'), 'hello')
        assert.equal(toolResultText({ a: 1 }), '{\n  "a": 1\n}')
    })

    it('is empty for nothing, rather than printing "null"', () => {
        assert.equal(toolResultText(null), '')
        assert.equal(toolResultText(undefined), '')
    })

    it('reports failure, which is all an exit code has to go on', () => {
        // An agent reading CLI output branches on the exit status; a tool that
        // reported an error must not exit 0.
        assert.equal(toolResultFailed({ isError: true, content: [{ text: 'boom' }] }), true)
        assert.equal(toolResultFailed({ content: [{ text: 'fine' }] }), false)
        assert.equal(toolResultFailed(null), false)
    })
})

describe('isReportOnlyRun', () => {
    const withOptions = (options, fn) => {
        const saved = runtime.options
        runtime.options = { ...saved, explain: undefined, auditOutput: undefined, tool: undefined, tools: undefined, ...options }
        try { fn() } finally { runtime.options = saved }
    }

    it('recognises every report-and-exit flag', () => {
        for (const options of [{ explain: '/x.md' }, { auditOutput: true }, { tool: 'mikser_ping' }, { tools: true }]) {
            withOptions(options, () => assert.equal(isReportOnlyRun(), true, JSON.stringify(options)))
        }
    })

    it('is false for a build, which is the run that rebuilds the cache', () => {
        withOptions({}, () => assert.equal(isReportOnlyRun(), false))
        withOptions({ watch: true, force: true }, () => assert.equal(isReportOnlyRun(), false))
    })
})

describe('the mikser_ prefix is MCP\'s, not the registry\'s', () => {
    // MCP tool names share one flat namespace across every server a client has
    // connected to, so an unprefixed `verify` would collide with anyone else's.
    // The engine has no such problem, and on the CLI the prefix is stutter:
    // `mikser --tool mikser_explain` says mikser twice. So the registry holds
    // the bare name and mikser-io-mcp adds the prefix at the session boundary.
    it('resolves a prefixed name to the bare registration', async () => {
        registerTool('explain', { description: 'e' }, async () => 'explained')
        assert.equal(await invokeTool('mikser_explain'), 'explained')
        assert.equal(await invokeTool('explain'), 'explained')
    })

    it('resolves a bare name to a prefixed registration', async () => {
        // The plugin mirrors under the bare name, but a tool registered
        // directly with a prefix should still answer to the short form rather
        // than being unreachable from the CLI.
        registerTool('mikser_legacy', { description: 'l' }, async () => 'ok')
        assert.equal(await invokeTool('legacy'), 'ok')
    })

    it('prefers an exact match over either rewrite', async () => {
        registerTool('search', { description: 'bare' }, async () => 'bare')
        registerTool('mikser_search', { description: 'prefixed' }, async () => 'prefixed')
        assert.equal(await invokeTool('search'), 'bare')
        assert.equal(await invokeTool('mikser_search'), 'prefixed')
    })
})

describe('what a registration carries', () => {
    it('keeps definition fields core itself does not read', () => {
        // `mutates` is MCP's, not core's — but a plugin registering here
        // must be able to say it, or it would have to register with the mcp
        // plugin directly to be treated correctly. That is the coupling.
        registerTool('mutating', { description: 'd', inputSchema: {}, mutates: true }, async () => ({}))
        assert.equal(toolSchema('mutating').mutates, true)
    })

    it('still defaults the fields core does read', () => {
        registerTool('bare', {}, async () => ({}))
        assert.deepEqual(toolSchema('bare'), { name: 'bare', description: '', inputSchema: {} })
    })
})

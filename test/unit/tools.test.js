import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import {
    registerTool, toolNames, toolSchema, toolSchemas,
    invokeTool, toolResultText, toolResultFailed,
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

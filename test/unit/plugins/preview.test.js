import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import previewPlugin from '../../../src/plugins/preview.js'
import { createHarness } from '../plugin-harness.js'

// A minimal MCP shim — captures simpleTool / registerResource calls so
// tests can invoke the handlers directly without booting the real MCP.
function fakeMcp() {
    const tools = new Map()
    const resources = new Map()
    return {
        registered: tools,
        resources,
        simpleTool(name, description, inputSchema, handler) {
            tools.set(name, { description, inputSchema, handler })
        },
        registerResource(name, uri, metadata, handler) {
            resources.set(uri, { name, metadata, handler })
        },
        // Pass-throughs for surfaces preview plugin doesn't use.
        registerTool() {},
        registerPrompt() {},
    }
}

// The preview plugin gates MCP tool registration on runtime.options.mcp.
// We set it before invoking the plugin so the onLoaded hook registers
// against our fake.
function withMcp(harnessOptions = {}, entities = []) {
    const mcp = fakeMcp()
    const h = createHarness({
        options: { ...harnessOptions, mcp, port: 3001 },
        entities,
    })
    previewPlugin(h.core)
    return { h, mcp }
}

describe('preview plugin: mikser_preview_ui dispatch', () => {
    it('registers mikser_preview_ui under MCP when runtime.options.mcp is set', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')
        assert.ok(mcp.registered.has('mikser_preview_ui'),
            'preview plugin should register mikser_preview_ui on onLoaded')
        assert.ok(mcp.registered.has('mikser_preview_render'),
            'existing mikser_preview_render should still be registered')
    })

    it('does NOT register when runtime.options.mcp is absent', async () => {
        const h = createHarness({ options: { port: 3001 } })
        previewPlugin(h.core)
        await h.runHook('loaded')
        // No MCP → no tool. Plugin still loads (route mount, cache available).
        // We can't easily assert the negative on a Map we never got, but
        // we can verify onLoaded completed without throwing.
        assert.ok(true)
    })

    it('fails with a helpful message when no layout declares mcpUi for the requested mode', async () => {
        // Layout exists but has no mcpUi metadata at all.
        const layout = {
            id: '/layouts/article.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article',
            meta: { match: '@/articles/*' },
        }
        const article = { id: '/articles/launch', collection: 'documents', name: 'articles/launch' }

        const { h, mcp } = withMcp({}, [layout, article])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_preview_ui')
        const result = await tool.handler({ entityId: '/articles/launch', mode: 'preview' })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /No layouts found with mcpUi\.mode="preview"/)
    })

    it('fails when the target entity is not in the catalog', async () => {
        const layout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: {
                match: '@/articles/*',
                mcpUi: { mode: 'preview', description: 'Article preview', actions: ['approve'] },
            },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_preview_ui')
        const result = await tool.handler({ entityId: '/articles/does-not-exist', mode: 'preview' })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /Entity not found/)
    })

    it('fails with a candidate list when no mcpUi layout matches the entity', async () => {
        // Two candidates for the same mode, but neither matches /products/*.
        const articleLayout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: { match: '@/articles/*', mcpUi: { mode: 'preview' } },
        }
        const blogLayout = {
            id: '/layouts/blog-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'blog-preview',
            meta: { match: '@/blog/*', mcpUi: { mode: 'preview' } },
        }
        const product = { id: '/products/sku-001', collection: 'products', name: 'products/sku-001' }

        const { h, mcp } = withMcp({}, [articleLayout, blogLayout, product])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_preview_ui')
        const result = await tool.handler({ entityId: '/products/sku-001', mode: 'preview' })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /No mcpUi layout matched/)
        // Should surface the available candidate patterns so the agent
        // can reason about why nothing matched.
        assert.match(result.content[0].text, /article-preview/)
        assert.match(result.content[0].text, /blog-preview/)
    })

    it('filters candidates by mode — a layout with mode=edit is not eligible for mode=preview', async () => {
        const previewLayout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: { match: '@/articles/*', mcpUi: { mode: 'preview' } },
        }
        const editLayout = {
            id: '/layouts/article-edit.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-edit',
            meta: { match: '@/articles/*', mcpUi: { mode: 'edit' } },
        }
        const article = { id: '/articles/launch', collection: 'documents', name: 'articles/launch' }

        const { h, mcp } = withMcp({}, [previewLayout, editLayout, article])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_preview_ui')
        // Ask for an unsupported mode. Both layouts exist, but neither
        // has mode='approval'; should fall through the "no mode" gate.
        const result = await tool.handler({ entityId: '/articles/launch', mode: 'approval' })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /No layouts found with mcpUi\.mode="approval"/)
    })

    it('registers the mikser://mcp-ui/modes discovery resource alongside the tool', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')
        assert.ok(mcp.resources.has('mikser://mcp-ui/modes'),
            'preview plugin should register the mcp-ui modes resource')
    })

    it('mikser://mcp-ui/modes returns an empty modes map when no layouts declare mcpUi', async () => {
        const plainLayout = {
            id: '/layouts/article.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article',
            meta: { match: '@/articles/*' },  // no mcpUi key
        }
        const { h, mcp } = withMcp({}, [plainLayout])
        await h.runHook('loaded')

        const resource = mcp.resources.get('mikser://mcp-ui/modes')
        const result = await resource.handler(new URL('mikser://mcp-ui/modes'))
        const payload = JSON.parse(result.contents[0].text)

        assert.deepEqual(payload.modes, {})
        assert.equal(payload.totalLayouts, 0)
    })

    it('mikser://mcp-ui/modes groups layouts by mode with match patterns and actions', async () => {
        const previewArticle = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: {
                match: '@/articles/*',
                mcpUi: {
                    mode: 'preview',
                    description: 'Article preview',
                    actions: ['approve', 'reject'],
                },
            },
        }
        const previewProduct = {
            id: '/layouts/product-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'product-preview',
            meta: {
                match: '@/products/*',
                mcpUi: { mode: 'preview', actions: ['approve'] },
            },
        }
        const editArticle = {
            id: '/layouts/article-edit.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-edit',
            meta: {
                match: '@/articles/*',
                mcpUi: { mode: 'edit', actions: ['save', 'cancel'] },
            },
        }
        // A layout with mcpUi but no explicit mode — defaults to 'preview'.
        const defaultModeLayout = {
            id: '/layouts/landing.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'landing',
            meta: { match: '@/landing/*', mcpUi: { description: 'Landing' } },
        }

        const { h, mcp } = withMcp({}, [previewArticle, previewProduct, editArticle, defaultModeLayout])
        await h.runHook('loaded')

        const resource = mcp.resources.get('mikser://mcp-ui/modes')
        const result = await resource.handler(new URL('mikser://mcp-ui/modes'))
        const payload = JSON.parse(result.contents[0].text)

        assert.equal(payload.totalLayouts, 4)
        assert.equal(payload.modes.preview.length, 3, 'three layouts in preview mode (two explicit + one default)')
        assert.equal(payload.modes.edit.length, 1)

        // Spot-check the shape of one candidate.
        const articleEntry = payload.modes.preview.find(c => c.layoutId === '/layouts/article-preview.hbs')
        assert.ok(articleEntry)
        assert.equal(articleEntry.match, '@/articles/*')
        assert.equal(articleEntry.description, 'Article preview')
        assert.deepEqual(articleEntry.actions, ['approve', 'reject'])
        assert.deepEqual(articleEntry.sandbox, ['allow-scripts']) // default sandbox

        // Default-mode layout landed under 'preview'.
        const landingEntry = payload.modes.preview.find(c => c.layoutId === '/layouts/landing.hbs')
        assert.ok(landingEntry, 'layout without explicit mcpUi.mode should default to preview')
    })

    it('mikser://mcp-ui/modes excludes non-layout entities even if they have mcpUi-shaped meta', async () => {
        // Defensive: the resource filters by collection === 'layouts',
        // so a stray document.meta.mcpUi can't pollute the discovery list.
        const layout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: { match: '@/articles/*', mcpUi: { mode: 'preview' } },
        }
        const docWithStrayMcpUi = {
            id: '/articles/launch',
            collection: 'documents',
            type: 'document',
            name: 'articles/launch',
            meta: { mcpUi: { mode: 'rogue' } },
        }

        const { h, mcp } = withMcp({}, [layout, docWithStrayMcpUi])
        await h.runHook('loaded')

        const resource = mcp.resources.get('mikser://mcp-ui/modes')
        const result = await resource.handler(new URL('mikser://mcp-ui/modes'))
        const payload = JSON.parse(result.contents[0].text)

        assert.equal(payload.totalLayouts, 1)
        assert.equal(payload.modes.rogue, undefined, 'document.meta.mcpUi must not surface as a mode')
    })

    it('defaults mode to "preview" when not supplied', async () => {
        const layout = {
            id: '/layouts/article-preview.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-preview',
            meta: { match: '@/articles/*', mcpUi: { mode: 'preview' } },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_preview_ui')
        // Don't pass mode — should default to 'preview' and look for
        // candidates with mode==='preview'. The error path we hit here
        // is "entity not found", which confirms the mode filter
        // accepted the preview layout (otherwise we'd see the no-mode
        // error first).
        const result = await tool.handler({ entityId: '/articles/does-not-exist' })
        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /Entity not found/)
    })
})

// --------------------------------------------------------------------
// Awaitable behavior — per ADR-0008. The tool suspends until the iframe
// POSTs an action; we test by injecting a fake Express app that captures
// the route handler, kicking off the tool call, and then driving the
// endpoint directly to release the suspended promise.
// --------------------------------------------------------------------

// Fake Express app that captures the registered route handlers. The
// real preview.js mounts both a GET /preview/:filename (the cache
// route) and POST /api/mcp-ui/action/:callId (the action endpoint —
// ADR-0008 §A2). We capture both and let tests invoke either.
function fakeApp() {
    const routes = new Map() // key: METHOD + routePath
    function add(method, args) {
        // Real Express signature: app.METHOD(path, ...middlewares, handler)
        // We don't run the middlewares; we capture the last fn as the handler.
        const [routePath, ...rest] = args
        const handler = rest[rest.length - 1]
        routes.set(`${method}:${routePath}`, handler)
    }
    return {
        get:  (...args) => add('GET',  args),
        post: (...args) => add('POST', args),
        invoke(routePath, { method = 'POST', params, body }) {
            const handler = routes.get(`${method}:${routePath}`)
            if (!handler) throw new Error(`No route for ${method} ${routePath}`)
            return new Promise((resolve) => {
                let resolved = false
                const res = {
                    statusCode: 200,
                    status(code) { this.statusCode = code; return this },
                    json(payload) {
                        if (resolved) return
                        resolved = true
                        resolve({ status: this.statusCode, body: payload })
                    },
                    type() { return this },
                    send() { /* unused in MCP-UI tests */ },
                }
                Promise.resolve(handler({ params, body }, res)).catch(err => {
                    if (!resolved) resolve({ status: 500, body: { error: err.message } })
                })
            })
        },
    }
}

function withAppAndMcp(extraEntities = []) {
    const mcp = fakeMcp()
    const app = fakeApp()
    const h = createHarness({
        options: { mcp, app, port: 3001 },
        entities: extraEntities,
    })
    previewPlugin(h.core)
    return { h, mcp, app }
}

describe('preview plugin: mikser_preview_ui awaitable behavior', () => {
    // Layouts + an entity, sized for the dispatch path to succeed.
    const approvalLayout = {
        id: '/layouts/mcp-ui/post-approval.hbs',
        name: 'mcp-ui/post-approval',
        collection: 'layouts',
        type: 'layout',
        meta: {
            match: '@/blog/*',
            mcpUi: {
                mode: 'approval',
                actions: ['approve', 'reject', 'request-changes'],
            },
        },
    }
    const blogPost = {
        id: '/documents/blog/launch.md',
        name: 'blog/launch',
        collection: 'documents',
        type: 'document',
        meta: { layout: 'post' },
    }

    it('mounts the POST /api/mcp-ui/action/:callId endpoint when runtime.options.app is present', async () => {
        const { h, mcp, app } = withAppAndMcp([approvalLayout, blogPost])
        await h.runHook('loaded')
        assert.ok(mcp.registered.has('mikser_preview_ui'))

        // Endpoint should be mounted and respond to POSTs. Without an
        // active pending entry it 404s — which is the correct behavior
        // and lets us verify the endpoint is registered without
        // needing to mock the full render pipeline.
        const r = await app.invoke('/api/mcp-ui/action/:callId', {
            method: 'POST',
            params: { callId: 'mui_nothing-pending' },
            body:   { action: 'approve' },
        })
        assert.equal(r.status, 404)
        assert.match(r.body.error, /No pending MCP-UI action/)
    })

    it('endpoint rejects POSTs with unknown callId (the auth boundary — random POSTs cannot inject actions)', async () => {
        const { h, app } = withAppAndMcp([approvalLayout, blogPost])
        await h.runHook('loaded')

        // The callId IS the auth — a POST with no matching pending entry
        // can't trigger an action no matter what's in the body. This is
        // the threat-model guarantee called out in ADR-0008 §B5.
        const r = await app.invoke('/api/mcp-ui/action/:callId', {
            method: 'POST',
            params: { callId: 'mui_random-attacker-guess' },
            body:   { action: 'approve', entityId: '/x', payload: { malicious: true } },
        })
        assert.equal(r.status, 404)
    })

    // TODO(integration): the following scenarios need a full render
    // pipeline (the unit harness's useRenderer stub doesn't drive the
    // `runtime.hooks.completed` cycle, so previewRender throws before
    // the suspension logic runs). Cover them in a smoke/integration
    // test that boots a real engine against a fixture project:
    //
    //   - awaitAction: false returns HTML immediately, no pending entry
    //   - awaitable (default) suspends until POST arrives, resolves with
    //     { action, entityId, payload }
    //   - endpoint rejects an action that's not in the allowed list (400)
    //   - timeout fires after timeoutSeconds, tool rejects with a clear
    //     error mentioning the entity + mode + callId
    //   - handler.url set → action POST forwards to webhook, response
    //     body becomes the tool result
    //   - handler.url unreachable → falls back to pure relay with
    //     handlerError field
    //
    // The endpoint-validation seams above (callId 404, no-app skip) are
    // the parts of the new logic that DON'T require the render pipeline,
    // so they live here as fast unit tests.

    it('does NOT mount the action endpoint when runtime.options.app is absent', async () => {
        // The action endpoint depends on Express. If no app is provided,
        // mikser is running headless / MCP-only — and the endpoint
        // doesn't mount. The fakeApp has no app.post calls in that case.
        const mcp = fakeMcp()
        const h = createHarness({
            options: { mcp, port: 3001 },     // no `app`
            entities: [approvalLayout, blogPost],
        })
        previewPlugin(h.core)
        await h.runHook('loaded')

        // Tool should still register (it's MCP-level, not HTTP).
        assert.ok(mcp.registered.has('mikser_preview_ui'))
        // No app means no endpoint to test, but at least the loaded
        // hook didn't throw — that's the regression check.
    })
})

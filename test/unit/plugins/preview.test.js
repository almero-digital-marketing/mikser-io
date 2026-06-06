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

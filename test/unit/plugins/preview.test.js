import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import previewPlugin from '../../../src/plugins/preview.js'
import { createHarness } from '../plugin-harness.js'

// A minimal MCP shim — captures simpleTool / registerTool / registerResource
// calls so tests can invoke the handlers directly without booting the real MCP.
function fakeMcp() {
    const tools = new Map()
    const resources = new Map()
    return {
        registered: tools,
        resources,
        simpleTool(name, description, inputSchema, handler) {
            tools.set(name, { description, inputSchema, handler })
        },
        // registerTool is the lower-level path; tools that need _meta
        // (like mikser_ui_action's visibility flag for MCP Apps) use it
        // directly. Capture into the same map so tests don't care which
        // path the plugin took.
        registerTool(name, config, handler) {
            tools.set(name, { ...config, handler })
        },
        registerResource(name, uri, metadata, handler) {
            resources.set(uri, { name, metadata, handler })
        },
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

    it('declares _meta.ui.resourceUri pointing at the shell (MCP Apps spec)', async () => {
        // Per ADR-0008: spec-conformant hosts read this off the tool
        // definition (statically, at tools/list time) to decide which
        // iframe template to render the tool's result inside. Without
        // it, hosts display the rendered HTML as plain text instead of
        // an iframe — the empirical bug that drove the restructure.
        const { h, mcp } = withMcp()
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_preview_ui')
        assert.equal(tool._meta?.ui?.resourceUri, 'ui://mikser/preview-ui-shell',
            'mikser_preview_ui must declare _meta.ui.resourceUri on the tool definition')
    })

    it('registers the ui://mikser/preview-ui-shell resource with the spec MIME type', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')

        const shell = mcp.resources.get('ui://mikser/preview-ui-shell')
        assert.ok(shell, 'shell resource should be registered at ui://mikser/preview-ui-shell')
        assert.equal(shell.metadata.mimeType, 'text/html;profile=mcp-app',
            'shell resource MUST declare text/html;profile=mcp-app — basic-host and other conformant hosts reject anything else')

        // Resource handler returns the shell HTML so the iframe can load.
        const fakeUri = { href: 'ui://mikser/preview-ui-shell' }
        const result = await shell.handler(fakeUri)
        assert.equal(result.contents[0].mimeType, 'text/html;profile=mcp-app')
        // Contains the protocol plumbing — the things we care about end-to-end.
        assert.match(result.contents[0].text, /ui\/initialize/, 'shell must implement ui/initialize handshake')
        assert.match(result.contents[0].text, /ui\/notifications\/tool-result/, 'shell must handle ui/notifications/tool-result')
        assert.match(result.contents[0].text, /window\.sendAction/, 'shell must expose window.sendAction for layouts to call')
        assert.match(result.contents[0].text, /mikser_ui_action/, 'shell must relay clicks to mikser_ui_action')
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

describe('preview plugin: mikser_ui_action', () => {
    it('registers mikser_ui_action with _meta.ui.visibility=[app]', async () => {
        const { h, mcp } = withMcp()
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_ui_action')
        assert.ok(tool, 'mikser_ui_action should be registered')
        // MCP Apps spec — visibility=['app'] makes it invisible to the
        // model and callable from inside iframes opened via the host's
        // AppBridge. Drift here breaks every Apps-conformant host.
        assert.deepEqual(tool._meta?.ui?.visibility, ['app'],
            'mikser_ui_action must declare visibility=[app]')
    })

    it('pure-relay: returns { entityId, action, payload } when no handler.url', async () => {
        const layout = {
            id: '/layouts/article-approval.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-approval',
            meta: {
                match: '@/articles/*',
                mcpUi: { mode: 'approval', actions: ['approve', 'reject'] },
            },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_ui_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/layouts/article-approval.hbs',
            action:   'approve',
            payload:  { reviewer: 'alice' },
        })

        assert.equal(result.isError, undefined)
        const data = JSON.parse(result.content[0].text)
        assert.deepEqual(data, {
            entityId: '/articles/launch',
            action:   'approve',
            payload:  { reviewer: 'alice' },
        })
    })

    it('rejects actions not in the layout\'s allowed list', async () => {
        const layout = {
            id: '/layouts/article-approval.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-approval',
            meta: {
                match: '@/articles/*',
                mcpUi: { mode: 'approval', actions: ['approve', 'reject'] },
            },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_ui_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/layouts/article-approval.hbs',
            action:   'delete-everything',
            payload:  {},
        })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /not in allowed list/)
        // Specifically calls out what WAS allowed so the agent/iframe
        // author can fix the call site.
        assert.match(result.content[0].text, /approve, reject/)
    })

    it('rejects when layoutId points to a non-layout entity', async () => {
        const article = {
            id: '/articles/launch',
            collection: 'documents',
            type: 'document',
            name: 'articles/launch',
            meta: {},
        }
        const { h, mcp } = withMcp({}, [article])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_ui_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/articles/launch',     // pointing at a document — wrong
            action:   'approve',
            payload:  {},
        })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /not found or not a layout/)
    })

    it('rejects when the resolved layout has no mcpUi frontmatter', async () => {
        const layout = {
            id: '/layouts/plain.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'plain',
            meta: { match: '@/articles/*' },   // no mcpUi
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_ui_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/layouts/plain.hbs',
            action:   'approve',
            payload:  {},
        })

        assert.equal(result.isError, true)
        assert.match(result.content[0].text, /does not declare mcpUi/)
    })

    it('forwards to handler.url when declared and returns its JSON response as the tool result', async () => {
        const { createServer } = await import('node:http')
        const calls = []
        const srv = createServer((req, res) => {
            let body = ''
            req.on('data', c => body += c)
            req.on('end', () => {
                calls.push({ url: req.url, body: JSON.parse(body) })
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: true, summary: 'ticket #4821 created' }))
            })
        })
        await new Promise(r => srv.listen(0, r))
        const port = srv.address().port

        try {
            const layout = {
                id: '/layouts/article-approval.hbs',
                collection: 'layouts',
                type: 'layout',
                name: 'article-approval',
                meta: {
                    match: '@/articles/*',
                    mcpUi: {
                        mode: 'approval',
                        actions: ['approve', 'reject'],
                        handler: { url: `http://127.0.0.1:${port}/hook` },
                    },
                },
            }
            const { h, mcp } = withMcp({}, [layout])
            await h.runHook('loaded')

            const tool = mcp.registered.get('mikser_ui_action')
            const result = await tool.handler({
                entityId: '/articles/launch',
                layoutId: '/layouts/article-approval.hbs',
                action:   'approve',
                payload:  { reviewer: 'alice' },
            })

            assert.equal(result.isError, undefined)
            const data = JSON.parse(result.content[0].text)
            assert.deepEqual(data, { ok: true, summary: 'ticket #4821 created' })

            // Verify the forward carried the canonical fields.
            assert.equal(calls.length, 1)
            assert.equal(calls[0].url, '/hook')
            assert.equal(calls[0].body.action,   'approve')
            assert.equal(calls[0].body.entityId, '/articles/launch')
            assert.equal(calls[0].body.layoutId, '/layouts/article-approval.hbs')
            assert.equal(calls[0].body.mode,     'approval')
            assert.deepEqual(calls[0].body.payload, { reviewer: 'alice' })
        } finally {
            await new Promise(r => srv.close(r))
        }
    })

    it('falls back to pure relay with handlerError when handler.url fails', async () => {
        const layout = {
            id: '/layouts/article-approval.hbs',
            collection: 'layouts',
            type: 'layout',
            name: 'article-approval',
            meta: {
                match: '@/articles/*',
                mcpUi: {
                    mode: 'approval',
                    actions: ['approve'],
                    // Port 1 is reserved — guaranteed connection refusal.
                    handler: { url: 'http://127.0.0.1:1/hook', timeout: 500 },
                },
            },
        }
        const { h, mcp } = withMcp({}, [layout])
        await h.runHook('loaded')

        const tool = mcp.registered.get('mikser_ui_action')
        const result = await tool.handler({
            entityId: '/articles/launch',
            layoutId: '/layouts/article-approval.hbs',
            action:   'approve',
            payload:  {},
        })

        // Fail-safe: never lose the user's click. Pure-relay payload
        // PLUS handlerError so the agent knows the backend ack failed.
        assert.equal(result.isError, undefined)
        const data = JSON.parse(result.content[0].text)
        assert.equal(data.entityId, '/articles/launch')
        assert.equal(data.action,   'approve')
        assert.ok(data.handlerError, 'expected handlerError field on fallback')
        assert.match(data.handlerError, /unreachable|timeout|ECONNREFUSED/i)
    })
})

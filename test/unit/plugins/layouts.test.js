import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import layoutsPlugin from '../../../src/plugins/layouts.js'
import frontMatterPlugin from '../../../src/plugins/front-matter.js'
import { createHarness } from '../plugin-harness.js'

async function withTempWorking(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-layouts-'))
    try { return await fn(dir) }
    finally { await rm(dir, { recursive: true, force: true }) }
}

describe('layouts plugin', () => {
    it('registers all the expected hooks', () => {
        const h = createHarness()
        layoutsPlugin(h.core)
        // Two onLoaded handlers: one for state init, one for the
        // gated MCP tool registration (no-op when MCP isn't active).
        // The MCP gate goes through the same lifecycle as Express
        // route mounting — onLoaded + runtime-option check.
        assert.equal(h.hooks.loaded.length, 2)
        assert.equal(h.hooks.import.length, 1)
        assert.equal(h.hooks.processed.length, 1)
        assert.equal(h.hooks.beforeRender.length, 1)
        assert.equal(h.hooks.complete.length, 1)
        assert.ok(h.sync.has('layouts'))
    })

    it('initializes runtime.state.layouts on onLoaded with empty maps', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')
            assert.deepEqual(h.runtime.state.layouts, { layouts: {}, sitemap: {} })
            assert.equal(h.runtime.options.layoutsFolder, path.join(workingFolder, 'layouts'))
        })
    })

    it('onSync CREATE registers a layout in state.layouts and writes a journal entry', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })

            const entry = h.journal.find(e => e.operation === 'create')
            assert.ok(entry)
            assert.equal(entry.entity.id, '/layouts/post.hbs')
            assert.equal(entry.entity.template, 'hbs')
            assert.equal(entry.entity.format, 'html')
            assert.equal(entry.entity.name, 'post')
            assert.ok(h.runtime.state.layouts.layouts['post'])
        })
    })

    it('onSync CREATE for a sidecar .js layout drops .js from id', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs.js' } })
            const entry = h.journal.find(e => e.operation === 'create')
            assert.equal(entry.entity.id, '/layouts/post.hbs')
        })
    })

    it('onSync DELETE removes the layout from state.layouts and writes a delete entry', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })
            assert.ok(h.runtime.state.layouts.layouts['post'])

            await h.runSync('layouts', { action: 'delete', context: { relativePath: 'post.hbs' } })

            assert.equal(h.runtime.state.layouts.layouts['post'], undefined)
            assert.equal(h.journal.filter(e => e.operation === 'delete').length, 1)
        })
    })

    it('onProcessed addToSitemap for entities with a matched layout', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
                config: { layouts: { autoLayouts: true } },
            })
            layoutsPlugin(h.core)
            await h.runHook('loaded')
            // Seed a layout
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })

            // Seed a document journal entry whose name matches 'post'
            const doc = {
                id: '/documents/post.md',
                collection: 'documents',
                name: 'post',
                format: 'md',
                meta: { lang: 'en' },
            }
            h.journal.push({ id: 99, entity: doc, operation: 'create', context: {}, options: {}, output: null })

            await h.runHook('processed', { aborted: false })

            assert.ok(doc.layout, 'entity should have been assigned a layout')
            assert.equal(doc.layout.name, 'post')
            const sitemap = h.runtime.state.layouts.sitemap
            assert.ok(sitemap['/post'] || Object.keys(sitemap).length > 0)
        })
    })

    it('warns when a render-requested entity (carries correlationId) matches no layout', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
                config: { layouts: { autoLayouts: true } },
            })
            layoutsPlugin(h.core)
            await h.runHook('loaded')

            // A render-submitted entity: no meta.layout, name won't
            // auto-match any layout, and it carries useRenderer's
            // correlationId under entity.options.
            const rendered = {
                id: '/archive/franchises/38f8.json',
                collection: 'archive',
                name: 'franchises/38f8',
                format: 'json',
                meta: { company: 'Acme' },
                options: { correlationId: 'abc-123' },
            }
            h.journal.push({ id: 99, entity: rendered, operation: 'create', context: {}, options: {}, output: null })

            await h.runHook('processed', { aborted: false })

            assert.equal(rendered.layout, undefined, 'no layout should have matched')
            const warned = h.logs.some(l =>
                l.level === 'warn' && l.args.join(' ').includes('Render requested') && l.args.join(' ').includes('no layout matched'))
            assert.ok(warned, 'should warn that the render-requested entity matched no layout')
        })
    })

    it('stays silent for a normal layout-less entity (no correlationId)', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
                config: { layouts: { autoLayouts: true } },
            })
            layoutsPlugin(h.core)
            await h.runHook('loaded')

            // Same shape, but NOT a render request — no correlationId.
            const plain = {
                id: '/files/data/blob.json',
                collection: 'files',
                name: 'data/blob',
                format: 'json',
                meta: {},
            }
            h.journal.push({ id: 99, entity: plain, operation: 'create', context: {}, options: {}, output: null })

            await h.runHook('processed', { aborted: false })

            const warned = h.logs.some(l => l.level === 'warn' && l.args.join(' ').includes('Render requested'))
            assert.equal(warned, false, 'normal layout-less files must not trigger the render warning')
        })
    })

    // Layouts go through the frontmatter pipeline like documents do.
    // The layouts plugin reads the file at sync time and populates
    // entity.content; the frontmatter plugin then walks the journal at
    // onProcess and lifts YAML into entity.meta. The two plugins
    // compose via the journal contract alone — no cross-imports.
    it('onImport reads layout content from disk so frontmatter can populate entity.meta', async () => {
        await withTempWorking(async (workingFolder) => {
            const layoutsFolder = path.join(workingFolder, 'layouts')
            await mkdir(layoutsFolder, { recursive: true })
            await writeFile(path.join(layoutsFolder, 'article.hbs'),
                '---\nmatch: "@/articles/*"\nmcpUi:\n  mode: preview\n  description: "Article preview"\n  actions: ["approve","reject"]\n---\n<article>{{title}}</article>\n')

            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layoutsPlugin(h.core)
            frontMatterPlugin(h.core)
            await h.runHook('loaded')
            await h.runHook('import')

            const created = h.journal.find(e => e.operation === 'create' && e.entity?.id === '/layouts/article.hbs')
            assert.ok(created, 'expected a journal CREATE for the layout')
            assert.ok(created.entity.content?.includes('match: "@/articles/*"'),
                'layout entity.content should carry the raw file bytes before frontmatter runs')

            // Frontmatter plugin runs onProcess against the same journal,
            // strips the YAML, and lifts the metadata into entity.meta.
            await h.runHook('process')

            assert.equal(created.entity.meta?.match, '@/articles/*')
            assert.equal(created.entity.meta?.mcpUi?.mode, 'preview')
            assert.equal(created.entity.meta?.mcpUi?.description, 'Article preview')
            assert.deepEqual(created.entity.meta?.mcpUi?.actions, ['approve', 'reject'])
            // entity.content is now the stripped body — no YAML, no leading ---.
            assert.equal(created.entity.content.trim(), '<article>{{title}}</article>')
        })
    })

    it('onProcessed attaches entity.layout from the catalog (post-frontmatter strip), not the raw state map', async () => {
        // The layouts plugin's in-memory state map (runtime.state.layouts.layouts)
        // is populated at sync time with the RAW file body — YAML and all.
        // The front-matter plugin's onProcess pass updates the CATALOG
        // entity's content (via updateEntry), not the state map. If
        // onProcessed naively attached entity.layout = layouts[name],
        // the renderer would receive the raw file via entity.layout.content
        // and emit YAML verbatim. The fix: resolve the layout from the
        // catalog by id, falling back to the state map only when the
        // catalog hasn't caught up. This test pins that contract.
        await withTempWorking(async (workingFolder) => {
            const layoutsFolder = path.join(workingFolder, 'layouts')
            await mkdir(layoutsFolder, { recursive: true })
            await writeFile(path.join(layoutsFolder, 'article.hbs'),
                '---\nmatch: "@/articles/*"\nmcpUi:\n  mode: preview\n---\n<article>{{title}}</article>\n')

            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layoutsPlugin(h.core)
            frontMatterPlugin(h.core)
            await h.runHook('loaded')
            await h.runHook('import')

            // Add a document that explicitly names the layout — exercises
            // the `entity.meta.layout = '...'` branch in onProcessed.
            const doc = {
                id: '/documents/article.md',
                collection: 'documents',
                type: 'document',
                name: 'article',
                meta: { layout: 'article' },
                content: 'body',
            }
            h.journal.push({ id: 99, entity: doc, operation: 'create', context: {}, options: {}, output: null })

            // process strips frontmatter on the catalog layout entity.
            await h.runHook('process')
            // processed walks the document journal and attaches the layout.
            await h.runHook('processed')

            // entity.layout MUST come from the catalog (clean) — not from
            // the raw state map. If the raw state map leaked in, content
            // would still start with `---\nmatch:...`.
            assert.ok(doc.layout, 'expected onProcessed to attach a layout to the document')
            assert.ok(!doc.layout.content?.includes('match: "@/articles/*"'),
                'attached layout content must be post-frontmatter-strip (catalog), not the raw state-map entry')
            assert.equal(doc.layout.content.trim(), '<article>{{title}}</article>')
        })
    })

    it('onSync CREATE reads layout content from disk so frontmatter can run on updates', async () => {
        await withTempWorking(async (workingFolder) => {
            const layoutsFolder = path.join(workingFolder, 'layouts')
            await mkdir(layoutsFolder, { recursive: true })
            await writeFile(path.join(layoutsFolder, 'card.hbs'),
                '---\nmode: edit\n---\n<form>{{title}}</form>\n')

            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layoutsPlugin(h.core)
            frontMatterPlugin(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'card.hbs' } })
            await h.runHook('process')

            const created = h.journal.find(e => e.operation === 'create' && e.entity?.id === '/layouts/card.hbs')
            assert.ok(created)
            assert.equal(created.entity.meta?.mode, 'edit')
            assert.equal(created.entity.content.trim(), '<form>{{title}}</form>')
        })
    })

    it('onSync CREATE returns empty content (and stays silent at debug) when the file is missing', async () => {
        // Sync events can synthetically arrive without a corresponding
        // file (test harness usage; rare race in production). The plugin
        // logs at debug and proceeds with empty content rather than
        // throwing — downstream renderers surface the real issue.
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'ghost.hbs' } })

            const created = h.journal.find(e => e.operation === 'create')
            assert.ok(created)
            assert.equal(created.entity.content, '')
            assert.ok(h.logs.some(l => l.level === 'debug' && l.args.join(' ').includes('unreadable')),
                'expected a debug log noting the missing layout file')
        })
    })

    it('onSync returns false when relativePath is missing', async () => {
        const h = createHarness()
        layoutsPlugin(h.core)
        assert.equal(await h.runSync('layouts', { action: 'create', context: {} }), false)
    })

    it('onComplete writes the rendered output to disk by default', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const h = createHarness({ options: { workingFolder, outputFolder } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')

            const entity = {
                id: '/documents/page.md',
                collection: 'documents',
                name: 'page',
                destination: '/page.html',
                layout: { name: 'page', format: 'html' },
            }
            await h.runHook('complete', { entity, options: {}, output: { result: '<h1>Hi</h1>' } })

            const written = path.join(outputFolder, 'page.html')
            await assert.doesNotReject(() => access(written), 'expected the file to be written')
        })
    })

    it('onComplete with entity.options.save === false skips the disk write (bytes-only mode)', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const h = createHarness({ options: { workingFolder, outputFolder } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')

            const entity = {
                id: '/documents/page.md',
                collection: 'documents',
                name: 'page',
                destination: '/page.html',
                layout: { name: 'page', format: 'html' },
                options: { save: false },
            }
            await h.runHook('complete', { entity, options: {}, output: { result: '<h1>Hi</h1>' } })

            const written = path.join(outputFolder, 'page.html')
            await assert.rejects(() => access(written), 'expected NO file to be written')
        })
    })

    it('onComplete writes the intermediate to previewFolder (not outputFolder) when options.save:false and a postprocessor is configured', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const previewFolder = path.join(workingFolder, 'runtime', 'preview')
            const h = createHarness({ options: { workingFolder, outputFolder, previewFolder } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')

            // Intermediate: postprocessor is configured, no origin yet
            // (we haven't entered the postprocess phase).
            // options.save:false means the FINAL output is skipped, but
            // the intermediate still needs to land somewhere so the
            // postprocessor can read it — that "somewhere" is
            // previewFolder, not outputFolder. Keeps outputFolder
            // clean for previews.
            const intermediate = {
                id: '/documents/r.md',
                collection: 'documents',
                name: 'r',
                destination: '/r.html',
                layout: { name: 'r', format: 'html', postprocessor: 'pdf' },
                options: { save: false },
            }
            await h.runHook('complete', { entity: intermediate, options: {}, output: { result: '<h1>R</h1>' } })

            // Lands in previewFolder, not outputFolder.
            await assert.doesNotReject(
                () => access(path.join(previewFolder, 'r.html')),
                'intermediate must be written to previewFolder for postprocess to consume',
            )
            await assert.rejects(
                () => access(path.join(outputFolder, 'r.html')),
                'intermediate must NOT appear in outputFolder during preview flow',
            )
        })
    })
})

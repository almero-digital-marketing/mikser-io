import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import layoutsPlugin from '../../../src/plugins/layouts.js'
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

    it('onComplete with entity._save === false skips the disk write (bytes-only mode)', async () => {
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
                _save: false,
            }
            await h.runHook('complete', { entity, options: {}, output: { result: '<h1>Hi</h1>' } })

            const written = path.join(outputFolder, 'page.html')
            await assert.rejects(() => access(written), 'expected NO file to be written')
        })
    })

    it('onComplete writes the intermediate to previewFolder (not outputFolder) when _save:false and a postprocessor is configured', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const previewFolder = path.join(workingFolder, 'runtime', 'preview')
            const h = createHarness({ options: { workingFolder, outputFolder, previewFolder } })
            layoutsPlugin(h.core)
            await h.runHook('loaded')

            // Intermediate: postprocessor is configured, no origin yet
            // (we haven't entered the postprocess phase). _save:false
            // means the FINAL output is skipped, but the intermediate
            // still needs to land somewhere so the postprocessor can
            // read it — that "somewhere" is previewFolder, not
            // outputFolder. Keeps outputFolder clean for previews.
            const intermediate = {
                id: '/documents/r.md',
                collection: 'documents',
                name: 'r',
                destination: '/r.html',
                layout: { name: 'r', format: 'html', postprocessor: 'pdf' },
                _save: false,
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

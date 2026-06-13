import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { layouts } from '../../../src/plugins/layouts.js'
import { frontMatter } from '../../../src/plugins/front-matter.js'
import { createHarness } from '../plugin-harness.js'

async function withTempWorking(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-layouts-'))
    try { return await fn(dir) }
    finally { await rm(dir, { recursive: true, force: true }) }
}

describe('layouts plugin', () => {
    it('registers all the expected hooks', () => {
        const h = createHarness()
        layouts()(h.core)
        // One onLoaded handler — state init only. The MCP wrapper
        // (mikser_layouts_inspect) moved to the mikser-io-mcp plugin
        // in 8.2.0 and reaches in via runtime.options.layouts.inspect.
        assert.equal(h.hooks.loaded.length, 1)
        assert.equal(h.hooks.import.length, 1)
        assert.equal(h.hooks.processed.length, 1)
        assert.equal(h.hooks.beforeRender.length, 1)
        assert.equal(h.hooks.complete.length, 1)
        assert.ok(h.sync.has('layouts'))
        // The inspect primitive is exposed at factory-eval — before any
        // onLoaded fires — so plugins listed after layouts in the
        // plugins array can see it during their own onLoaded.
        assert.equal(typeof h.runtime.options.layouts?.inspect, 'function')
    })

    it('initializes runtime.state.layouts on onLoaded with empty maps', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            await h.runHook('loaded')
            // sitemap + uriIndex retired — sitemap is now backed by
            // the catalog's indexed meta_href column, queried via the
            // worker-side read-only sqlite handle in src/render.js.
            assert.deepEqual(h.runtime.state.layouts, { layouts: {} })
            assert.equal(h.runtime.options.layoutsFolder, path.join(workingFolder, 'layouts'))
        })
    })

    it('onSync CREATE registers a layout in state.layouts and writes a journal entry', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
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
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs.js' } })
            const entry = h.journal.find(e => e.operation === 'create')
            assert.equal(entry.entity.id, '/layouts/post.hbs')
        })
    })

    it('onSync DELETE removes the layout from state.layouts and writes a delete entry', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })
            assert.ok(h.runtime.state.layouts.layouts['post'])

            await h.runSync('layouts', { action: 'delete', context: { relativePath: 'post.hbs' } })

            assert.equal(h.runtime.state.layouts.layouts['post'], undefined)
            assert.equal(h.journal.filter(e => e.operation === 'delete').length, 1)
        })
    })

    it('onProcessed assigns a matched layout to the entity', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ autoLayouts: true })(h.core)
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
            // Sitemap presence is now equivalent to "the catalog has
            // this entity with meta.href set" — verified end-to-end by
            // the scenario tests against a real subprocess + sqlite.
            // Unit-level we just check the entity got its layout.
        })
    })

    it('warns when a render-requested entity (carries correlationId) matches no layout', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ autoLayouts: true })(h.core)
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
            })
            layouts({ autoLayouts: true })(h.core)
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
            layouts()(h.core)
            frontMatter()(h.core)
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
            layouts()(h.core)
            frontMatter()(h.core)
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
            layouts()(h.core)
            frontMatter()(h.core)
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
            layouts()(h.core)
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
        layouts()(h.core)
        assert.equal(await h.runSync('layouts', { action: 'create', context: {} }), false)
    })

    it('onComplete writes the rendered output to disk by default', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const h = createHarness({ options: { workingFolder, outputFolder } })
            layouts()(h.core)
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
            layouts()(h.core)
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

    // The cleanUrls × postprocess interaction lives in onBeforeRender's
    // destination-assignment block. The engine's postprocess queue is
    // now a plain changeExtension swap (no peek at runtime.config.layouts);
    // the layouts plugin compensates by leaving destination flat
    // (`/foo.html`) when the layout declares a postprocessor, so the
    // engine's swap naturally produces `/foo.pdf`. If layouts ever goes
    // back to writing `/foo/index.html` for a postprocessor-bearing
    // layout, the engine emits `/foo/index.pdf` and the served-URL
    // contract breaks. This test pins the decoupling.
    describe('cleanUrls × postprocess destination assignment', () => {
        // Harness for driving onBeforeRender against a single seeded
        // entity. Stubs the refs surface so the incremental dispatch
        // path picks the entity up via inverseClosureOf instead of the
        // SQL --force path (which would need useDatabase).
        async function runBeforeRender({ cleanUrls, postprocessor }) {
            return withTempWorking(async (workingFolder) => {
                const entity = {
                    id: '/documents/foo.md',
                    collection: 'documents',
                    type: 'document',
                    name: 'foo',
                    format: 'md',
                    time: 1,
                    meta: {},
                    layout: {
                        name: 'page',
                        template: 'hbs',
                        format: 'html',
                        ...(postprocessor ? { postprocessor } : {}),
                    },
                }
                const h = createHarness({
                    options: {
                        workingFolder,
                        outputFolder: path.join(workingFolder, 'out'),
                        force: false,
                    },
                    entities: [entity],
                })
                // Incremental-dispatch path: refs.inverseClosureOf returns
                // the seed set; manifest is left undefined (the ?. chains
                // tolerate it).
                h.runtime.refs = {
                    inverseClosureOf: () => new Set([entity.id]),
                }
                layouts({ cleanUrls })(h.core)
                await h.runHook('loaded')
                // Seed a journal mutation so the incremental dispatch's
                // useJournal walk finds it.
                h.journal.push({
                    id: 99,
                    entity,
                    operation: 'create',
                    context: {},
                    options: {},
                    output: null,
                })
                await h.runHook('beforeRender', { aborted: false })
                assert.equal(h.renderTasks.length, 1, 'expected one render task to be queued')
                return h.renderTasks[0].entity.destination
            })
        }

        it('cleanUrls on, no postprocessor → /foo/index.html (folder transform applied)', async () => {
            const dest = await runBeforeRender({ cleanUrls: true, postprocessor: null })
            assert.equal(dest, path.join('/foo', 'index.html'))
        })

        it('cleanUrls on, layout has postprocessor → /foo.html (folder transform skipped so engine swap yields /foo.<ext>)', async () => {
            const dest = await runBeforeRender({ cleanUrls: true, postprocessor: 'pdf' })
            assert.equal(dest, '/foo.html')
        })

        it('cleanUrls off, layout has postprocessor → /foo.html (basic shape, cleanUrls irrelevant)', async () => {
            const dest = await runBeforeRender({ cleanUrls: false, postprocessor: 'pdf' })
            assert.equal(dest, '/foo.html')
        })
    })

    it('onComplete writes the intermediate to previewFolder (not outputFolder) when options.save:false and a postprocessor is configured', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const previewFolder = path.join(workingFolder, 'runtime', 'preview')
            const h = createHarness({ options: { workingFolder, outputFolder, previewFolder } })
            layouts()(h.core)
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

describe('layouts plugin: multi-layouts (matching)', () => {
    it('meta.layouts array assigns multiple layouts to one entity', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts()(h.core)
            await h.runHook('loaded')
            // Layout names are derived from the filename minus its
            // template AND format extensions (see getFormatInfo). So
            // `post.html.hbs` has name 'post'; `post-email.eml.hbs` has
            // name 'post-email'. Distinct names → both land in the state
            // map.
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.html.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post-email.eml.hbs' } })

            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layouts: ['post', 'post-email'] },
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            assert.equal(doc.layouts.length, 2)
            assert.deepEqual(doc.layouts.map(l => l.name).sort(), ['post', 'post-email'])
            assert.equal(doc.layout.name, 'post', 'entity.layout back-compat = first layout')
        })
    })

    it('errors when both meta.layout and meta.layouts are set', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })

            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layout: 'post', layouts: ['post'] },
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            assert.deepEqual(doc.layouts, [], 'resolution failed → no layouts')
            const erred = h.logs.some(l =>
                l.level === 'error' && l.args.join(' ').includes('both \'meta.layout\' and \'meta.layouts\''))
            assert.ok(erred, 'should log a clear error about the dual-key collision')
        })
    })

    it('options.match patterns multi-match — every matching pattern contributes', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ match: { '@/blog/*': 'post', '@/**': 'fallback' } })(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'fallback.hbs' } })

            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: {},
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            // Both patterns match `/documents/blog/welcome.md` — get both layouts.
            assert.equal(doc.layouts.length, 2)
            const names = doc.layouts.map(l => l.name).sort()
            assert.deepEqual(names, ['fallback', 'post'])
        })
    })

    it('autoLayouts stays single-match (no multi-match fanout)', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ autoLayouts: true })(h.core)
            await h.runHook('loaded')
            // Single auto-layout candidate matches the entity name.
            // The peel ladder is intentionally first-wins; the test
            // verifies multi-match doesn't apply here (entity gets one
            // layout, not many).
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })

            const doc = {
                id: '/documents/post.md',
                collection: 'documents',
                name: 'post',
                format: 'md',
                meta: {},
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            assert.equal(doc.layouts.length, 1, 'autoLayouts is fallback-first-wins, not multi-match')
            assert.equal(doc.layouts[0].name, 'post')
        })
    })
})

describe('layouts plugin: multi-layouts (collision)', () => {
    it('drops both render tasks when two layouts produce the same destination', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layouts: ['post', 'post-card'] },
            }
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: [doc],
            })
            // Incremental-dispatch path: refs.inverseClosureOf returns
            // the seed; the dispatcher hydrates the entity by id.
            h.runtime.refs = { inverseClosureOf: () => new Set([doc.id]) }
            layouts()(h.core)
            await h.runHook('loaded')
            // Both layouts produce `.html` for the same entity name
            // (post → /welcome.html and post-card → /welcome.html).
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.html.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post-card.html.hbs' } })

            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            await h.runHook('beforeRender', { aborted: false })

            assert.equal(h.renderTasks.length, 0, 'collision must skip every task for the entity')
            const erred = h.logs.some(l =>
                l.level === 'error' && l.args.join(' ').includes('Layout collision'))
            assert.ok(erred, 'should log the collision with both layout names')
        })
    })

    it('no collision when two layouts produce different formats', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layouts: ['post', 'post-email'] },
            }
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: [doc],
            })
            h.runtime.refs = { inverseClosureOf: () => new Set([doc.id]) }
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.html.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post-email.eml.hbs' } })

            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            await h.runHook('beforeRender', { aborted: false })

            assert.equal(h.renderTasks.length, 2, 'one task per layout, different extensions')
            const destinations = h.renderTasks.map(t => t.entity.destination).sort()
            assert.deepEqual(destinations, ['/blog/welcome.eml', '/blog/welcome.html'])
        })
    })
})

describe('layouts plugin: multi-layouts (destination template)', () => {
    it('frontmatter destination template overrides the default derivation', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layouts: ['post-card'] },
            }
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: [doc],
            })
            h.runtime.refs = { inverseClosureOf: () => new Set([doc.id]) }
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post-card.html.hbs' } })
            // Inject meta.destination on the layout state entry (would
            // normally come from the front-matter plugin processing the
            // layout). resolveLayout falls back to stateEntry when the
            // catalog mock doesn't have the layout row.
            const cardLayout = h.runtime.state.layouts.layouts['post-card']
            cardLayout.meta = { destination: '/cards/{{entity.name}}.html' }

            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            await h.runHook('beforeRender', { aborted: false })

            assert.equal(h.renderTasks.length, 1)
            assert.equal(h.renderTasks[0].entity.destination, '/cards/blog/welcome.html')
        })
    })

    it('destination template that resolves to a path-traversal is rejected', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const doc = {
                id: '/documents/blog/x.md',
                collection: 'documents',
                name: 'blog/x',
                format: 'md',
                meta: { layouts: ['evil'] },
            }
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: [doc],
            })
            h.runtime.refs = { inverseClosureOf: () => new Set([doc.id]) }
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'evil.html.hbs' } })
            const evilLayout = h.runtime.state.layouts.layouts['evil']
            evilLayout.meta = { destination: '../../../etc/passwd' }

            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            await assert.rejects(
                () => h.runHook('beforeRender', { aborted: false }),
                /path-traversal/,
            )
        })
    })
})

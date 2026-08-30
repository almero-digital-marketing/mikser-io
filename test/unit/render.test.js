import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { parseReferences as parseHbs } from '../../src/plugins/render/hbs.js'

import { useRenderer } from '../../src/render.js'

// Build a minimal runtime-like object exposing the surface useRenderer
// uses: hooks.completed (array), and process() + update() the test
// controls. (In a real mikser run lifecycle.js attaches `update` to the
// runtime singleton on import; tests with a fake runtime supply their
// own.)
// Mirrors the real runtime surface render.js touches. `catalog` carries no
// `data.entities` because the live one has none — it holds cacheInvalidated /
// export / save (catalog.js). A fixture that invents the shape the code wants
// will agree with the code and disagree with production, which is how
// catalog:false came to be a no-op with a passing test.
function createFakeRuntime({ process, update = async () => { }, delete: del = async () => { } } = {}) {
    return {
        hooks: { completed: [] },
        process,
        update,
        delete: del,
        catalog: { cacheInvalidated: false, export: async () => [], save: async () => { } },
    }
}

describe('useRenderer', () => {
    it('resolves a single render request when the hook fires its correlation id', async () => {
        const updates = []
        const runtime = createFakeRuntime({
            update: async (entity) => updates.push(entity),
            process: async () => {
                const last = updates[updates.length - 1]
                for (const cb of [...runtime.hooks.completed]) {
                    await cb({ entity: last, output: { result: 'rendered html' } })
                }
            },
        })

        const { render } = useRenderer(runtime)
        const { output, entity } = await render({ id: '/a.md', collection: 'documents' })
        assert.equal(output.result, 'rendered html')
        assert.ok(entity.options?.correlationId)
    })

    // Regression: postprocessed layouts (*.html-mjml, *.html-pdf, …).
    // The postprocess chain writes the final bytes to disk and its
    // dispatcher (src/postprocess.js) returns undefined, so the final
    // completion arrives with output.result empty even though the bytes
    // exist on disk. useRenderer's contract is to return the FINAL
    // pipeline output, so it reads them back. Before the fix, this
    // resolved with a null result and the API /render endpoint 204'd.
    it('reads postprocessed bytes back from disk on save:false and removes the scratch file', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-pp-'))
        const previewFolder = path.join(dir, 'preview')
        await mkdir(path.join(previewFolder, 'en'), { recursive: true })
        await writeFile(path.join(previewFolder, 'en', 'welcome.html'), '<html>compiled mjml</html>')

        const updates = []
        const runtime = createFakeRuntime({
            update: async (e) => updates.push(e),
            process: async () => {
                const last = updates[updates.length - 1]
                // Simulate the FINAL (postprocess) completion: origin set,
                // output carries success but no result — exactly what the
                // engine hands over after src/postprocess.js returns undefined.
                for (const cb of [...runtime.hooks.completed]) {
                    await cb({ entity: { ...last, origin: '/en/welcome.mjml' }, output: { success: true } })
                }
            },
        })
        runtime.options = { previewFolder, outputFolder: path.join(dir, 'out') }

        const { render } = useRenderer(runtime)
        const { output } = await render(
            { id: '/en/welcome', layout: { postprocessor: 'mjml' }, destination: '/en/welcome.html', collection: 'documents' },
            { save: false },
        )
        const text = Buffer.isBuffer(output.result) ? output.result.toString('utf8') : output.result
        assert.equal(text, '<html>compiled mjml</html>')
        // save:false → the previewFolder scratch file must be gone.
        assert.equal(existsSync(path.join(previewFolder, 'en', 'welcome.html')), false)
    })

    it('reads postprocessed bytes back on save:true and keeps the output file', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-pp-'))
        const outputFolder = path.join(dir, 'out')
        await mkdir(path.join(outputFolder, 'en'), { recursive: true })
        await writeFile(path.join(outputFolder, 'en', 'welcome.html'), '<html>saved mjml</html>')

        const updates = []
        const runtime = createFakeRuntime({
            update: async (e) => updates.push(e),
            process: async () => {
                const last = updates[updates.length - 1]
                for (const cb of [...runtime.hooks.completed]) {
                    await cb({ entity: { ...last, origin: '/en/welcome.mjml' }, output: { success: true } })
                }
            },
        })
        runtime.options = { previewFolder: path.join(dir, 'preview'), outputFolder }

        const { render } = useRenderer(runtime)
        const { output } = await render(
            { id: '/en/welcome', layout: { postprocessor: 'mjml' }, destination: '/en/welcome.html', collection: 'documents' },
            { save: true },
        )
        const text = Buffer.isBuffer(output.result) ? output.result.toString('utf8') : output.result
        assert.equal(text, '<html>saved mjml</html>')
        // save:true → the output file stays on disk.
        assert.equal(existsSync(path.join(outputFolder, 'en', 'welcome.html')), true)
    })

    it('does not read disk for a render-only entity (no postprocessor)', async () => {
        // A plain layout's bytes are already in output.result; the
        // read-back path must not fire (no postprocessor → untouched).
        const updates = []
        const runtime = createFakeRuntime({
            update: async (e) => updates.push(e),
            process: async () => {
                const last = updates[updates.length - 1]
                for (const cb of [...runtime.hooks.completed]) {
                    await cb({ entity: last, output: { result: 'plain html' } })
                }
            },
        })
        runtime.options = { previewFolder: '/nonexistent', outputFolder: '/nonexistent' }

        const { render } = useRenderer(runtime)
        const { output } = await render({ id: '/plain', collection: 'documents' }, { save: false })
        assert.equal(output.result, 'plain html')
    })

    it('routes outputs to the right correlation id in a concurrent batch', async () => {
        const updates = []
        const runtime = createFakeRuntime({
            update: async (entity) => updates.push(entity),
            process: async () => {
                // simulate a real cycle: 20 ms of work, then resolve everyone
                await new Promise(r => setTimeout(r, 20))
                for (const upd of updates) {
                    for (const cb of [...runtime.hooks.completed]) {
                        await cb({
                            entity: upd,
                            output: { result: `result-for-${upd.id}` },
                        })
                    }
                }
                updates.length = 0
            },
        })

        const { render } = useRenderer(runtime)
        const ids = ['/a', '/b', '/c', '/d', '/e']
        const results = await Promise.all(ids.map(id => render({ id })))
        for (let i = 0; i < ids.length; i++) {
            assert.equal(results[i].output.result, `result-for-${ids[i]}`)
        }
    })

    it('coalesces concurrent renders into fewer process() cycles than requests', async () => {
        let cycleCount = 0
        const updates = []
        const runtime = createFakeRuntime({
            update: async (e) => updates.push(e),
            process: async () => {
                cycleCount++
                await new Promise(r => setTimeout(r, 30))
                for (const upd of updates) {
                    for (const cb of [...runtime.hooks.completed]) {
                        await cb({ entity: upd, output: { result: 'ok' } })
                    }
                }
                updates.length = 0
            },
        })
        const { render } = useRenderer(runtime)

        const N = 6
        await Promise.all(Array.from({ length: N }, (_, i) => render({ id: `/e${i}` })))
        assert.ok(cycleCount < N, `expected < ${N} cycles, got ${cycleCount}`)
    })

    it('rejects with a timeout when the cycle hangs past the configured timeout', async () => {
        const runtime = createFakeRuntime({
            process: () => new Promise(() => { }), // never resolves
        })
        const { render } = useRenderer(runtime, { defaultTimeout: 40 })
        await assert.rejects(() => render({ id: '/x' }), /Render timeout/)
    })

    it('rejects "did not complete" when the cycle returns without firing the hook', async () => {
        const runtime = createFakeRuntime({
            process: async () => { /* no-op */ },
        })
        const { render } = useRenderer(runtime)
        await assert.rejects(() => render({ id: '/y' }), /did not complete/)
    })

    it('tags the "did not complete" error with status 422 and an actionable, layout-aware message', async () => {
        const runtime = createFakeRuntime({ process: async () => { /* no-op */ } })
        const { render } = useRenderer(runtime)

        // No meta.layout → message explains "no layout matched" + the fix.
        await assert.rejects(
            () => render({ id: '/no-layout.md' }),
            (err) => {
                assert.equal(err.status, 422)
                assert.match(err.message, /no meta\.layout and matched no layout/)
                assert.match(err.message, /layouts\.match rule/)
                return true
            },
        )

        // meta.layout set → message points at "Layout not found" / "Render error".
        await assert.rejects(
            () => render({ id: '/bad-layout.md', meta: { layout: 'ghost' } }),
            (err) => {
                assert.equal(err.status, 422)
                assert.match(err.message, /requested layout "ghost"/)
                assert.match(err.message, /Layout not found|Render error/)
                return true
            },
        )
    })

    it('cleans up its completed hook after each batch', async () => {
        const runtime = createFakeRuntime({
            process: async () => {
                for (const cb of [...runtime.hooks.completed]) {
                    await cb({ entity: { options: { correlationId: '???' } }, output: null })
                }
            },
        })
        const { render } = useRenderer(runtime)
        await assert.rejects(() => render({ id: '/z' }))
        assert.equal(runtime.hooks.completed.length, 0, 'should not leak hooks across batches')
    })

    // The pruning contract. Asserted through runtime.delete — the journal
    // helper — because that is what actually reaches sqlite. Row lifetime is
    // decided at onPersist, so anything that does not journal does not prune.
    function pruneHarness() {
        const updates = []
        const deletes = []
        const runtime = createFakeRuntime({
            update: async (e) => updates.push(e),
            delete: async (e) => deletes.push(e),
            process: async () => {
                for (const upd of updates) {
                    for (const cb of [...runtime.hooks.completed]) {
                        await cb({ entity: upd, output: { result: 'rendered' } })
                    }
                }
                updates.length = 0
            },
        })
        return { runtime, deletes }
    }

    it('keeps the catalog row by default (matches mikser persist behavior)', async () => {
        const { runtime, deletes } = pruneHarness()
        const { render } = useRenderer(runtime)
        await render({ id: '/kept', type: 'document', collection: 'documents' })
        assert.deepEqual(deletes, [])
    })

    it('catalog: false + save: false journals a DELETE for the row', async () => {
        const { runtime, deletes } = pruneHarness()
        const { render } = useRenderer(runtime)
        await render(
            { id: '/transient', type: 'document', collection: 'documents' },
            { catalog: false, save: false },
        )
        assert.equal(deletes.length, 1)
        assert.equal(deletes[0].id, '/transient')
    })

    it('catalog: false alone keeps the row — pruning would unlink the output', async () => {
        const { runtime, deletes } = pruneHarness()
        const { render } = useRenderer(runtime)
        await render(
            { id: '/written', type: 'document', collection: 'documents' },
            { catalog: false },
        )
        assert.deepEqual(deletes, [], 'a saved render must keep its row rather than lose its file')
    })

    it('ambiguous falsey values are not an opt-out', async () => {
        for (const catalog of [null, 0, 'false']) {
            const { runtime, deletes } = pruneHarness()
            const { render } = useRenderer(runtime)
            await render({ id: '/x', type: 'document', collection: 'documents' }, { catalog, save: false })
            assert.deepEqual(deletes, [], `catalog: ${JSON.stringify(catalog)} must not prune`)
        }
    })

    it('save: false — sets entity.options.save = false so layouts.onComplete skips the disk write', async () => {
        let submitted
        const runtime = createFakeRuntime({
            update: async (e) => { submitted = e },
            process: async () => {
                for (const cb of [...runtime.hooks.completed]) {
                    await cb({ entity: submitted, output: { result: 'rendered' } })
                }
            },
        })

        const { render } = useRenderer(runtime)
        await render({ id: '/no-save', type: 'document', collection: 'documents' }, { save: false })

        assert.equal(submitted.options.save, false)
    })

    it('save: true (default) — does NOT set entity.options.save (clean options)', async () => {
        let submitted
        const runtime = createFakeRuntime({
            update: async (e) => { submitted = e },
            process: async () => {
                for (const cb of [...runtime.hooks.completed]) {
                    await cb({ entity: submitted, output: { result: 'r' } })
                }
            },
        })

        const { render } = useRenderer(runtime)
        await render({ id: '/saved', type: 'document', collection: 'documents' })

        assert.equal('save' in submitted.options, false, 'should not set save on the default path')
    })

    it('save: only the literal false sets the opt-out (strict)', async () => {
        for (const value of [null, undefined, 0, '', 'false', 'no', true]) {
            let submitted
            const runtime = createFakeRuntime({
                update: async (e) => { submitted = e },
                process: async () => {
                    for (const cb of [...runtime.hooks.completed]) {
                        await cb({ entity: submitted, output: { result: 'r' } })
                    }
                },
            })
            const { render } = useRenderer(runtime)
            await render({ id: '/s', type: 'document', collection: 'documents' }, { save: value })
            assert.equal('save' in submitted.options, false, `save: ${JSON.stringify(value)} should not opt out`)
        }
    })

    it('catalog: only the literal false triggers cleanup (strict)', async () => {
        for (const value of [null, undefined, 0, '', 'false', 'no']) {
            const entities = [{ id: '/strict', collection: 'documents' }]
            const updates = []
            const runtime = createFakeRuntime({
                entities,
                update: async (e) => updates.push(e),
                process: async () => {
                    for (const upd of updates) {
                        for (const cb of [...runtime.hooks.completed]) {
                            await cb({ entity: upd, output: { result: 'r' } })
                        }
                    }
                    updates.length = 0
                },
            })
            const { render } = useRenderer(runtime)
            await render({ id: '/strict', type: 'document', collection: 'documents' }, { catalog: value })
            assert.equal(entities.length, 1, `catalog: ${JSON.stringify(value)} should keep the row`)
        }
    })

    it('respects a per-call timeout override', async () => {
        const runtime = createFakeRuntime({
            process: () => new Promise(() => { }),
        })
        const { render } = useRenderer(runtime, { defaultTimeout: 60_000 })
        const start = Date.now()
        await assert.rejects(() => render({ id: '/x' }, { timeout: 30 }), /Render timeout/)
        const elapsed = Date.now() - start
        assert.ok(elapsed < 200, `should time out fast, elapsed=${elapsed}ms`)
    })
})

// A key read only behind a guard is not a missing key.
//
// The contract exists so an editor can be told what a layout needs. Reporting
// every key as required makes an optional section look like a gap, and sends
// someone chasing a field the page never wanted — which is the failure the
// whole contract was built to prevent, arriving from the other side.
describe('handlebars: optional keys', () => {
    const parse = (src) => parseHbs(src)

    it('marks what is read inside an if as tolerated', () => {
        const r = parse('{{#if hero}}<img src={{hero.image}}>{{/if}}')
        assert.ok(r.optional.includes('hero.image'))
    })

    it('keeps the condition itself required', () => {
        // `{{#if hero}}` reads `hero` to decide. That read always happens.
        const r = parse('{{#if hero}}<img src={{hero.image}}>{{/if}}')
        assert.ok(!r.optional.includes('hero'), 'the condition is not optional — it is how the choice is made')
        assert.ok(r.variables.includes('hero'))
    })

    it('treats unless the same way', () => {
        const r = parse('{{#unless compact}}<p>{{summary}}</p>{{/unless}}')
        assert.ok(r.optional.includes('summary'))
        assert.ok(!r.optional.includes('compact'))
    })

    it('does not treat each or with as guards', () => {
        // They narrow scope; they do not make the content conditional on a
        // key being present. A key read inside one is read whenever the block
        // runs at all.
        const r = parse('{{#each cases as |c|}}{{c.name}}{{/each}}{{#with hero}}{{title}}{{/with}}')
        assert.deepEqual(r.optional, [])
    })

    it('reports nothing optional when nothing is guarded', () => {
        assert.deepEqual(parse('<h1>{{title}}</h1>').optional, [])
    })

    it('returns the field even for an empty template, so no caller branches', () => {
        assert.deepEqual(parse('').optional, [])
    })
})

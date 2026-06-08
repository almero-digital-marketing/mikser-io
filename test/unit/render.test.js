import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { useRenderer } from '../../src/render.js'

// Build a minimal runtime-like object exposing the surface useRenderer
// uses: hooks.completed (array), and process() + update() the test
// controls. (In a real mikser run lifecycle.js attaches `update` to the
// runtime singleton on import; tests with a fake runtime supply their
// own.)
function createFakeRuntime({ process, update = async () => { }, delete: del = async () => { }, entities = [] } = {}) {
    return {
        hooks: { completed: [] },
        process,
        update,
        delete: del,
        catalog: { data: { entities } },
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

    it('keeps the catalog row by default (matches mikser persist behavior)', async () => {
        const updates = []
        // Seed the catalog with an existing entry (simulating that the
        // persist phase wrote it during the cycle).
        const entities = [{ id: '/kept', collection: 'documents' }]
        const runtime = createFakeRuntime({
            entities,
            update: async (e) => updates.push(e),
            process: async () => {
                for (const upd of updates) {
                    for (const cb of [...runtime.hooks.completed]) {
                        await cb({ entity: upd, output: { result: 'rendered' } })
                    }
                }
                updates.length = 0
            },
        })

        const { render } = useRenderer(runtime)
        await render({ id: '/kept', type: 'document', collection: 'documents' })

        assert.equal(entities.length, 1)
        assert.equal(entities[0].id, '/kept')
    })

    it('catalog: false — explicit opt-out prunes the catalog row', async () => {
        const updates = []
        const entities = [{ id: '/transient', collection: 'documents' }]
        const runtime = createFakeRuntime({
            entities,
            update: async (e) => updates.push(e),
            process: async () => {
                for (const upd of updates) {
                    for (const cb of [...runtime.hooks.completed]) {
                        await cb({ entity: upd, output: { result: 'rendered' } })
                    }
                }
                updates.length = 0
            },
        })

        const { render } = useRenderer(runtime)
        await render(
            { id: '/transient', type: 'document', collection: 'documents' },
            { catalog: false },
        )

        // Catalog row gone — but no fake "delete" or "process" calls
        // happened: the cleanup is in-memory removal, not a DELETE journal
        // entry that would also unlink the file.
        assert.equal(entities.length, 0)
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

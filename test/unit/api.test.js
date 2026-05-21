import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { useRenderer, useCollection } from '../../src/api.js'

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

describe('api: useRenderer', () => {
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
        assert.ok(entity._correlationId)
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

    it('cleans up its completed hook after each batch', async () => {
        const runtime = createFakeRuntime({
            process: async () => {
                for (const cb of [...runtime.hooks.completed]) {
                    await cb({ entity: { _correlationId: '???' }, output: null })
                }
            },
        })
        const { render } = useRenderer(runtime)
        await assert.rejects(() => render({ id: '/z' }))
        assert.equal(runtime.hooks.completed.length, 0, 'should not leak hooks across batches')
    })

    it('transient by default — removes the entity from the catalog after the render', async () => {
        const updates = []
        // Seed the catalog with an existing entry (simulating that the
        // persist phase wrote it during the cycle).
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
        await render({ id: '/transient', type: 'document', collection: 'documents' })

        // Catalog row gone — but no fake "delete" or "process" calls
        // happened: the cleanup is in-memory removal, not a DELETE journal
        // entry that would also unlink the file.
        assert.equal(entities.length, 0)
    })

    it('persistent: true — keeps the catalog row', async () => {
        const updates = []
        const entities = [{ id: '/persistent', collection: 'documents' }]
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
            { id: '/persistent', type: 'document', collection: 'documents' },
            { persistent: true },
        )

        assert.equal(entities.length, 1)
        assert.equal(entities[0].id, '/persistent')
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

describe('api: useCollection', () => {
    async function withTempCollection(fn) {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-api-'))
        try {
            const docsFolder = path.join(dir, 'documents')
            await mkdir(docsFolder, { recursive: true })
            const runtime = { options: { workingFolder: dir, documentsFolder: docsFolder } }
            return await fn({ runtime, dir, docsFolder })
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    }

    it('exposes name and folder on the returned binding', async () => {
        await withTempCollection(async ({ runtime, docsFolder }) => {
            const docs = useCollection(runtime, 'documents')
            assert.equal(docs.name, 'documents')
            assert.equal(docs.folder, docsFolder)
        })
    })

    it('write() creates the file and any missing parent directories', async () => {
        await withTempCollection(async ({ runtime, docsFolder }) => {
            const docs = useCollection(runtime, 'documents')
            await docs.write('en/posts/hello.md', '# Hi')
            const content = await readFile(path.join(docsFolder, 'en/posts/hello.md'), 'utf8')
            assert.equal(content, '# Hi')
        })
    })

    it('write() returns the absolute uri of the file it wrote', async () => {
        await withTempCollection(async ({ runtime, docsFolder }) => {
            const docs = useCollection(runtime, 'documents')
            const uri = await docs.write('note.md', 'x')
            assert.equal(uri, path.join(docsFolder, 'note.md'))
        })
    })

    it('write() throws "Unknown collection" when the binding\'s folder option is absent', async () => {
        const layouts = useCollection({ options: {} }, 'layouts')
        await assert.rejects(() => layouts.write('x.hbs', '...'), /Unknown collection: layouts/)
    })

    it('remove() unlinks an existing file', async () => {
        await withTempCollection(async ({ runtime, docsFolder }) => {
            const file = path.join(docsFolder, 'a.md')
            await writeFile(file, 'x')
            const docs = useCollection(runtime, 'documents')
            await docs.remove('a.md')
            await assert.rejects(() => readFile(file, 'utf8'), { code: 'ENOENT' })
        })
    })

    it('remove() throws "Unknown collection" when the binding\'s folder option is absent', async () => {
        const layouts = useCollection({ options: {} }, 'layouts')
        await assert.rejects(() => layouts.remove('x.hbs'), /Unknown collection: layouts/)
    })

    it('reading .folder throws if the collection has not been loaded yet', async () => {
        const layouts = useCollection({ options: {} }, 'layouts')
        assert.throws(() => layouts.folder, /Unknown collection: layouts/)
    })

    it('binding is lazy — useCollection() succeeds even before the folder is set', () => {
        const docs = useCollection({ options: {} }, 'documents')
        // Doesn't throw; resolution happens on actual use.
        assert.equal(docs.name, 'documents')
    })
})

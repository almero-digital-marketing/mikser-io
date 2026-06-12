import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { documents } from '../../../src/plugins/documents.js'
import { createHarness } from '../plugin-harness.js'

async function withTempWorking(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-docs-'))
    try { return await fn(dir) }
    finally { await rm(dir, { recursive: true, force: true }) }
}

describe('documents plugin', () => {
    it('exposes the documents collection identifier', () => {
        const h = createHarness()
        const result = documents()(h.core)
        assert.deepEqual(result, { collection: 'documents', type: 'document' })
    })

    it('registers onLoaded, onImport, and a documents onSync handler', () => {
        const h = createHarness()
        documents()(h.core)
        assert.equal(h.hooks.loaded.length, 1)
        assert.equal(h.hooks.import.length, 1)
        assert.ok(h.sync.has('documents'))
    })

    it('on onLoaded, computes documentsFolder under workingFolder', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder }, config: {} })
            documents()(h.core)
            await h.runHook('loaded')
            assert.equal(h.runtime.options.documentsFolder, path.join(workingFolder, 'documents'))
            assert.deepEqual(h.watchers, [{ name: 'documents', folder: path.join(workingFolder, 'documents') }])
        })
    })

    it('honors a custom documentsFolder from config', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder },
            })
            documents({ documentsFolder: 'content' })(h.core)
            await h.runHook('loaded')
            assert.equal(h.runtime.options.documentsFolder, path.join(workingFolder, 'content'))
        })
    })

    it('onSync CREATE adds a create-entity journal entry with content', async () => {
        await withTempWorking(async (workingFolder) => {
            const docsFolder = path.join(workingFolder, 'documents')
            const h = createHarness({
                options: { workingFolder, documentsFolder: docsFolder },
            })
            documents()(h.core)
            await h.runHook('loaded')

            await writeFile(path.join(docsFolder, 'post.md'), '# hi')
            await h.runSync('documents', { action: 'create', context: { relativePath: 'post.md' } })

            const creates = h.journal.filter(e => e.operation === 'create')
            assert.equal(creates.length, 1)
            const e = creates[0].entity
            assert.equal(e.id, '/documents/post.md')
            assert.equal(e.collection, 'documents')
            assert.equal(e.type, 'document')
            assert.equal(e.format, 'md')
            assert.equal(e.name, 'post')
            assert.equal(e.content, '# hi')
        })
    })

    it('onSync UPDATE writes an update entry', async () => {
        await withTempWorking(async (workingFolder) => {
            const docsFolder = path.join(workingFolder, 'documents')
            const h = createHarness({ options: { workingFolder, documentsFolder: docsFolder } })
            documents()(h.core)
            await h.runHook('loaded')

            await writeFile(path.join(docsFolder, 'post.md'), 'changed')
            await h.runSync('documents', { action: 'update', context: { relativePath: 'post.md' } })

            const updates = h.journal.filter(e => e.operation === 'update')
            assert.equal(updates.length, 1)
            assert.equal(updates[0].entity.content, 'changed')
        })
    })

    it('onSync DELETE writes a sparse delete entry (id, collection, type)', async () => {
        // The documents plugin passes a `format` to deleteEntity but the
        // real lifecycle.deleteEntity (and the harness's stand-in) only
        // forwards id/collection/type, by design — DELETE entries are
        // intentionally sparse.
        const h = createHarness({ options: { documentsFolder: '/tmp/x' } })
        documents()(h.core)
        await h.runSync('documents', { action: 'delete', context: { relativePath: 'gone.md' } })
        const deletes = h.journal.filter(e => e.operation === 'delete')
        assert.equal(deletes.length, 1)
        assert.deepEqual(deletes[0].entity, {
            id: '/documents/gone.md',
            collection: 'documents',
            type: 'document',
        })
    })

    it('onSync returns false when relativePath is missing', async () => {
        const h = createHarness()
        documents()(h.core)
        const result = await h.runSync('documents', { action: 'create', context: {} })
        assert.equal(result, false)
    })

    it('onImport creates entries for every file under documentsFolder', async () => {
        await withTempWorking(async (workingFolder) => {
            const docsFolder = path.join(workingFolder, 'documents')
            await rm(docsFolder, { recursive: true, force: true })
            const h = createHarness({ options: { workingFolder } })
            documents()(h.core)
            await h.runHook('loaded') // creates the folder
            await writeFile(path.join(docsFolder, 'a.md'), 'A')
            await writeFile(path.join(docsFolder, 'b.md'), 'B')
            await h.runHook('import')

            const creates = h.journal.filter(e => e.operation === 'create')
            assert.equal(creates.length, 2)
            const ids = creates.map(c => c.entity.id).sort()
            assert.deepEqual(ids, ['/documents/a.md', '/documents/b.md'])
        })
    })
})

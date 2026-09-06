import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { files } from '../../../src/plugins/files.js'
import { createHarness } from '../plugin-harness.js'

async function withTempWorking(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-files-'))
    try { return await fn(dir) }
    finally { await rm(dir, { recursive: true, force: true }) }
}

describe('files plugin', () => {
    it('returns its collection identifier', () => {
        const h = createHarness()
        const result = files()(h.core)
        assert.equal(result.collection, 'files')
        assert.equal(result.type, 'file')
        // How the runtime knows this plugin loaded, and from where.
        assert.match(result.module, /plugins\/files\.js$/)
    })

    it('registers onLoaded, onImport, and a files onSync handler', () => {
        const h = createHarness()
        files()(h.core)
        assert.equal(h.hooks.loaded.length, 1)
        assert.equal(h.hooks.import.length, 1)
        assert.ok(h.sync.has('files'))
    })

    it('computes filesFolder under workingFolder on onLoaded', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder } })
            files()(h.core)
            await h.runHook('loaded')
            assert.equal(h.runtime.options.filesFolder, path.join(workingFolder, 'files'))
        })
    })

    it('onSync CREATE writes an entity and symlinks into outputFolder', async () => {
        await withTempWorking(async (workingFolder) => {
            const filesFolder = path.join(workingFolder, 'files')
            const outputFolder = path.join(workingFolder, 'out')
            await mkdir(filesFolder, { recursive: true })
            await mkdir(outputFolder, { recursive: true })
            await writeFile(path.join(filesFolder, 'app.js'), 'hi')

            const h = createHarness({ options: { workingFolder, filesFolder, outputFolder } })
            files()(h.core)
            await h.runSync('files', { action: 'create', context: { relativePath: 'app.js' } })

            const creates = h.journal.filter(e => e.operation === 'create')
            assert.equal(creates.length, 1)
            const e = creates[0].entity
            assert.equal(e.id, '/files/app.js')
            assert.equal(e.collection, 'files')
            assert.equal(e.type, 'file')
            assert.equal(e.format, 'js')
            assert.equal(typeof e.checksum, 'string')

            // Verify symlink got created
            const linked = await readlink(path.join(outputFolder, 'app.js'))
            assert.equal(linked, path.resolve(path.join(filesFolder, 'app.js')))
        })
    })

    it('onSync CREATE honors files.outputFolder for the link target', async () => {
        await withTempWorking(async (workingFolder) => {
            const filesFolder = path.join(workingFolder, 'files')
            const outputFolder = path.join(workingFolder, 'out')
            await mkdir(filesFolder, { recursive: true })
            await mkdir(outputFolder, { recursive: true })
            await writeFile(path.join(filesFolder, 'main.css'), 'a {}')

            const h = createHarness({
                options: { workingFolder, filesFolder, outputFolder },
            })
            files({ outputFolder: 'public' })(h.core)
            await h.runSync('files', { action: 'create', context: { relativePath: 'main.css' } })

            const e = h.journal.find(j => j.operation === 'create').entity
            // The LINK moves with options.outputFolder; the uri does not,
            // because it names the source. `name` and meta.url carry the
            // served location.
            assert.equal(e.uri, path.join(filesFolder, 'main.css'))
            assert.equal(e.name, path.join('public', 'main.css'))
            assert.equal(e.meta.url, '/public/main.css')
        })
    })

    it('onSync DELETE writes a sparse delete entry and removes the symlink', async () => {
        await withTempWorking(async (workingFolder) => {
            const filesFolder = path.join(workingFolder, 'files')
            const outputFolder = path.join(workingFolder, 'out')
            await mkdir(filesFolder, { recursive: true })
            await mkdir(outputFolder, { recursive: true })
            await writeFile(path.join(filesFolder, 'gone.txt'), 'x')

            const h = createHarness({ options: { workingFolder, filesFolder, outputFolder } })
            files()(h.core)
            await h.runSync('files', { action: 'create', context: { relativePath: 'gone.txt' } })
            await h.runSync('files', { action: 'delete', context: { relativePath: 'gone.txt' } })

            const deletes = h.journal.filter(e => e.operation === 'delete')
            assert.equal(deletes.length, 1)
            assert.deepEqual(deletes[0].entity, { id: '/files/gone.txt', collection: 'files', type: 'file' })

            // Symlink should be gone
            await assert.rejects(() => readlink(path.join(outputFolder, 'gone.txt')))
        })
    })

    it('onSync returns false when relativePath is missing', async () => {
        const h = createHarness()
        files()(h.core)
        assert.equal(await h.runSync('files', { action: 'create', context: {} }), false)
    })
})

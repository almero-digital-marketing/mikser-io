// --force reconciles deletions, like every other build.
//
// It used to be the one flag that could not fix what it is reached for.
// sweepDeleted opened with `if (runtime.options.force) return 0` on a stated
// premise — "operator wants a full rebuild; deletes still flow naturally on
// the rebuild" — which is not true, and takes one command to disprove: delete
// a document, run `mikser --force`, and both the entity and its output are
// still there, while an ordinary build removes them.
//
// Nothing about --force wipes the catalog. That is --clear. So a row for a
// file that no longer exists simply survives, and the flag people reach for
// when something is stale was the flag that left it stale.
//
// It is safe to run because `scanned` is populated from the glob BEFORE any
// gate — --force defeats the checksum gate, not the scan — so the set the
// sweep subtracts from is exactly as complete either way.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, readCatalog } from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), files(), frontMatter(), layouts(), renderHbs()] }
`
const FILES = {
    'mikser.config.js': CONFIG,
    'layouts/page.html.hbs': '<!doctype html><body>x</body>',
    'documents/keep.html': '---\nlayout: page\n---\n',
    'documents/gone.html': '---\nlayout: page\n---\n',
    'files/media/keep.jpg': 'kept',
    'files/media/gone.jpg': 'about to go',
}
const linked = (workdir, p) => {
    try { return !!lstatSync(path.join(workdir, p)) } catch { return false }
}

describe('a deletion reconciled by --force', () => {
    const workdir = freshWorkdir('force-reconciles')
    after(() => cleanup(workdir))
    let ids

    before(async () => {
        await setupFixture(workdir, FILES)
        assert.equal((await runMikser(workdir)).code, 0)

        await rm(path.join(workdir, 'documents/gone.html'))
        await rm(path.join(workdir, 'files/media/gone.jpg'))

        // --force ONLY. If the sweep still skipped it, nothing below would be
        // cleaned, because no ordinary build runs in this test.
        const { code, combined } = await runMikser(workdir, ['--force'])
        assert.equal(code, 0, combined)
        ids = (await readCatalog(workdir)).entities.map(e => e.id)
    })

    it('removes the deleted document from the catalog', () => {
        assert.equal(ids.includes('/documents/gone.html'), false, ids.join(', '))
    })

    it('removes the output that document had written', () => {
        assert.equal(existsSync(path.join(workdir, 'out/gone/index.html')), false)
    })

    it('removes the deleted file and the symlink it published', () => {
        assert.equal(ids.includes('/files/media/gone.jpg'), false, ids.join(', '))
        assert.equal(linked(workdir, 'out/media/gone.jpg'), false,
            'a dangling symlink is what --force used to leave')
    })

    it('leaves everything that still exists', () => {
        assert.ok(ids.includes('/documents/keep.html'))
        assert.ok(ids.includes('/files/media/keep.jpg'))
        assert.equal(existsSync(path.join(workdir, 'out/keep/index.html')), true)
        assert.equal(linked(workdir, 'out/media/keep.jpg'), true)
    })

    it('sweeps nothing on an ORDINARY rebuild, where the gate skips everything', async () => {
        // The catastrophic case, and the one --force cannot expose: on an
        // incremental build the checksum gate returns early for every
        // unchanged file. `scanned` is populated before that return, so the
        // sweep still sees them. If it were populated after, a second build of
        // an unchanged site would find nothing scanned and delete the entire
        // corpus — every entity and every output it had written.
        const before = (await readCatalog(workdir)).entities.map(e => e.id).sort()
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)

        const after = (await readCatalog(workdir)).entities.map(e => e.id).sort()
        assert.deepEqual(after, before,
            `an unchanged rebuild must not lose entities\n${combined}`)
        assert.equal(existsSync(path.join(workdir, 'out/keep/index.html')), true,
            'nor the output they had written')
        assert.equal(linked(workdir, 'out/media/keep.jpg'), true)
        assert.doesNotMatch(combined, /removed \(file gone\)/, combined)
    })

    it('sweeps nothing on a forced build where nothing was deleted', async () => {
        // The failure mode worth guarding: --force defeats the checksum gate,
        // so every file re-registers. If `scanned` were populated after the
        // gate rather than before, a forced build would read the whole corpus
        // as deleted.
        const { code, combined } = await runMikser(workdir, ['--force'])
        assert.equal(code, 0, combined)
        assert.doesNotMatch(combined, /Files removed:/, combined)
        const after = (await readCatalog(workdir)).entities.map(e => e.id)
        assert.deepEqual(after.sort(), ids.sort(), 'a forced rebuild must not lose entities')
        assert.equal(linked(workdir, 'out/media/keep.jpg'), true)
    })
})

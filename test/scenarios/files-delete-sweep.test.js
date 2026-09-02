// A file deleted while nothing was watching has to be reconciled by the scan.
//
// files() publishes by symlinking the source into the output. Deletes were
// handled only by the watch path — onSync ACTION.DELETE — so the reconciliation
// depended on a watcher having been running at the moment the file
// disappeared. The cold scan enumerated what exists and never asked the
// opposite question, which left three things behind on every later build:
//
//   a DANGLING SYMLINK in the deployed output
//   the catalog row
//   anything derived from it
//
// Neither a plain rebuild nor --force removed them. Only --clear did.
//
// It could not simply be fixed, because sweepDeleted scopes itself by `uri`
// rooted at the folder a source owns — and `uri` for a file entity used to be
// the symlink in the OUTPUT, not the source. Pointing the sweep at the files
// folder would have matched nothing and swept nothing, silently, forever;
// pointing it at the output folder would have claimed every entity any other
// plugin emitted into this collection. Making `uri` mean the source, as it
// does in every other collection, is what makes the scope expressible.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup, freshWorkdir, readCatalog,
} from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), files(), frontMatter(), layouts(), renderHbs()] }
`

const has = (workdir, p) => {
    // lstat, not existsSync: a DANGLING symlink is exactly what this is about,
    // and existsSync follows the link and reports false for one.
    try { return !!lstatSync(path.join(workdir, p)) } catch { return false }
}

describe('a file deleted with nothing watching', () => {
    const workdir = freshWorkdir('files-delete-sweep')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'files/media/keep.jpg': 'kept',
            'files/media/gone.jpg': 'about to be deleted',
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
        })
        const first = await runMikser(workdir)
        assert.equal(first.code, 0, first.combined)
        assert.equal(has(workdir, 'out/media/gone.jpg'), true, 'it should be published first')

        await rm(path.join(workdir, 'files/media/gone.jpg'))
        const second = await runMikser(workdir)
        assert.equal(second.code, 0, second.combined)
        out = second.combined
    })

    it('removes the symlink the deleted file left in the output', () => {
        assert.equal(has(workdir, 'out/media/gone.jpg'), false,
            'a dangling symlink in the deployed output is what this leaves behind')
    })

    it('removes the catalog row, so nothing answers for a file that is gone', async () => {
        const { entities } = await readCatalog(workdir)
        const ids = entities.map(e => e.id)
        assert.equal(ids.includes('/files/media/gone.jpg'), false, ids.join(', '))
    })

    it('leaves every file that still exists alone', async () => {
        assert.equal(has(workdir, 'out/media/keep.jpg'), true,
            'a sweep that takes live files with it is worse than no sweep')
        assert.equal(existsSync(path.join(workdir, 'out/media/keep.jpg')), true,
            'and the surviving link still resolves')
        const { entities } = await readCatalog(workdir)
        assert.ok(entities.some(e => e.id === '/files/media/keep.jpg'))
    })

    it('says what it removed rather than doing it silently', () => {
        assert.match(out, /Files removed: 1 no longer on disk/, out)
    })

    it('stays quiet when nothing was deleted', async () => {
        const { combined } = await runMikser(workdir)
        assert.doesNotMatch(combined, /Files removed:/,
            `a line on every build is a line nobody reads\n${combined}`)
    })
})

describe('the uri that makes the sweep possible', () => {
    const workdir = freshWorkdir('files-uri')
    after(() => cleanup(workdir))

    it('names the source file, like every other collection', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'files/styles/base.css': '.a{}',
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
        })
        await runMikser(workdir)
        const { entities } = await readCatalog(workdir)
        const file = entities.find(e => e.id === '/files/styles/base.css')
        assert.ok(file, 'the file should be in the catalog')

        assert.equal(file.uri, path.join(workdir, 'files/styles/base.css'),
            `uri must be the source, not the published symlink: ${file.uri}`)
        // The published location did not get lost — it moved to the field
        // consumers already read.
        assert.equal(file.meta.url, '/styles/base.css')

        // The property the sweep depends on: the uri is inside the folder the
        // plugin owns, so ownerPrefix can scope to it.
        assert.equal(file.uri.startsWith(path.join(workdir, 'files') + path.sep), true)
    })
})

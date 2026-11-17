// A file deleted in the same delivery as a config change.
//
// The sweep in files() asks the CATALOG what disappeared, which is the right
// question right up until there is no catalog: a config change wipes the
// cache, so a file deleted in the same delivery has no row left to be missing
// from. Every later build then rescans a folder the file is not in, finds
// nothing absent, and the symlink it published stays in the output for good —
// pointing at nothing.
//
// Seen twice. On lmed production, deleted pages went on being served 200
// after a config-changing deploy; on a dev checkout, `media/assets/fonts/*
// .woff2` stayed as dangling links and a deploy script's scope check crashed
// on statSync of them.
//
// What removes it now is the same question asked of the DISK, on the cycles
// where the catalog cannot answer: a symlink whose target is inside the files
// folder and does not exist is this plugin's, and is garbage.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), files(), frontMatter(), layouts(), renderHbs()] }
`
// The second delivery. Any byte of the config's own module graph moves the
// stamp; what the change IS does not matter here, only that it wipes.
const CONFIG_CHANGED = `${CONFIG}\n// a second delivery\n`

// lstat, not existsSync: a DANGLING symlink is the whole subject, and
// existsSync follows the link and reports false for one.
const deployed = (workdir, p) => {
    try { return !!lstatSync(path.join(workdir, p)) } catch { return false }
}

describe('a file deleted in the same delivery as a config change', () => {
    const workdir = freshWorkdir('files-link-after-wipe')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'files/media/keep.jpg': 'kept',
            'files/media/assets/fonts/gone.woff2': 'about to be deleted',
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
        })
        const first = await runMikser(workdir)
        assert.equal(first.code, 0, first.combined)
        assert.equal(deployed(workdir, 'out/media/assets/fonts/gone.woff2'), true,
            'it should be published first')

        // Both at once, with nothing watching — a deploy, or a checkout.
        await rm(path.join(workdir, 'files/media/assets/fonts/gone.woff2'))
        // writeFile, not setupFixture: that one clears the workdir, which
        // would take the very output this is about with it.
        await writeFile(path.join(workdir, 'mikser.config.js'), CONFIG_CHANGED)
        const second = await runMikser(workdir)
        assert.equal(second.code, 0, second.combined)
        out = second.combined
    })

    it('wipes the cache, which is what leaves the sweep with nothing to read', () => {
        assert.match(out, /Config changed since the last run/, out)
    })

    it('removes the link the deleted file left behind', () => {
        assert.equal(deployed(workdir, 'out/media/assets/fonts/gone.woff2'), false,
            'the dangling symlink survived the rebuild, as it did on production')
    })

    it('takes the folders the link empties with it', () => {
        // A static host answers an empty folder with a listing or a 403
        // rather than the 404 a deleted file should produce.
        assert.equal(existsSync(path.join(workdir, 'out/media/assets')), false)
    })

    it('leaves every file that still exists alone', () => {
        assert.equal(existsSync(path.join(workdir, 'out/media/keep.jpg')), true,
            'the surviving link must still resolve')
        assert.equal(existsSync(path.join(workdir, 'out/index.html')), true,
            'and a rendered page is not a link to anything')
    })

    it('says what it removed rather than doing it silently', () => {
        assert.match(out, /Files links removed: 1 pointing at nothing/, out)
    })
})

describe('a config change with nothing deleted', () => {
    const workdir = freshWorkdir('files-link-wipe-noop')
    after(() => cleanup(workdir))

    it('removes nothing, and says nothing', async () => {
        // The failure mode of the fix itself: a reconciliation that reads the
        // output tree and is too eager takes live files with it, and a wipe
        // is exactly when it has the least to check against.
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'files/media/keep.jpg': 'kept',
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
        })
        assert.equal((await runMikser(workdir)).code, 0)

        await writeFile(path.join(workdir, 'mikser.config.js'), CONFIG_CHANGED)
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(combined, /Config changed since the last run/, combined)
        assert.equal(existsSync(path.join(workdir, 'out/media/keep.jpg')), true,
            `the live link was removed by the reconciliation\n${combined}`)
        assert.doesNotMatch(combined, /Files links removed:/,
            `a line on a build that removed nothing is a line nobody reads\n${combined}`)
    })
})

// --clear has to reach the derivatives.
//
// It removes outputFolder and the runtime folder, but the assets folder sits
// at the working-folder ROOT — outside both — so it was never cleared. A
// derivative whose source had gone stayed there indefinitely: still on disk,
// still SERVED through the symlink the plugin puts in the output, and absent
// from `find out -type f` because that tree is reached through a link. The
// only way out was deleting the folder by hand, which is how this was found.
//
// Note what this does NOT fix: an orphan still survives an ordinary build.
// Sources deleted from the catalog are a separate gap (the files plugin does
// no delete sweep), and this is deliberately the narrower change — --clear
// already means "throw away what was derived", and derivatives are derived.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const CONFIG = `
import { documents, files, assets, frontMatter, renderHbs } from 'mikser-io'
export default {
    plugins: [documents(), files(), frontMatter(),
        assets({ presets: { web: { match: ['/files/media/**'] } } }), renderHbs()],
}
`

const PRESET = [
    "import { mkdir, copyFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    "export const revision = 1",
    "export default async function web({ entity }) {",
    "    await mkdir(path.dirname(entity.destination), { recursive: true })",
    "    await copyFile(entity.source ?? entity.uri, entity.destination)",
    "}",
].join('\n')

describe('--clear and derivatives', () => {
    const workdir = freshWorkdir('clear-derivatives')
    after(() => cleanup(workdir))

    const derivative = (n) => path.join(workdir, 'assets', 'web', 'media', n)

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
            'files/media/keep.jpg': 'keep',
            'files/media/doomed.jpg': 'doomed',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(existsSync(derivative('keep.jpg')))
        assert.ok(existsSync(derivative('doomed.jpg')))
    })

    it('an ordinary build now removes the orphan too, so --clear is not the only route', async () => {
        // This used to assert the opposite, stated so the narrower fix would
        // not be mistaken for the whole one. The gap is closed: the scan
        // reconciles the deleted file and the assets pass removes the
        // derivative that lost its source, so --clear is a convenience here
        // rather than the only cleanup that works.
        await rm(path.join(workdir, 'files/media/doomed.jpg'))
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(existsSync(derivative('doomed.jpg')), false,
            `a plain build reconciles it now\n${combined}`)
    })

    it('--clear removes it', async () => {
        const { code, combined } = await runMikser(workdir, ['--clear'])
        assert.equal(code, 0, combined)
        assert.equal(existsSync(derivative('doomed.jpg')), false,
            `--clear must reach the derivatives\n${combined}`)
    })

    it('and rebuilds the ones that still have a source', async () => {
        // The failure mode on the other side: a --clear that wipes and does
        // not re-derive leaves the site without its images.
        assert.ok(existsSync(derivative('keep.jpg')),
            'clearing must be followed by re-deriving what is still live')
    })
})

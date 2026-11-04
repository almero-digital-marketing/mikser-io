// --clear must NOT reach the derivatives, and the orphan goes anyway.
//
// The assets folder sits at the working-folder ROOT, outside both
// outputFolder and the runtime folder, and it is symlinked into the output.
// A derivative whose source had gone stayed there indefinitely: still on
// disk, still SERVED through that symlink, and absent from `find out -type f`
// because the tree is reached through a link. --clear deleting the whole
// folder was the first answer to that.
//
// It is not the answer any more, on both halves. The orphan is removed by
// every build now — the files plugin reconciles the deleted source and the
// assets plugin drops the derivative that lost it — and deleting the live
// ones with it was never cleanup, it was hours: the marker beside each
// derivative survives the cache wipe, so a cleared build reuses what it finds
// (20,287 derivatives in 45s, measured with the catalog deleted). From
// mikser-io-assets 11.7.0 the deletion is --clear-assets, which names what it
// removes.

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
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { assets, renderPreset } from 'mikser-io-assets'
export default {
    plugins: [documents(), files(), frontMatter(),
        assets({ presets: { web: { match: ['/files/media/**'] } } }), renderPreset(), renderHbs()],
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

    it('--clear leaves the orphan gone and the live derivative alone', async () => {
        const { code, combined } = await runMikser(workdir, ['--clear'])
        assert.equal(code, 0, combined)
        assert.equal(existsSync(derivative('doomed.jpg')), false,
            `the sweep already removed it and nothing should bring it back\n${combined}`)
        // The half that used to be deleted and re-derived. On a real site
        // that is hours of ffmpeg and sharp, bought by a flag people reach
        // for when a build looks wrong.
        assert.equal(existsSync(derivative('keep.jpg')), true,
            `--clear deleted a live derivative\n${combined}`)
    })
})

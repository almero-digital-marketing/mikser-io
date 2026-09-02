// Bumping a preset's `revision` has to actually rebuild its derivatives.
//
// It half worked: the startup sweep removed the stale marker, and nothing
// re-rendered. So the mechanism reported success — the marker really did
// disappear — while the derivative on disk stayed at its old content
// indefinitely. Where `derived/` is gitignored, a commit whose only change is
// a preset's numbers ships, restarts, builds green and serves the old images
// until someone deletes the folder on the container by hand.
//
// Two things were wrong, and both had to go.
//
// The fan-out for "a preset changed" read assetsMap, which is built from THIS
// cycle's journal — so on a build where only the preset moved it was empty and
// reached nothing. It asks the catalog now.
//
// And once the entity WAS scheduled, the manifest skipped it: an asset's input
// hash is its own source, a preset's revision is not part of it, so the skip
// was right about the entity and wrong about the render.
//
// Note for anyone changing this: bumping only the revision number is not a
// valid test. The render logic is unchanged, so identical output proves
// nothing. The change has to alter the bytes.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { globby } from 'globby'
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

// A preset whose output is a fixed string, so "did it re-render" is readable
// rather than inferred from an image.
const preset = (revision, body) => [
    "import { mkdir, writeFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    `export const revision = ${revision}`,
    "export default async function web({ entity }) {",
    "    await mkdir(path.dirname(entity.destination), { recursive: true })",
    `    await writeFile(entity.destination, '${body}')`,
    "}",
].join('\n')

describe('a preset revision bump', () => {
    const workdir = freshWorkdir('preset-revision')
    after(() => cleanup(workdir))

    const derivative = () => path.join(workdir, 'assets', 'web', 'media', 'hero.jpg')
    const markers = () => globby('**/*.md5', { cwd: path.join(workdir, 'assets') })
    const write = (rev, body) => writeFile(path.join(workdir, 'presets/web.js'), preset(rev, body))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': preset(1, 'FIRST'),
            'files/media/hero.jpg': 'source bytes',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'FIRST')
    })

    it('rebuilds the derivative when the revision moves and the render changes', async () => {
        // The case that matters: derivatives present, no --clear, no rm.
        await write(2, 'SECOND')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'SECOND',
            `bumping revision is the documented way to force a rebuild\n${combined}`)
    })

    it('leaves a marker at the new revision, not an absent one', async () => {
        // The old behaviour deleted the stale marker and wrote nothing, so a
        // bump that worked and a bump that did nothing were indistinguishable.
        const found = await markers()
        assert.deepEqual(found, ['web/media/hero.jpg.2.md5'],
            `expected exactly one marker, at the current revision: ${found.join(', ')}`)
    })

    it('does NOT rebuild when the render changes and the revision does not', async () => {
        // This is what makes the first case safe to rely on. A preset edit
        // alone must not silently rebuild every derivative on the site — and
        // if it did, the first test would pass for the wrong reason.
        await write(2, 'THIRD-NOT-APPLIED')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'SECOND',
            `an unbumped preset must not rebuild\n${combined}`)
    })

    it('rebuilds and restores a marker deleted by hand', async () => {
        await rm(path.join(workdir, 'assets/web/media/hero.jpg.2.md5'))
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'THIRD-NOT-APPLIED',
            `a missing marker means the derivative is not known-current\n${combined}`)
        assert.ok(existsSync(path.join(workdir, 'assets/web/media/hero.jpg.2.md5')),
            'and the marker comes back, rather than staying absent')
    })
})

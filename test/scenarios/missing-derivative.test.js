// A deleted asset derivative comes back on an ordinary build.
//
// The sibling of missing-output.test.js, one layer down. That one covers
// entities the render pipeline writes; this covers the ones the assets plugin
// derives, which reach disk by a different route and were gated by two more
// checks that both reasoned about something other than the file:
//
//   1. src/plugins/files.js had its OWN copy of the source checksum gate,
//      so the missing-output bypass added to source.js's gateChecksum never
//      applied to it. The file a derivative comes from was "unchanged", so it
//      was never re-emitted and the assets plugin never saw it. files.js now
//      calls the shared gate.
//
//   2. isPresetRendered() asked whether a `.md5` MARKER existed at the
//      current revision. A marker records that a render happened, not that
//      its output survived, and the two come apart the moment someone deletes
//      a derivative — which is the obvious move when you want one rebuilt.
//
// Both had to go. Fixing only the first leaves the marker case (A below)
// broken; fixing only the second leaves the whole-folder case (B) broken,
// because nothing schedules the entity at all.
//
// The inverse case — marker gone, derivative present — is deliberately NOT
// changed here and is covered by preset-revision.test.js: nothing schedules
// an entity whose source and preset both stood still, and a marker nobody
// deleted by accident is not worth a corpus scan per build.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { assets, renderPreset } from 'mikser-io-assets'
export default {
    plugins: [documents(), files(), frontMatter(),
        assets({ presets: { web: { match: ['/files/media/**'] } } }), renderPreset(), renderHbs()],
}
`

// Output is a fixed string so "did it re-derive" is readable rather than
// inferred from image bytes.
const PRESET = [
    "import { mkdir, writeFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    'export const revision = 1',
    'export default async function web({ entity }) {',
    '    await mkdir(path.dirname(entity.destination), { recursive: true })',
    "    await writeFile(entity.destination, 'DERIVED')",
    '}',
].join('\n')

describe('a deleted asset derivative is re-derived', () => {
    const workdir = freshWorkdir('missing-derivative')
    after(() => cleanup(workdir))

    const derivative = () => path.join(workdir, 'assets', 'web', 'media', 'hero.jpg')
    const marker = () => path.join(workdir, 'assets', 'web', 'media', 'hero.jpg.1.md5')

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
            'files/media/hero.jpg': 'source bytes',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'DERIVED', combined)
        assert.ok(existsSync(marker()), 'the first build leaves a marker')
    })

    it('a build with nothing missing does not re-derive', async () => {
        // The regression guard, and the reason neither fix may simply drop the
        // marker check: re-deriving every asset on every build would pass the
        // two cases below and be worse than the bug.
        const before = (await readFile(derivative(), 'utf8'))
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.doesNotMatch(combined, /Rendered:/,
            `a no-op build must not schedule the asset\n${combined}`)
        assert.equal(await readFile(derivative(), 'utf8'), before)
    })

    it('case A: the derivative deleted while its marker survives', async () => {
        // The marker is the trap. It says a render happened, and it is still
        // there, so every marker-only check concludes there is nothing to do.
        await rm(derivative())
        assert.ok(existsSync(marker()), 'precondition: the marker is still there')

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(existsSync(derivative()), `the derivative must come back\n${combined}`)
        assert.equal(await readFile(derivative(), 'utf8'), 'DERIVED')
    })

    it('case B: the whole assets folder deleted', async () => {
        await rm(path.join(workdir, 'assets'), { recursive: true })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(existsSync(derivative()), `the derivative must come back\n${combined}`)
        assert.ok(existsSync(marker()), 'and so must its marker')
    })

    it('--audit-output agrees once the build has recovered them', async () => {
        // The two disagreeing is the whole shape of this bug class: audit was
        // the only thing that ever reported a missing derivative, and it had
        // to keep saying so after a green build.
        const { code, combined } = await runMikser(workdir, ['--audit-output'])
        assert.equal(code, 0, combined)
        assert.match(combined, /Audit OK/)
    })
})

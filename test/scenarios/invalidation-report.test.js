// Why did this build do any work?
//
// The counts said what happened and never what started it. "0 rendered" is the
// same line whether nothing needed doing or something needed doing and the
// engine did not notice — which is the difference between a build you can
// trust and one you reproduce by hand to find out.
//
// Reported after a preset widened in an imported config module silently
// applied to nothing: the build was green, the derivatives were absent, and
// the only way to establish which of the two had happened was to drop a probe
// file into the folder and watch whether it got processed.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, files, assets, frontMatter } from 'mikser-io'
export default {
    plugins: [
        documents(), files(), frontMatter(),
        assets({ presets: { web: { matches: ['/files/photos/**'] } } }),
    ],
}
`

// stdout only — under --json the logger moves to stderr so the document is
// the only thing here.
const report = async (workdir) => JSON.parse((await runMikser(workdir, ['--json'])).stdout)

describe('what invalidated this build', () => {
    const workdir = freshWorkdir('invalidation')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/a.md': '---\ntitle: A\n---\nbody',
            'documents/b.md': '---\ntitle: B\n---\nbody',
            'files/notes.txt': 'a file',
        })
        await runMikser(workdir)
    })

    it('says "nothing" when there was nothing to do', async () => {
        // A first-class answer, not an absence. This is the one an operator
        // most needs distinguished from a build that failed to notice.
        const { invalidated, summary } = await report(workdir)
        assert.equal(invalidated.cause, 'nothing')
        assert.ok(summary.gated > 0, 'and the engine did look — gated proves it')
    })

    it('names the sources that changed', async () => {
        await appendFile(path.join(workdir, 'documents/a.md'), '\nmore\n')
        const { invalidated, summary } = await report(workdir)
        assert.equal(invalidated.cause, 'sources')
        assert.deepEqual(invalidated.changed, ['/documents/a.md'])
        assert.equal(summary.changed, 1)
    })

    it('says the config moved, rather than listing every source', async () => {
        // A wipe outranks changed sources: when the cache went, everything is
        // a changed source and saying so is noise.
        await appendFile(path.join(workdir, 'mikser.config.js'), '\n// edit\n')
        const { invalidated } = await report(workdir)
        assert.equal(invalidated.cause, 'config')
    })

    it('says --clear was asked for', async () => {
        const { stdout } = await runMikser(workdir, ['--json', '--clear'])
        assert.equal(JSON.parse(stdout).invalidated.cause, 'clear')
    })
})

describe('what each subsystem looked at', () => {
    const workdir = freshWorkdir('evaluated')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/a.md': '---\ntitle: A\n---\nbody',
            'files/notes.txt': 'a file',
            'files/more.txt': 'another',
        })
        await runMikser(workdir)
    })

    it('reports evaluated against what exists', async () => {
        // The line that would have ended the investigation immediately:
        // a new pattern that never had the chance to match anything looks
        // exactly like a run with nothing to do, until you can see that the
        // run evaluated 0 of 3.
        await runMikser(workdir)
        const { evaluated } = await report(workdir)
        assert.ok(evaluated?.assets, 'assets has to say what it looked at')
        assert.equal(typeof evaluated.assets.evaluated, 'number')
        assert.ok(evaluated.assets.of >= 3, `denominator should count the catalog: ${JSON.stringify(evaluated)}`)
    })

    it('shows a quiet cycle evaluating nothing, next to a catalog that exists', async () => {
        const { evaluated, invalidated } = await report(workdir)
        assert.equal(invalidated.cause, 'nothing')
        assert.equal(evaluated.assets.evaluated, 0, 'nothing changed, so nothing was evaluated')
        assert.ok(evaluated.assets.of > 0, 'while the catalog is plainly not empty — the whole point')
    })

    it('evaluates the file that changed, and says so', async () => {
        await writeFile(path.join(workdir, 'files/notes.txt'), 'edited')
        const { evaluated } = await report(workdir)
        assert.ok(evaluated.assets.evaluated >= 1)
    })
})

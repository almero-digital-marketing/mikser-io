// The config stamp has to cover the module that IS the build.
//
// It used to be the entry file's bytes alone, which is inverted against
// significance the moment a project has a dev config and a prod config: both
// import the module that decides how the site is built, neither IS it. So a
// comment in the thin wrapper wiped the catalog, and rewriting the pipeline
// that processes every asset invalidated nothing — on a green build, with the
// old output left in place.
//
// Reported from lmed-web, where widening an assets preset in an imported
// module silently did nothing and three 2 MB PNGs kept shipping unprocessed.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const ENTRY = `
import { pipeline } from './config/pipeline.js'
export default { plugins: pipeline }
`

const PIPELINE = `
import { documents, frontMatter } from 'mikser-io'
export const pipeline = [documents(), frontMatter()]
`

const wiped = (stdout) => /Config changed since the last run|schema mismatch/i.test(stdout)

async function stamp(workdir) {
    // stdout only — under --json the logger moves to stderr precisely so the
    // document is the only thing here.
    const { stdout } = await runMikser(workdir, ['--json'])
    return JSON.parse(stdout)
}

describe('what the config stamp covers', () => {
    const workdir = freshWorkdir('config-graph')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': ENTRY,
            'config/pipeline.js': PIPELINE,
            'config/notes.md': 'not code',
            'documents/a.md': '---\ntitle: A\n---\nbody',
        })
        await runMikser(workdir)
    })

    it('reports which files it spans', async () => {
        // Published rather than documented: "I edited the build and nothing
        // rebuilt" was otherwise only answerable by experiment.
        const report = await stamp(workdir)
        const files = report.config.files.map(f => path.relative(workdir, f))
        assert.ok(files.includes('mikser.config.js'))
        assert.ok(files.includes(path.join('config', 'pipeline.js')),
            'the module that actually builds the site has to be in the stamp')
        assert.equal(report.config.complete, true)
    })

    it('invalidates when an imported module changes', async () => {
        await appendFile(path.join(workdir, 'config/pipeline.js'), '\n// widened a preset\n')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(wiped(combined), `editing the build must invalidate\n${combined}`)
    })

    it('does not invalidate for a file the config never imports', async () => {
        // Over-invalidating would pass the test above trivially and make every
        // build a cold one.
        await writeFile(path.join(workdir, 'config/notes.md'), 'still not code')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(wiped(combined), false, `an unimported file must not wipe\n${combined}`)
    })

    it('still invalidates when the entry file itself changes', async () => {
        await appendFile(path.join(workdir, 'mikser.config.js'), '\n// entry edit\n')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(wiped(combined), combined)
    })

    it('does not follow an import out of the project', async () => {
        // The stamp is scoped to the config's own directory, and node_modules
        // alone is not enough of a filter: a workspace symlinks its siblings,
        // so a package resolves to a real path outside node_modules and its
        // whole source tree would land in the stamp — making every edit to a
        // sibling a full wipe of every project using it.
        //
        // Exercised with a module OUTSIDE the workdir rather than with
        // mikser-io, which is already loaded by the time a config imports it
        // and so never reaches the loader hook.
        const outside = path.join(path.dirname(workdir), `outside-${path.basename(workdir)}.js`)
        await writeFile(outside, 'export const extra = 1\n')
        await writeFile(path.join(workdir, 'mikser.config.js'),
            `import { pipeline } from './config/pipeline.js'\n`
            + `import { extra } from ${JSON.stringify(outside)}\n`
            + `export default { plugins: pipeline, extra }\n`)
        await runMikser(workdir)

        const report = await stamp(workdir)
        assert.equal(report.config.files.includes(outside), false,
            `the stamp must stay inside the project\n${report.config.files.join('\n')}`)
        assert.ok(report.config.files.some(f => f.endsWith('pipeline.js')),
            'while still covering what is inside it')
    })
})

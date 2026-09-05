// --audit-output has to see every tree mikser writes into.
//
// It walked the output folder, and preset derivatives do not live there: they
// sit at the working-folder root and reach the site through a symlink the
// walk does not follow. So the one check whose job is "what is on disk that
// mikser did not record" reported `0 orphaned` over any amount of debris in
// the one tree where debris actually accumulates — a preset doing its own
// temp-and-rename leaves `.part` files there whenever it is killed.
//
// Two things had to move. The walk now covers roots that plugins DECLARE
// (`runtime.options.auditRoots`), so nothing in core has to know what a
// preset is or that a `.md5` beside a derivative is bookkeeping rather than
// output — without that exclusion every derivative on a site reports exactly
// one orphan.
//
// And the dispatch moved from the engine's onLoaded to `import`, for the
// reason --tool and --tools moved there before it: the engine's own onLoaded
// is registered during setup(), ahead of every plugin's, so an audit
// dispatched from it asked which trees hold outputs before a single plugin
// had answered. The declaration was correct and arrived too late to be read.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

const PRESET = `
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
export const revision = 1
export default async function web({ entity }) {
    await mkdir(path.dirname(entity.destination), { recursive: true })
    await writeFile(entity.destination, await readFile(entity.source ?? entity.uri))
}
`

// The ordinary shape for a video preset: a poster frame beside the video.
const MULTI = PRESET.replace(
    'await writeFile(entity.destination, await readFile(entity.source ?? entity.uri))',
    'await writeFile(entity.destination, await readFile(entity.source ?? entity.uri))\n'
    + "    await writeFile(entity.destination.replace(/\\.[^.]+$/, '.poster.jpg'), 'poster')")

const config = (extra = '') => `
import { files, assets } from 'mikser-io'
export default {
    plugins: [files(), assets({ presets: { web: { match: ['/files/media/**'] } }${extra} })],
}
`

const SIZE = 2000
const audit = (workdir) => runMikser(workdir, ['--audit-output'])

async function project(workdir, { preset = PRESET, extra = '' } = {}) {
    await setupFixture(workdir, { 'mikser.config.js': config(extra), 'presets/web.js': preset })
    await mkdir(path.join(workdir, 'files/media'), { recursive: true })
    await writeFile(path.join(workdir, 'files/media/clip.bin'), Buffer.alloc(SIZE, 7))
    const { code, combined } = await runMikser(workdir)
    assert.equal(code, 0, combined)
}

describe('the audit covers the assets tree', () => {
    const workdir = freshWorkdir('audit-assets')
    after(() => cleanup(workdir))
    before(() => project(workdir))

    it('passes clean, with the derivative claimed and its marker ignored', async () => {
        // The marker is the load-bearing half: it sits beside every
        // derivative and no snapshot claims it, so without the exclusion a
        // healthy one-derivative site reports one orphan and exits non-zero.
        const { code, combined } = await audit(workdir)
        assert.equal(code, 0, combined)
        const log = stripAnsi(combined)
        assert.match(log, /Audit OK/, log)
        assert.doesNotMatch(log, /\.md5/, 'a marker is bookkeeping, never an orphan')
    })

    it('reports a file in the assets tree that nothing claims', async () => {
        // What a preset's own temp-and-rename leaves when it is killed. This
        // is the case that reported `0 orphaned` before.
        await writeFile(path.join(workdir, 'assets/web/media/clip.bin.tmp-99.part'), 'x')
        const { code, combined } = await audit(workdir)
        const log = stripAnsi(combined)
        assert.match(log, /Orphan:\s+assets\/web\/media\/clip\.bin\.tmp-99\.part/,
            `an unclaimed file in the assets tree must be named:\n${log}`)
        assert.notEqual(code, 0, 'and it is a warning, which the exit code carries')
    })

    it('names it relative to the working folder, so the tree is unambiguous', async () => {
        // Output-folder orphans stay relative to the output folder, as they
        // were. `web/media/x` alone would not say which tree it is in.
        const { combined } = await audit(workdir)
        assert.match(stripAnsi(combined), /Orphan:\s+assets\//, stripAnsi(combined))
        await rm(path.join(workdir, 'assets/web/media/clip.bin.tmp-99.part'))
    })
})

describe('a preset that writes more than one file, under audit', () => {
    const workdir = freshWorkdir('audit-assets-multi')
    after(() => cleanup(workdir))
    before(() => project(workdir, { preset: MULTI }))

    it('reports the extra file, because nothing claims it', async () => {
        // Correct, and worth saying: the engine records the one destination
        // it handed over, so it genuinely does not know this file exists.
        const { code, combined } = await audit(workdir)
        assert.match(stripAnsi(combined), /Orphan:\s+assets\/web\/media\/clip\.poster\.jpg/,
            stripAnsi(combined))
        assert.notEqual(code, 0)
    })

    it('can be told they are expected, rather than failing for ever', async () => {
        // Without this the fix turns a legitimate preset shape into a
        // permanent non-zero exit — the same cry-wolf failure the
        // unfinished-derivative scan already had once.
        await writeFile(path.join(workdir, 'mikser.config.js'),
            config(", auditIgnore: ['**/*.poster.jpg']"))
        const { code, combined } = await audit(workdir)
        assert.equal(code, 0, stripAnsi(combined))
        assert.match(stripAnsi(combined), /Audit OK/, stripAnsi(combined))
    })
})

describe('an assets tree configured inside the output folder', () => {
    // `--assets out/derived` is a legal configuration, and then one walked
    // root contains another. Without a containment check every file in it is
    // listed twice — once by each walk — and a single stray file reports as
    // two orphans.
    const workdir = freshWorkdir('audit-assets-nested')
    after(() => cleanup(workdir))
    before(() => project(workdir, { extra: ", assetsFolder: 'out/derived'" }))

    it('reports each unclaimed file once, not once per walk', async () => {
        await writeFile(path.join(workdir, 'out/derived/web/media/stray.part'), 'x')
        const { combined } = await audit(workdir)
        const log = stripAnsi(combined)
        const hits = log.split('\n').filter(line => /Orphan:/.test(line) && /stray\.part/.test(line))
        assert.equal(hits.length, 1, `expected one report, got ${hits.length}:\n${log}`)
    })
})

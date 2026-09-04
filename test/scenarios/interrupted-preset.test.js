// A preset render that failed leaves nothing half-written behind.
//
// Presets are the one place in the system where USER code is handed a final
// output path and left to fill it. An interrupted write there is not
// self-correcting, because both gates that could catch it are looking
// elsewhere:
//
//   the marker    keyed on the SOURCE checksum, and an interruption does not
//                 change the source — so it still matches
//   outputMissing the file is present, just wrong — so it does not fire
//
// Every later build therefore reports nothing to do over a truncated
// derivative. Worse where the preset wraps a tool whose non-zero exit it does
// not check: it RESOLVES, the manifest snapshots the truncated bytes, and
// `--audit-output` reads green — the one check that exists to catch this
// confirms it instead. That case is not fixable from here and is not claimed
// below; a preset that reports success is believed.
//
// Two halves, and both are needed. The marker is removed before the render
// and written again by onComplete, so it cannot outlive the render it
// describes. And the destination is removed when the failed render is what
// changed it — measured before and after, so a preset that fails BEFORE
// writing keeps its good derivative rather than having a working asset taken
// off the site until the next build.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { globby } from 'globby'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

const CONFIG = `
import { files, assets } from 'mikser-io'
export default {
    plugins: [files(), assets({ presets: { web: { match: ['/files/media/**'] } } })],
}
`

// Writes half the bytes and throws when asked — what an ffmpeg killed
// mid-encode leaves at the destination.
const PRESET = `
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
export const revision = 1
export default async function web({ entity }) {
    await mkdir(path.dirname(entity.destination), { recursive: true })
    if (process.env.PRESET_FAIL_EARLY) throw new Error('ffmpeg not found')
    const source = await readFile(entity.source ?? entity.uri)
    if (process.env.PRESET_FAIL_HALFWAY) {
        await writeFile(entity.destination, source.subarray(0, source.length >> 1))
        throw new Error('interrupted mid-write')
    }
    await writeFile(entity.destination, source)
}
`

const SIZE = 20000

describe('a preset render that did not finish', () => {
    const workdir = freshWorkdir('interrupted-preset')
    after(() => cleanup(workdir))

    const derivative = () => path.join(workdir, 'assets', 'web', 'media', 'clip.bin')
    const size = async () => (await stat(derivative())).size
    const markers = () => globby('**/*.md5', { cwd: path.join(workdir, 'assets') })

    // The harness spreads process.env into the child, which is how the
    // preset is told to fail. Scoped, so one failing build cannot leak into
    // the next assertion.
    const buildWith = async (variable, args = []) => {
        process.env[variable] = '1'
        try { return await runMikser(workdir, args) } finally { delete process.env[variable] }
    }

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
        })
        // Binary, so it is written here rather than through the fixture map.
        await mkdir(path.join(workdir, 'files/media'), { recursive: true })
        await writeFile(path.join(workdir, 'files/media/clip.bin'), Buffer.alloc(SIZE, 7))
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await size(), SIZE, 'precondition: a clean build derives the whole file')
        assert.equal((await markers()).length, 1, 'precondition: and marks it')
    })

    it('leaves no truncated derivative, and no marker claiming one', async () => {
        // Deleting a derivative is the obvious way to ask for it back, and it
        // is what puts the entity back in front of the preset.
        await rm(derivative())
        await buildWith('PRESET_FAIL_HALFWAY')

        assert.equal(existsSync(derivative()), false,
            'a half-written derivative must not be left at the destination')
        assert.deepEqual(await markers(), [],
            'and no marker may outlive the render it describes')
    })

    it('re-derives on the next ordinary build, with nothing forced', async () => {
        // The whole failure was that this said nothing to do. No --force, no
        // --render-presets: an ordinary build has to recover on its own.
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await size(), SIZE, 'the derivative comes back whole')
        assert.equal((await markers()).length, 1)
    })

    it('passes --audit-output afterwards, having failed it before', async () => {
        const { combined } = await runMikser(workdir, ['--audit-output'])
        assert.match(stripAnsi(combined), /Audit OK/, stripAnsi(combined))
    })

    it('re-derives after a HARD kill, where no catch ever ran', async () => {
        // The case a try/catch cannot reach: SIGKILL, or the OOM killer
        // taking a video encode. Neither the removal nor onComplete runs, so
        // the truncated file stays — and nothing schedules it, because the
        // file is present and the source did not change. The marker's ABSENCE
        // is the only remaining evidence, which is why it is now read.
        //
        // Staged rather than raced: a real kill lands in a different phase
        // depending on file size and disk speed, and the state is what
        // matters. Verified against an actual SIGKILL mid-preset separately —
        // it produces exactly this: a partial file, no marker.
        const marker = (await markers())[0]
        await rm(path.join(workdir, 'assets', marker))
        await writeFile(derivative(), Buffer.alloc(SIZE / 2, 7))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), /preset-unfinished|did not finish/,
            'the recovery has to say why it is re-deriving')
        assert.equal(await size(), SIZE, 'and the derivative comes back whole')

        const next = await runMikser(workdir)
        assert.doesNotMatch(stripAnsi(next.combined), /preset-unfinished/,
            'and it is not sticky — the next build is quiet')
    })

    it('keeps a good derivative when the preset fails before writing', async () => {
        // The guard on the removal. A preset that throws on a missing binary
        // has not damaged anything, and deleting its previous output would
        // take a working asset off the site until the next build — a
        // regression introduced by the fix rather than caught by it.
        //
        // The source has to actually CHANGE, or no render is attempted and
        // this asserts nothing. The first version of this test rewrote the
        // file with identical bytes, the checksum did not move, the preset
        // never ran, and it passed with the guard removed.
        const source = path.join(workdir, 'files/media/clip.bin')
        await writeFile(source, Buffer.alloc(SIZE * 2, 9))
        const { combined } = await buildWith('PRESET_FAIL_EARLY')
        assert.match(stripAnsi(combined), /ffmpeg not found/,
            `the preset must have been reached and failed:\n${stripAnsi(combined)}`)

        assert.equal(existsSync(derivative()), true,
            'an untouched derivative must survive a preset that never wrote')
        assert.equal(await size(), SIZE,
            'and it is the previous good one, not a partial replacement')
    })
})

// The recovery must not cry wolf.
//
// The first version of the unmarked-derivative scan walked every file under
// each preset folder and called anything without a marker an interrupted
// render. Only the destination the engine hands the preset gets a marker, so
// a preset that legitimately writes MORE than one file left permanent
// evidence of a failure that never happened: `preset-unfinished` on every
// build, for ever, announcing a re-derive that never occurred because no
// entity's destination ever matched the extra file.
//
// That is worse than the silence it replaced. A warning that fires on every
// healthy build is one people learn to scroll past, including the time it is
// real. The detection now asks the MANIFEST which outputs exist rather than
// asking the folder what is in it — a file nothing claims is an orphan, which
// is a different fault.
describe('a preset that writes more than one file', () => {
    const workdir = freshWorkdir('preset-extra-outputs')
    after(() => cleanup(workdir))

    // A poster frame beside the video: the ordinary shape for a video preset.
    const MULTI = `
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
export const revision = 1
export default async function web({ entity }) {
    await mkdir(path.dirname(entity.destination), { recursive: true })
    await writeFile(entity.destination, await readFile(entity.source ?? entity.uri))
    await writeFile(entity.destination.replace(/\\.[^.]+$/, '.poster.jpg'), 'poster')
}
`
    const derivative = () => path.join(workdir, 'assets', 'web', 'media', 'clip.bin')

    before(async () => {
        await setupFixture(workdir, { 'mikser.config.js': CONFIG, 'presets/web.js': MULTI })
        await mkdir(path.join(workdir, 'files/media'), { recursive: true })
        await writeFile(path.join(workdir, 'files/media/clip.bin'), Buffer.alloc(SIZE, 7))
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(existsSync(path.join(workdir, 'assets/web/media/clip.poster.jpg')),
            'precondition: the preset really does write a second file')
    })

    it('is not reported as unfinished, on any build', async () => {
        for (const run of [1, 2, 3]) {
            const { code, combined } = await runMikser(workdir)
            assert.equal(code, 0, combined)
            assert.doesNotMatch(stripAnsi(combined), /preset-unfinished/,
                `run ${run} accused a healthy multi-output preset of an interrupted render`)
        }
    })

    it('is not reported for unrelated debris beside a derivative either', async () => {
        // A preset doing its own temp-and-rename leaves these behind when it
        // is killed. They are not derivatives and nothing claims them.
        await writeFile(path.join(workdir, 'assets/web/media/clip.bin.tmp-1234.part'), 'x')
        const { combined } = await runMikser(workdir)
        assert.doesNotMatch(stripAnsi(combined), /preset-unfinished/, stripAnsi(combined))
    })

    it('never announces a re-derive it did not perform', async () => {
        // The second half of the defect: the warning was raised from the
        // count of suspect FILES, before anything had been scheduled, so a
        // build that re-derived nothing still said it was re-deriving.
        const { combined } = await runMikser(workdir)
        const log = stripAnsi(combined)
        if (/being re-derived/.test(log)) {
            assert.match(log, /Rendered:\s*[1-9]/,
                `claimed a re-derive with nothing rendered:\n${log}`)
        }
    })

    it('still catches a genuine interruption, with the extra files present', async () => {
        // The guard against fixing the false positive by deleting the
        // feature: the same tree that must stay quiet above has to report
        // this.
        const marker = (await globby('**/*.md5', { cwd: path.join(workdir, 'assets') }))[0]
        await rm(path.join(workdir, 'assets', marker))
        await writeFile(derivative(), Buffer.alloc(SIZE / 2, 7))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), /preset-unfinished|did not finish/,
            'a truncated derivative must still be caught')
        assert.equal((await stat(derivative())).size, SIZE, 'and re-derived whole')
    })
})

// The three states the detection has to tell apart, each of which survived a
// mutation of the code until it was written down here.
describe('what the unfinished scan must NOT claim', () => {
    const workdir = freshWorkdir('preset-scan-limits')
    after(() => cleanup(workdir))

    // Documents and layouts as well as assets, so the manifest carries PAGE
    // snapshots beside the derivative ones. Those have no markers and never
    // will; without the preset-root filter every page on a site reads as an
    // interrupted render.
    const FULL = `
import { documents, files, assets, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), files(), frontMatter(), layouts({ autoLayouts: true }),
        assets({ presets: { web: { match: ['/files/media/**'] } } }), renderHbs()],
}
`
    const derivative = () => path.join(workdir, 'assets', 'web', 'media', 'clip.bin')
    const markers = () => globby('**/*.md5', { cwd: path.join(workdir, 'assets') })

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': FULL,
            'presets/web.js': PRESET,
            'layouts/page.hbs': '<!doctype html><title>{{document.meta.title}}</title>',
            'documents/index.md': '---\ntitle: One\nlayout: page\n---\n',
            'documents/two.md': '---\ntitle: Two\nlayout: page\n---\n',
        })
        await mkdir(path.join(workdir, 'files/media'), { recursive: true })
        await writeFile(path.join(workdir, 'files/media/clip.bin'), Buffer.alloc(SIZE, 7))
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(existsSync(path.join(workdir, 'out/index.html')),
            'precondition: pages are rendered, so the manifest holds page snapshots too')
    })

    it('does not read a rendered PAGE as an unfinished derivative', async () => {
        // Pages are in the same manifest and carry no markers. Only outputs
        // under a configured preset folder are this scan's business.
        const { combined } = await runMikser(workdir)
        assert.doesNotMatch(stripAnsi(combined), /preset-unfinished/, stripAnsi(combined))
    })

    it('says nothing when the derivative is GONE rather than half-written', async () => {
        // A different fault with an existing owner: the engine's
        // missing-output path re-renders it. Reporting it here as well would
        // name the wrong cause for the same recovery.
        await rm(derivative())
        for (const marker of await markers()) await rm(path.join(workdir, 'assets', marker))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.doesNotMatch(stripAnsi(combined), /preset-unfinished/,
            `a missing derivative is not an unfinished one:\n${stripAnsi(combined)}`)
        assert.equal((await stat(derivative())).size, SIZE, 'and it still comes back')
    })

    it('stays silent when the source is gone, having nothing to re-derive', async () => {
        // Snapshot present, derivative present, marker absent — but the
        // entity no longer exists, so nothing can be scheduled. The warning
        // was raised from the count of suspect FILES, before anything had
        // been scheduled, so this state announced a recovery that could not
        // happen. The orphan sweep is what removes the derivative.
        for (const marker of await markers()) await rm(path.join(workdir, 'assets', marker))
        await rm(path.join(workdir, 'files/media/clip.bin'))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.doesNotMatch(stripAnsi(combined), /being re-derived/,
            `nothing could be re-derived, so nothing may say it was:\n${stripAnsi(combined)}`)
    })
})

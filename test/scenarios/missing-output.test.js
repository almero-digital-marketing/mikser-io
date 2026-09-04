// An output that is gone from disk must re-render, not report unchanged.
//
// Every skip gate in the pipeline reasons about INPUTS, and `rm -rf out` does
// not change an input: the documents are byte-identical, so a build after it
// used to short-circuit at the first gate, emit nothing, render nothing, print
// no `Rendered:` line and exit 0 over an empty output folder — correct by its
// own reasoning and wrong about the only thing the caller asked for. The
// failure is quiet in exactly the way that matters: three lines of successful
// incremental build look the same whether or not the site exists, and
// `--audit-output` was the only thing that ever said otherwise.
//
// THREE gates have to agree, which is why this is a scenario and not a unit
// test — fixing any one of them alone changes nothing observable:
//
//   1. source.js gateChecksum      — same file checksum, so no CREATE emitted,
//                                    so the entity never reaches the journal
//   2. manifest.recordedHashes     — the layouts dispatcher's seeding filter;
//                                    a recorded hash meant "needs no render"
//   3. manifest.skipDecision       — the render gate, the only one that ever
//                                    had a chance to look at the output
//
// The other half of the contract is that ordinary incrementality survives: a
// build with everything present must still skip everything. A fix that
// re-renders the site on every build would pass a missing-output test and be
// worse than the bug.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT, stripAnsi,
} from './_harness.js'
import { socketPath } from '../../src/instance.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' } }),
        renderHbs(),
    ],
}
`

const doc = (title) => `---\ntitle: ${title}\n---\nbody of ${title}\n`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs': '<!doctype html><title>{{document.meta.title}}</title>',
    'documents/one.md': doc('One'),
    'documents/two.md': doc('Two'),
    'documents/three.md': doc('Three'),
}

const PAGES = ['/one/index.html', '/two/index.html', '/three/index.html']

const htmlCount = async (workdir) => {
    const walk = async (dir) => {
        if (!existsSync(dir)) return 0
        let n = 0
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) n += await walk(full)
            else if (entry.name.endsWith('.html')) n += 1
        }
        return n
    }
    return walk(path.join(workdir, 'out'))
}

describe('a missing output re-renders', () => {
    const workdir = freshWorkdir('missing-output')
    after(() => cleanup(workdir))

    const build = async () => JSON.parse((await runMikser(workdir, ['--json'])).stdout)

    it('cold build writes every page', async () => {
        await setupFixture(workdir, FIXTURE)
        const report = await build()
        assert.equal(report.rendered.length, 3)
        assert.equal(await htmlCount(workdir), 3)
    })

    it('a build with nothing missing still skips everything', async () => {
        // The regression guard. This is the half a missing-output fix can
        // break, and breaking it is worse than the bug it fixes.
        const report = await build()
        assert.equal(report.rendered.length, 0)
        assert.equal(await htmlCount(workdir), 3)
    })

    it('deleting one output re-renders only that one, as output-missing', async () => {
        await rm(path.join(workdir, 'out', 'two'), { recursive: true })
        const report = await build()
        assert.equal(report.rendered.length, 1)
        assert.equal(report.rendered[0].destination, '/two/index.html')
        assert.equal(report.rendered[0].reason, 'output-missing')
        assert.equal(report.rendered[0].id, '/documents/two.md')
        assert.equal(await htmlCount(workdir), 3)
    })

    it('deleting the whole output folder rebuilds the site', async () => {
        await rm(path.join(workdir, 'out'), { recursive: true })
        assert.equal(await htmlCount(workdir), 0)
        const report = await build()
        assert.equal(report.rendered.length, 3)
        assert.deepEqual(report.rendered.map(e => e.destination).sort(), [...PAGES].sort())
        for (const entry of report.rendered) assert.equal(entry.reason, 'output-missing')
        assert.equal(await htmlCount(workdir), 3)
    })

    it('reports a non-zero render count rather than a silent success', async () => {
        // What a person actually sees. The bug's whole character was that the
        // absence of this line was the only signal, so assert the line exists.
        await rm(path.join(workdir, 'out'), { recursive: true })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), /Rendered:\s*3/)
    })

    it('--explain agrees with the build, in both directions', async () => {
        // --explain has its own copy of the prediction, and it is the tool
        // someone reaches for once a build has already surprised them. It
        // contradicting the build is worse than it being incomplete.
        const explain = async () => stripAnsi(
            (await runMikser(workdir, ['--explain', '/documents/one.md'])).combined)

        const present = await explain()
        assert.match(present, /\[current\]/)
        assert.match(present, /would be SKIPPED/)

        await rm(path.join(workdir, 'out', 'one'), { recursive: true })
        const absent = await explain()
        assert.match(absent, /\[MISSING: the file is not on disk\]/)
        assert.match(absent, /would re-render — the output is gone from disk/)
        assert.doesNotMatch(absent, /would be SKIPPED/)

        // And the build it predicted actually happens.
        const report = await build()
        assert.equal(report.rendered.length, 1)
        assert.equal(report.rendered[0].reason, 'output-missing')
    })

    it('leaves --audit-output with nothing to report', async () => {
        // The two must agree. `--audit-output` finding files the build just
        // called unchanged is the symptom, not a separate diagnostic.
        const { code, combined } = await runMikser(workdir, ['--audit-output'])
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), /Audit OK: 3 snapshots, 0 missing/)
    })
})

// Reported against a forwarded build, and worth pinning there too: the
// instance answers from its own view of the catalog, so if any gate consulted
// per-process state rather than the disk this is where it would show.
describe('a forwarded build re-renders a missing output', () => {
    const workdir = freshWorkdir('missing-output-forwarded')
    let instance

    before(async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir)
        instance = spawn(process.execPath, [
            path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir,
            '--watch', '--server', '3772',
        ], { stdio: ['ignore', 'pipe', 'pipe'] })
        const endpoint = socketPath(workdir)
        for (let i = 0; i < 200; i++) {
            if (existsSync(endpoint)) return
            await new Promise(r => setTimeout(r, 100))
        }
        instance.kill()
        throw new Error('instance never opened its socket')
    })
    after(async () => { instance?.kill(); await cleanup(workdir) })

    it('rebuilds the site instead of reporting a clean incremental build', async () => {
        assert.equal(await htmlCount(workdir), 3)
        await rm(path.join(workdir, 'out'), { recursive: true })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), /Rendered:\s*3/)
        assert.equal(await htmlCount(workdir), 3)
    })
})

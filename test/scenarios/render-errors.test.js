// A build whose renders throw must not report success.
//
// The failure mode is the green-build-wrong-site class, and it was quiet in
// all three machine-readable channels at once: the report had no error
// bucket, failed entities sat in `rendered` (so `rendered: 12` beside zero
// written files), and the exit code was 0. Only the human log knew, which
// makes `mikser && mikser --audit-output` in CI pass with every page stale.
//
// --audit-output is NOT the place to fix it, and is correct as it stands: a failed
// render writes no snapshot, so the manifest still describes the previous
// good render and the previous good bytes are still on disk. Not clobbering
// good output on a failed render is what makes the failure survivable — and
// also what makes it invisible.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' }, cleanUrls: false }),
        renderHbs(),
    ],
}
`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    // A partial every page includes, so deleting it reaches all of them.
    'layouts/page.hbs': '<html><body>{{> partials/btn}}<p>{{document.meta.title}}</p></body></html>',
    'layouts/partials/btn.hbs': '<button>go</button>',
    'documents/page-a.md': '---\ntitle: A\n---\nx\n',
    'documents/page-b.md': '---\ntitle: B\n---\ny\n',
    'documents/page-c.md': '---\ntitle: C\n---\nz\n',
}

describe('a build with render errors', () => {
    const workdir = freshWorkdir('render-errors')
    after(() => cleanup(workdir))

    const build = async () => {
        const result = await runMikser(workdir, ['--json'])
        return { code: result.code, report: JSON.parse(result.stdout) }
    }
    const outputOf = (file) => readFile(path.join(workdir, 'out', file), 'utf8')

    let goodOutput

    it('a healthy build exits 0 with no errors', async () => {
        await setupFixture(workdir, FIXTURE)
        const { code, report } = await build()
        assert.equal(code, 0)
        assert.equal(report.summary.rendered, 3)
        assert.equal(report.summary.errors, 0)
        assert.deepEqual(report.errors, [])
        goodOutput = await outputOf('page-a.html')
        assert.ok(goodOutput.includes('<button>'))
    })

    it('exits non-zero when renders throw', async () => {
        // The signal a CI gate needs. `mikser && mikser --audit-output` must not
        // pass a build in which nothing rendered.
        await rm(path.join(workdir, 'layouts', 'partials', 'btn.hbs'))
        const { code } = await build()
        assert.notEqual(code, 0, 'a build with failed renders is not a success')
    })

    it('records each failure with enough to find it', async () => {
        await writeFile(path.join(workdir, 'documents', 'page-a.md'),
            '---\ntitle: A again\n---\nx\n')
        const { report } = await build()
        assert.ok(report.errors.length > 0)
        const failure = report.errors.find(e => e.id === '/documents/page-a.md')
        assert.ok(failure, 'the failing entity is named')
        assert.equal(failure.destination, '/page-a.html')
        assert.match(failure.error, /partials\/btn/, 'the message names what was missing')
        assert.equal(failure.layout, '/layouts/page.hbs')
    })

    it('does not count a throw as rendered', async () => {
        // `rendered` means the output moved. A throw writes nothing, and
        // summing buckets should not require knowing that a render in the
        // rendered bucket might have failed.
        await writeFile(path.join(workdir, 'documents', 'page-b.md'),
            '---\ntitle: B again\n---\ny\n')
        const { report } = await build()
        assert.ok(report.summary.errors > 0)
        assert.ok(
            !report.rendered.some(e => report.errors.some(f => f.id === e.id)),
            'no entity appears in both rendered and errors',
        )
    })

    it('leaves the previous good output on disk', async () => {
        // Deliberate: the last good bytes survive a failed render, which is
        // what makes the failure recoverable rather than destructive.
        assert.equal(await outputOf('page-a.html'), goodOutput)
    })

    it('goes back to exit 0 once the renders succeed again', async () => {
        await writeFile(path.join(workdir, 'layouts', 'partials', 'btn.hbs'),
            '<button>go</button>')
        const { code, report } = await build()
        assert.equal(code, 0)
        assert.equal(report.summary.errors, 0)
    })
})

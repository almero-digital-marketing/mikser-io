// A failed render is retried until it succeeds.
//
// A failed render writes no snapshot — deliberately, so the last good bytes
// survive — and that one absence made the failure permanent AND invisible:
//
//   - the entity's own source has not changed, so it is gated at import and
//     never re-dispatched
//   - the manifest still describes the last good render, so --verify is clean
//   - --explain reports `[current]` and `would be SKIPPED` for a page whose
//     render is throwing, which is the one tool whose entire job is "why is
//     this not rebuilding"
//
// Every hash agreed. Consistency was exactly why nothing could see it.
//
// mikser_failures records the attempt, layouts unions those ids into its
// dispatch set, and skipDecision answers `retry-failed`. Unbounded and noisy
// by choice: a page that fails every cycle IS failing every cycle, and going
// quiet after the third attempt is the same trade as `rendered: 12, exit 0`.
// `since` and `attempts` are what make the noise readable — "broke just now"
// and "broken for an hour" are different situations.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, readFile } from 'node:fs/promises'
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

const BTN = '<button>go</button>'
const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs': '<html><body>{{> partials/btn}}<p>{{document.meta.title}}</p></body></html>',
    'layouts/partials/btn.hbs': BTN,
    'documents/page-a.md': '---\ntitle: A\n---\nx\n',
    'documents/page-b.md': '---\ntitle: B\n---\ny\n',
}

describe('a failed render is retried', () => {
    const workdir = freshWorkdir('render-retry')
    after(() => cleanup(workdir))

    const build = async () => {
        const result = await runMikser(workdir, ['--json'])
        return { code: result.code, report: JSON.parse(result.stdout) }
    }
    const explain = async (id) => {
        const result = await runMikser(workdir, ['--explain', id])
        return result.stdout.replace(/\x1b\[[0-9;]*m/g, '')
    }

    let goodOutput

    it('builds clean', async () => {
        await setupFixture(workdir, FIXTURE)
        const { code } = await build()
        assert.equal(code, 0)
        goodOutput = await readFile(path.join(workdir, 'out', 'page-a.html'), 'utf8')
    })

    it('fails when the partial goes', async () => {
        await rm(path.join(workdir, 'layouts', 'partials', 'btn.hbs'))
        const { code, report } = await build()
        assert.equal(code, 1)
        assert.equal(report.summary.errors, 2)
    })

    it('KEEPS failing on a build where nothing changed', async () => {
        // The whole point. Nothing has changed, so nothing would schedule
        // these entities — and the previous behaviour was exit 0, errors 0,
        // with the site still stale.
        const { code, report } = await build()
        assert.equal(code, 1, 'a still-broken site must not report success')
        assert.equal(report.summary.errors, 2)
        assert.ok(report.rendered.every(e => e.reason !== 'retry-failed')
            || report.rendered.length === 0, 'a retry that threw is not in rendered')
    })

    it('says how long it has been failing, and how many attempts', async () => {
        const { report } = await build()
        const failure = report.errors.find(e => e.id === '/documents/page-a.md')
        assert.ok(failure.since, '`since` distinguishes "broke just now" from "broken for an hour"')
        assert.ok(failure.attempts >= 3, `expected repeated attempts, got ${failure.attempts}`)
    })

    it('--explain stops calling the destination current', async () => {
        const text = await explain('/documents/page-a.md')
        assert.match(text, /\[STALE: last render attempt failed\]/)
        assert.match(text, /failed .*partials\/btn/, 'names what threw')
        assert.match(text, /would re-render — the last render attempt failed/)
        assert.doesNotMatch(text, /would be SKIPPED/)
    })

    it('--explain flags an edge whose target was deleted since', async () => {
        // `bound` is what the edge resolved to WHEN RECORDED, so a deleted
        // target still showed an id and a hash, which reads as healthy.
        const text = await explain('/documents/page-a.md')
        assert.match(text, /partials\/btn\.hbs.*\[TARGET DELETED SINCE\]/)
    })

    it('leaves the last good output alone throughout', async () => {
        assert.equal(await readFile(path.join(workdir, 'out', 'page-a.html'), 'utf8'), goodOutput)
    })

    it('forgets a failing entity that is deleted', async () => {
        // The marker drains on success, but an entity that is deleted while
        // failing will never render again — so nothing would ever clear its
        // row. One immortal row keeps layouts' dispatch set non-empty for the
        // life of the database, so its idle-cycle early-out never fires
        // again, and the count only ever grows.
        //
        // Cleared on the catalog's DELETE path rather than by a foreign key:
        // a render task's id is not guaranteed to be a row in
        // mikser_entities (paginated children render under derived ids), so
        // an FK would make recordFailure throw from inside the handler that
        // exists to report a render error.
        const { report: before } = await build()
        assert.equal(before.summary.errors, 2, 'both pages are failing')

        await rm(path.join(workdir, 'documents', 'page-a.md'))
        const { report: after } = await build()
        assert.equal(after.summary.errors, 1, 'the deleted entity stops being reported')
        assert.ok(
            !after.errors.some(e => e.id === '/documents/page-a.md'),
            'and is not named among them',
        )
    })

    it('recovers on its own once the partial is back', async () => {
        // No --force, no touch of the documents: the retry set is what brings
        // them back, and it drains itself on success.
        await writeFile(path.join(workdir, 'layouts', 'partials', 'btn.hbs'), BTN)
        const { code, report } = await build()
        assert.equal(code, 0)
        assert.equal(report.summary.errors, 0)
        // page-b, not page-a: the preceding test deletes page-a to check that
        // a deleted entity's marker is forgotten, so the survivor is what the
        // retry brings back.
        assert.ok(report.rendered.some(e => e.id === '/documents/page-b.md'))
    })

    it('stays clean afterwards — the marker is gone', async () => {
        const { code, report } = await build()
        assert.equal(code, 0)
        assert.equal(report.summary.errors, 0)
        assert.equal(report.summary.rendered, 0, 'no lingering retry')
    })
})

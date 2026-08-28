// A template that knows something is wrong, and can now say so in the report.
//
// The commonest way for a page to ship broken is a dispatch that matched no
// branch: a `{{#if}}` / `{% case %}` over a key the DOCUMENT supplied, with a
// typo in it. It renders the empty string, the section is silently missing,
// and every signal reads clean — the same "green with warnings: 0" the
// destination-collision scenario next door was written for.
//
// `warn` was already a template helper, sitting with log/error/debug/trace,
// and it already printed to the terminal. What it could not do was reach the
// build REPORT, because renders run in a worker: a separate thread with its
// own runtime singleton, unable to touch runtime.state.report. Only `logger`
// crossed the port. So a template could say something was wrong and the build
// still summarised warnings: 0.
//
// These assert the channel, not the phrasing: a warning raised from inside a
// template arrives in report.warnings, carries the entity that raised it, and
// makes the summary stop claiming zero.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

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

// The registry pattern, written the way a real layout writes it: the else
// branch is the whole point. `warn` is registered by nobody here — every
// function on the render runtime becomes a helper automatically, which is what
// makes this engine-agnostic rather than a handlebars feature.
//
// Message first, values after: that is the existing helper's signature, and a
// layout in this repo's own fixture already calls it that way.
const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs':
        '<html><body>'
        + '{{#if (eq document.meta.section "hero")}}<div class="hero"></div>'
        + '{{else}}{{warn "section-no-match" document.meta.section}}'
        + '{{/if}}'
        + '</body></html>',
    'documents/good.md': '---\nhref: /good\nsection: hero\n---\n',
    'documents/typo.md': '---\nhref: /typo\nsection: heroo\n---\n',
}

describe('a template can raise a warning that reaches the report', () => {
    const workdir = freshWorkdir('template-warning')
    after(() => cleanup(workdir))

    // Built ONCE and shared. A second run of the same fixture re-renders
    // nothing, and a warning is raised by a RENDER — so the second report is
    // legitimately clean. Rebuilding per test would assert that away.
    let code, report
    before(async () => {
        await setupFixture(workdir, FIXTURE)
        const result = await runMikser(workdir, ['--json'])
        code = result.code
        report = JSON.parse(result.stdout)
    })

    it('carries the message out of the worker and into report.warnings', async () => {
        const warning = report.warnings.find(w => w.code === 'template-warning')
        assert.ok(warning, `expected a template-warning, got ${JSON.stringify(report.warnings)}`)
        assert.match(warning.message, /section-no-match/, 'the code the author chose survives')
        assert.match(warning.message, /heroo/, 'and so does the offending value')
    })

    it('names the entity that raised it', async () => {
        // A warning nobody can trace back to a page is barely a warning.
        const warning = report.warnings.find(w => w.code === 'template-warning')
        assert.equal(warning.entity, '/documents/typo.md')
        assert.equal(warning.layout, 'page')
    })

    it('stops the build reporting warnings: 0 when a section went missing', async () => {
        assert.notEqual(report.summary.warnings, 0,
            'a build that dropped a section must not report warnings: 0')
    })

    it('warns for the document that got it wrong, and not for the one that did not', async () => {
        const raisedBy = report.warnings.filter(w => w.code === 'template-warning').map(w => w.entity)
        assert.deepEqual(raisedBy, ['/documents/typo.md'])
    })

    it('does not fail the build — a missing section is a warning, not an error', async () => {
        assert.equal(code, 0)
        assert.equal(report.summary.errors, 0)
    })
})

// The path the whole change exists for. TASKS.INLINE is the default and runs
// on the main thread, where the report was always reachable — so a fix that
// only worked there would pass every test above and still leave the real
// failure in place. A document opting into `task: worker` renders in a
// separate thread with its own runtime singleton, and its warning has to
// travel the IPC port to be recorded at all.
describe('a warning raised inside a render WORKER still reaches the report', () => {
    const workdir = freshWorkdir('template-warning-worker')
    after(() => cleanup(workdir))

    let report
    before(async () => {
        await setupFixture(workdir, {
            ...FIXTURE,
            'documents/typo.md': '---\nhref: /typo\nsection: heroo\ntask: worker\n---\n',
        })
        report = JSON.parse((await runMikser(workdir, ['--json'])).stdout)
    })

    it('crosses the thread boundary with its fields intact', () => {
        const warning = report.warnings.find(w => w.code === 'template-warning')
        assert.ok(warning, `expected a template-warning from the worker, got ${JSON.stringify(report.warnings)}`)
        assert.equal(warning.entity, '/documents/typo.md')
        assert.match(warning.message, /section-no-match heroo/)
        assert.notEqual(report.summary.warnings, 0)
    })
})

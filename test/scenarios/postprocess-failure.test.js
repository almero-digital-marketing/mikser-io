// A postprocess that fails wrote no file, so it has to count the same as a
// render that fails.
//
// It did not. The dispatcher caught the throw, unlinked the partial output and
// logged one uncoded `Postprocess error:` line — and that was the whole of it.
// The exit code stayed 0, `errors` in --json never mentioned it, and the build
// signed off with "Mikser completed". A site missing every PDF it was supposed
// to produce reported success, which is the one outcome the rest of this
// engine is built to prevent.
//
// Found while making mikser-io-post-pdf survive a missing chrome: the pages
// failed exactly as intended and the build still passed.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

// Stands in for any postprocessor whose external dependency is absent — no
// chrome to render a PDF, no binary to convert an image.
const POST_BOOM = [
    "export const output = 'pdf'",
    "",
    "export async function postprocess({ entity }) {",
    "    throw new Error(`nothing to render with, so ${entity.destination} was not written`)",
    "}",
].join('\n')

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), frontMatter(), yaml(), layouts(), renderHbs()],
}
`

describe('a postprocess that fails', () => {
    const workdir = freshWorkdir('postprocess-failure')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'plugins/post-boom.js': POST_BOOM,
            'documents/report.md': '---\nlayout: report\n---\nhello',
            'layouts/report.html-boom.hbs': '<html>{{{document.content}}}</html>',
        })
    })

    it('exits non-zero, rather than reporting a build that lost its output', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 1,
            `a build that could not write its output must not exit 0\n${combined}`)
        assert.match(combined, /Postprocess error:.*report/,
            `the failure should still name the entity\n${combined}`)
        assert.doesNotMatch(combined, /🟢 Mikser completed\s*$/,
            `the build must not sign off as clean\n${combined}`)
    })

    it('carries the failure into --json errors, with the postprocessor named', async () => {
        const { stdout } = await runMikser(workdir, ['--force', '--json'])
        const report = JSON.parse(stdout)

        assert.ok(Array.isArray(report.errors), 'expected an errors array')
        const entry = report.errors.find(e => (e.id ?? '').includes('report'))
        assert.ok(entry,
            `the failed entity must appear in errors\n${JSON.stringify(report.errors)}`)
        // Which stage failed is the actionable part — a chain has several, and
        // "one of them threw" does not say which to go look at.
        assert.equal(entry.postprocessor, 'boom')
        assert.match(entry.error, /was not written/)
        assert.equal(report.summary.errors, 1)
    })

    it('still writes no destination for the stage that failed', async () => {
        await runMikser(workdir, ['--force'])
        // The chain is all-or-nothing: on a throw the dispatcher unlinks the
        // intermediates it produced and the final destination. Counting the
        // failure as an error must not have changed that.
        assert.equal(existsSync(path.join(workdir, 'out', 'report.pdf')), false,
            'a failed chain must not leave its destination behind')

        // The renderer's own output is deliberately NOT unlinked on failure,
        // unlike on success. It is the input the next cycle's retry needs, and
        // for a converter it is real content in its own right — the HTML of a
        // report whose PDF could not be produced. Asserted so a change here is
        // a decision rather than a regression.
        assert.equal(existsSync(path.join(workdir, 'out', 'report.html')), true,
            'the renderer output should survive a failed conversion')
    })
})

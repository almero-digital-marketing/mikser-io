// `pages` is the pagination COUNT, and a sidecar returning anything else
// produced nothing at all.
//
// The guard was truthiness and the loop was `page < data.pages`, so a value
// that is truthy but not a positive number passed the first and ran zero times
// in the second: `{ pages: [] }` coerces to 0, `{ pages: [{…}] }` to NaN. The
// layout produced NO file, no error, no warning, was not counted in
// `Rendered:` and left no manifest snapshot — so --audit-output could not see
// it either, because an entity that never rendered has no snapshot to be
// missing. A green build with the page simply absent.
//
// `pages` is also the obvious name for the list in a sitemap, which is exactly
// where it lands, and it cost a day on a build reporting `Rendered: 147` and
// `🟢 Mikser completed`.
//
// Reported rather than reinterpreted: the key has one meaning, and guessing a
// second from the value's type is how a name comes to mean two things
// depending on what you put in it.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`

const sidecar = (body) => `export async function load() { return { ${body} } }\n`

describe('a sidecar returning `pages` as something other than a count', () => {
    const workdir = freshWorkdir('sidecar-pages')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/zzz.html.hbs': 'out',
            'layouts/zzz.js': sidecar("pages: []"),
            'documents/d.html': '---\nlayout: zzz\n---\n',
        })
    })

    const run = async (body, args = []) => {
        await writeFile(path.join(workdir, 'layouts/zzz.js'), sidecar(body))
        return runMikser(workdir, ['--force', ...args])
    }

    it('fails the build instead of quietly producing nothing', async () => {
        const { code, combined } = await run("pages: []")
        assert.equal(code, 1, `a page that does not exist is not a green build\n${combined}`)
        assert.match(combined, /Mikser completed with 1 render error/, combined)
    })

    it('names the key, what was passed, and what to do', async () => {
        const { combined } = await run("pages: []")
        assert.match(combined, /\[layout-pages-not-a-count\]/, combined)
        assert.match(combined, /an array of 0/, `say what was actually passed\n${combined}`)
        assert.match(combined, /Rename it \(`items`, `entries`, `urls`\)/, combined)
    })

    it('does the same for a non-empty array, which coerces to NaN', async () => {
        const { code, combined } = await run("pages: [{ destination: '/a.txt' }]")
        assert.equal(code, 1, combined)
        assert.match(combined, /an array of 1/, combined)
    })

    it('does not take the whole build down with it', async () => {
        // The first attempt at this threw from onBeforeRender — a lifecycle
        // hook, not a render — which killed the process with a raw stack
        // trace. One mistyped sidecar stopping every other page trades a
        // silent failure for a total one.
        const { combined } = await run("pages: []")
        assert.doesNotMatch(combined, /at onBeforeRenderHandler/, combined)
        assert.doesNotMatch(combined, /Node\.js v/, `a stack trace is not a diagnosis\n${combined}`)
        assert.match(combined, /Mikser completed/, 'the build still finishes and reports')
    })

    it('reaches --json as a counted error, not just a line', async () => {
        const { stdout } = await run("pages: []", ['--json'])
        const report = JSON.parse(stdout)
        assert.equal(report.summary.errors, 1, JSON.stringify(report.summary))
        assert.match(report.errors[0].error, /pagination COUNT/, JSON.stringify(report.errors))
        assert.ok(report.faults.some(f => f.code === 'layout-pages-not-a-count'),
            JSON.stringify(report.faults))
    })

    it('still paginates when `pages` is a real count', async () => {
        const { code, combined } = await run("pages: 3")
        assert.equal(code, 0, combined)
        assert.match(combined, /Rendered: 3/, combined)
    })

    it('leaves a single page alone, and 0 means no pagination', async () => {
        for (const [body, rendered] of [["pages: 1", 1], ["pages: 0", 1]]) {
            const { code, combined } = await run(body)
            assert.equal(code, 0, combined)
            assert.match(combined, new RegExp(`Rendered: ${rendered}`), `${body}\n${combined}`)
        }
    })

    it('does not touch a key that is not reserved', async () => {
        const { code, combined } = await run("items: []")
        assert.equal(code, 0, combined)
        assert.match(combined, /Rendered: 1/, combined)
        assert.doesNotMatch(combined, /layout-pages-not-a-count/, combined)
    })
})

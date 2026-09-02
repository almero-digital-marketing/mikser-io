// The build reports what the emitted output points at and did not write.
//
// The url helpers BUILD paths rather than resolving entities, so a wrong
// preset, a wrong extension, or a derivative that silently failed all ship a
// well-formed url pointing at nothing on a green build. Nothing else catches
// it: --audit-output compares snapshots against what was rendered, not against what
// those renders point at, and refs tracking covers document-to-document refs,
// not urls.
//
// Two outcomes are reported separately, because they are different situations:
//
//   BROKEN     resolves to no file
//   OVER-DEEP  resolves only because the browser floored a `..` run at the
//              site root — it loads today, and breaks the moment the same
//              markup renders one level deeper
//
// Warn, never fail: a missing asset must not stop a dev server. Both carry
// stable codes into --json so a deploy script can decide for itself.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), files({ outputFolder: 'files' }), frontMatter(), layouts(), renderHbs()],
}
`

// One page. cleanUrls puts it at out/deep/page/index.html, so its directory
// is two levels below the output root — deep enough for one `..` too many
// to be floored rather than to escape.
//
//   ok        ../../files/logo.svg  → files/logo.svg, exact climb, fine
//   overDeep  ../../../files/logo.svg → one `..` too many, floored, still loads
//   broken    ../../files/nope.svg  → resolves nowhere
//   external  left alone entirely
const PAGE_LAYOUT = [
    '<!doctype html><body>',
    '<img src="../../files/logo.svg">',
    '<img src="../../../files/logo.svg">',
    '<img src="../../files/nope.svg">',
    '<a href="https://example.test/x">out</a>',
    '<img src="data:image/gif;base64,AAA">',
    '</body>',
].join('')

describe('references in the emitted output', () => {
    const workdir = freshWorkdir('broken-references')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'files/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'documents/deep/page.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': PAGE_LAYOUT,
        })
    })

    it('names the reference that resolves to nothing, and the page that made it', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, `a broken reference must warn, not fail\n${combined}`)
        assert.match(combined, /Resolves to nothing: \.\.\/\.\.\/files\/nope\.svg/,
            `expected the broken url to be named\n${combined}`)
        assert.match(combined, /deep\/page\/index\.html/,
            `expected the page that linked it to be named\n${combined}`)
    })

    it('reports an over-deep reference separately from a broken one', async () => {
        const { combined } = await runMikser(workdir, ['--force'])
        // One entry, so it is reported as a latent 404 rather than collapsed
        // into a structural base mismatch — the two want different reactions.
        assert.match(combined, /1 reference\(s\) climb 1 level\(s\) above the site root/,
            `expected the floored url to be reported as over-deep\n${combined}`)
        assert.match(combined, /Examples: \.\.\/\.\.\/\.\.\/files\/logo\.svg/,
            `expected the url to be named\n${combined}`)
        // It is not broken — it resolves. Reporting it as such would be wrong
        // and would drown the reference that genuinely resolves nowhere.
        assert.doesNotMatch(combined, /Resolves to nothing: \.\.\/\.\.\/\.\.\/files\/logo\.svg/,
            `an over-deep url still resolves and must not be called broken\n${combined}`)
    })

    it('leaves the correct reference, the external link and the data uri alone', async () => {
        const { stdout } = await runMikser(workdir, ['--force', '--json'])
        const report = JSON.parse(stdout)
        const codes = (report.warnings ?? []).map(w => w.code)

        const broken = (report.warnings ?? []).filter(w => w.code === 'reference-broken')
        assert.equal(broken.length, 1,
            `exactly one reference resolves to nothing\n${JSON.stringify(broken, null, 2)}`)
        assert.match(broken[0].url, /nope\.svg/)

        assert.ok(codes.includes('reference-over-deep'),
            `the over-deep code should reach --json\n${codes.join(', ')}`)

        const summary = (report.warnings ?? []).find(w => w.code === 'reference-broken-summary')
        assert.ok(summary, 'expected a summary line')
        // The control, the external link and the data uri must all have been
        // counted-or-skipped correctly: 3 site-local urls checked, 1 broken.
        assert.equal(summary.broken, 1)
        assert.equal(summary.checked, 3)
    })
})

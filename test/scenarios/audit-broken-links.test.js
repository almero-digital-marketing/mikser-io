// What `--audit-output` can see on disk, when what is on disk is a symlink.
//
// The walk was files-only, and a symlink is not a file, so neither a live one
// nor a dangling one came back from it. The one check whose job is "what is on
// disk that mikser did not record" therefore read `0 orphaned` over a tree of
// links pointing at deleted sources — the state a deploy script's own `stat`
// walk crashed on, twice, which is how it was found rather than here.
//
// Both halves are the point. A link that resolves is how every static file on
// a mikser site is published, and reporting those would bury the check in
// thousands of findings; a link that resolves to nothing is a 404 wearing a
// file's name, whoever made it.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { symlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), files(), frontMatter(), layouts(), renderHbs()] }
`

describe('--audit-output over a link that resolves to nothing', () => {
    const workdir = freshWorkdir('audit-broken-links')
    after(() => cleanup(workdir))
    let report, combined, code

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'files/media/logo.svg': '<svg/>',
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
        })
        assert.equal((await runMikser(workdir)).code, 0)

        // Not one of files()' own — it points outside the files folder, so
        // the plugin's reconciliation leaves it alone and the audit is the
        // only thing that can say anything about it. An operator's link to a
        // path that only exists on the deploy host looks exactly like this,
        // which is why it is reported rather than removed.
        await mkdir(path.join(workdir, 'out/legacy'), { recursive: true })
        await symlink(path.join(workdir, 'nowhere/brochure.pdf'),
            path.join(workdir, 'out/legacy/brochure.pdf'), 'file')

        const audit = await runMikser(workdir, ['--audit-output', '--json'])
        report = JSON.parse(audit.stdout)
        const human = await runMikser(workdir, ['--audit-output'])
        combined = stripAnsi(human.combined)
        code = human.code
    })

    it('names the link, as the path it is in the output', () => {
        assert.deepEqual(report.broken.map(b => b.path), ['legacy/brochure.pdf'],
            JSON.stringify(report.broken))
    })

    it('does not read as OK, which is what it did over the real failure', () => {
        assert.equal(report.verdict, 'WARN')
        assert.equal(code, 1, 'a warning verdict exits 1')
    })

    it('says so in the human report too, not only under --json', () => {
        assert.match(combined, /Broken link: legacy\/brochure\.pdf/, combined)
        assert.match(combined, /1 broken links/, combined)
    })

    it('says nothing about the live link every served file is', () => {
        // files() publishes by linking its source into the output. Nothing
        // renders a link, so no snapshot claims one — asking the orphan
        // question of them would report every static file on the site.
        assert.equal(report.broken.some(b => b.path.includes('logo.svg')), false)
        assert.equal(report.orphaned.some(o => o.path.includes('logo.svg')), false,
            `a published file is not an orphan\n${JSON.stringify(report.orphaned)}`)
    })

    it('still reports no orphans for the folders the walk now returns', () => {
        // The walk stopped being files-only to see links at all, so every
        // directory in the output arrives with them.
        assert.deepEqual(report.orphaned, [], JSON.stringify(report.orphaned))
    })
})

// "Never written" and "written somewhere else" are different problems.
//
// Both surface as a url that resolves to nothing, and both were reported with
// the same sentence — so the reader had to go and find out which. A target
// whose file exists elsewhere in the output is almost always a base problem:
// the url was built from the wrong root, or carries a segment too many.
// Naming where the file actually is turns the report into the answer.
//
// The index is built only when something is broken, so a clean build pays
// nothing for it.

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

// One url with a bad base for a file that DOES exist, one for a file that
// exists nowhere, and one that is simply correct.
const LAYOUT = [
    '<!doctype html><body>',
    '<img src="../wrong/files/icons/arrow.svg">',
    '<img src="../../files/icons/nothere.svg">',
    '<img src="../../files/icons/arrow.svg">',
    '</body>',
].join('')

describe('a wrong base is not a missing file', () => {
    const workdir = freshWorkdir('reference-wrong-base')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'files/icons/arrow.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'documents/deep/page.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': LAYOUT,
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        out = combined
    })

    it('says where the file actually is, when it is somewhere', () => {
        assert.match(out, /Points at the wrong place: \.\.\/wrong\/files\/icons\/arrow\.svg/,
            `expected the misplaced url to be named\n${out}`)
        assert.match(out, /the file is at files\/icons\/arrow\.svg/,
            `expected the real location, which is the actionable half\n${out}`)
    })

    it('says nothing produced it, when nothing did', () => {
        assert.match(out, /nothing produced it: \.\.\/\.\.\/files\/icons\/nothere\.svg/,
            `a target that exists nowhere is a different problem\n${out}`)
    })

    it('counts the two kinds separately', () => {
        assert.match(out, /Wrong base \(the file exists elsewhere\): 1\. Never produced: 1\./, out)
    })

    it('leaves the correct reference alone', () => {
        assert.doesNotMatch(out, /arrow\.svg.*\n.*arrow\.svg.*arrow\.svg/, out)
        // Three urls, two problems: the correct one is not among them.
        assert.match(out, /2 of 3 reference\(s\)/, out)
    })
})

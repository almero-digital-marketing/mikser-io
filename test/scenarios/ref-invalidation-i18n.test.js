// Demonstrates the multilingual over-invalidation problem.
//
// Two languages, four entities:
//   - authors/dick.en.yml  (meta.lang: en, meta.href: /authors/dick)
//   - authors/dick.fr.yml  (meta.lang: fr, meta.href: /authors/dick)
//   - posts/post-en.html   ($author: /authors/dick, meta.lang: en)
//   - posts/post-fr.html   ($author: /authors/dick, meta.lang: fr)
//
// The refs index stores the LITERAL ref string. Both posts have
// target_ref = '/authors/dick'. inverseClosureOf seeds on
// lookupKeys(mutated-entity) which includes meta.href = '/authors/dick'.
// So changing dick.en pulls BOTH post-en and post-fr into the closure
// regardless of language — and the manifest skip layer also doesn't
// constrain on lang.
//
// Expectation: changing the EN author should only re-render the EN
// post. Currently it re-renders both. Test asserts the IDEAL behavior,
// fails on the actual behavior — failure mode is the design point.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const MINIMAL_CONFIG = `
import { documents, frontMatter, yaml, layouts, renderHbs } from 'mikser-io'
export default {
    plugins: [documents(), frontMatter(), yaml(), layouts({ autoLayouts: true }), renderHbs()],
}
`

// Plain layout — doesn't actually render the author. The $-ref alone
// is what creates the dependency edge; that's the entire point.
const POST_LAYOUT = '<html><body lang="{{document.meta.lang}}">{{{document.content}}}</body></html>'

function authorDoc(lang, name) {
    return `lang: ${lang}\nhref: /authors/dick\nname: ${name}\n`
}

function postDoc(lang, body) {
    return `---\nlayout: post\nlang: ${lang}\n$author: /authors/dick\n---\n${body}`
}

function rendered(stdout) {
    const m = stdout.match(/Rendered: (\d+)/)
    return m ? Number(m[1]) : 0
}

describe('multilingual ref invalidation', () => {
    const workdir = freshWorkdir('ref-i18n')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/authors/dick.en.yml': authorDoc('en', 'Dick'),
            'documents/authors/dick.fr.yml': authorDoc('fr', 'Dick (fr)'),
            'documents/posts/post-en.html': postDoc('en', '<p>english post</p>'),
            'documents/posts/post-fr.html': postDoc('fr', '<p>french post</p>'),
            'layouts/post.hbs': POST_LAYOUT,
        })
    })

    it('cold start renders both posts', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.equal(rendered(combined), 2, `expected 2 renders\n${combined}`)
    })

    it('change EN author → only EN post should re-render', async () => {
        await writeFile(
            path.join(workdir, 'documents/authors/dick.en.yml'),
            authorDoc('en', 'Dick Updated'),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        // Ideal: 1 (the EN post — only it depends on the EN author's content).
        // Current: 2 (both posts, because refs aren't language-scoped).
        assert.equal(rendered(combined), 1,
            `expected only EN post to re-render; FR's author entity (dick.fr.yml) didn't change\n${combined}`)
    })

    it('change FR author → only FR post should re-render', async () => {
        await writeFile(
            path.join(workdir, 'documents/authors/dick.fr.yml'),
            authorDoc('fr', 'Dick (fr) Updated'),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.equal(rendered(combined), 1,
            `expected only FR post to re-render; EN's author entity didn't change\n${combined}`)
    })
})

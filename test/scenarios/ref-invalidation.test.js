// Integration tests for ref-based invalidation.
//
// The architectural claim: when entity A declares `$ref: B` and B
// changes, A re-renders. The refs index records the static edge at
// catalog.onPersist; layouts.onBeforeRender's inverseClosureOf walk
// finds A when B mutates; the manifest doesn't skip A because B's
// dep-hash changed.
//
// Validates the path end-to-end:
//   1. Cold render establishes baseline
//   2. Modify a referenced entity (author)
//   3. Re-run — only entities with that $ref should re-render
//   4. Modify a different referenced entity
//   5. Only the other set should re-render

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const MINIMAL_CONFIG = `
export default {
    plugins: ['documents', 'front-matter', 'yaml', 'layouts', 'render-hbs'],
}
`

// Layout reads document content + references author via $author. The
// {{$author.id}} access goes through refs resolution; even without
// that, the static $-ref in frontmatter records an edge in mikser_refs.
const POST_LAYOUT = '<html><body><p>post by {{$author.id}}</p>{{{document.content}}}</body></html>'

function authorDoc(name) {
    return `name: ${name}\n`
}

function postDoc(body, authorId) {
    return `---\nlayout: post\n$author: ${authorId}\n---\n${body}`
}

function rendered(stdout) {
    const m = stdout.match(/Rendered: (\d+)/)
    return m ? Number(m[1]) : 0
}

describe('ref-based invalidation', () => {
    const workdir = freshWorkdir('ref-invalidation')
    after(() => cleanup(workdir))

    before(async () => {
        // Note: the documents plugin keeps file extensions in entity
        // ids by default — `dick.yml` → `/documents/authors/dick.yml`.
        // $-ref strings must match the full id (extension included) or
        // findById returns undefined and the refClosure entry gets
        // recorded without a hash, breaking manifest invalidation.
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/authors/dick.yml': authorDoc('Dick'),
            'documents/authors/jane.yml': authorDoc('Jane'),
            'documents/posts/post-1.html': postDoc('<p>post 1 body</p>', '/documents/authors/dick.yml'),
            'documents/posts/post-2.html': postDoc('<p>post 2 body</p>', '/documents/authors/dick.yml'),
            'documents/posts/post-3.html': postDoc('<p>post 3 body</p>', '/documents/authors/jane.yml'),
            'layouts/post.hbs': POST_LAYOUT,
        })
    })

    it('cold start renders every post', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        // 3 posts. Authors are yml (no layout), so they don't render.
        assert.equal(rendered(combined), 3, `expected 3 renders\n${combined}`)
    })

    it('change author dick → posts 1 and 2 re-render, post 3 does not', async () => {
        await writeFile(
            path.join(workdir, 'documents/authors/dick.yml'),
            authorDoc('Dick Updated'),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.equal(rendered(combined), 2,
            `posts 1 + 2 reference $author=dick; only those should re-render\n${combined}`)
    })

    it('change author jane → only post 3 re-renders', async () => {
        await writeFile(
            path.join(workdir, 'documents/authors/jane.yml'),
            authorDoc('Jane Updated'),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.equal(rendered(combined), 1,
            `only post 3 references $author=jane; only it should re-render\n${combined}`)
    })

    it('no changes → no renders', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.equal(rendered(combined), 0,
            `nothing changed; manifest skip should suppress all renders\n${combined}`)
    })
})

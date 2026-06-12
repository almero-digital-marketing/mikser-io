// Aggregate layouts — index pages, sitemaps, RSS feeds — depend on a
// QUERY over the catalog rather than a static \$-ref. When a new entity
// matches the query, the aggregate has to re-render even though no
// static edge connects them.
//
// The mechanism: layout sidecars (and renderer plugins) that call
// `findEntities`/`findEntity` inside a `queryContext.run(...)` (which
// the engine establishes per-render) get their queries tracked into the
// render-time `track` object. `manifest.collectEdges` then folds those
// query filters into the snapshot's refClosure as
// `{kind: 'query', filter: <sift>}` entries.
//
// On the next cycle, `shouldSkip` walks the closure. For query entries
// it runs `sift(filter)` against every mutated entity; ANY match means
// the aggregate's query result *could* have changed, so the skip
// returns false and the render proceeds.
//
// This test exercises that path end-to-end with an index page that
// lists posts via a sidecar findEntities call.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const MINIMAL_CONFIG = `
import { documents, frontMatter, yaml, layouts, renderHbs } from 'mikser-io'
export default {
    plugins: [documents(), frontMatter(), yaml(), layouts({ autoLayouts: true }), renderHbs()],
    layouts: { autoLayouts: true },
}
`

const POST_LAYOUT = '<html><body><h1>{{document.meta.title}}</h1>{{{document.content}}}</body></html>'

// The index layout renders a list of posts. data.posts comes from the
// sidecar's load() — findEntities tracked via queryContext.
const INDEX_LAYOUT = `<html><body><h1>All posts</h1><ul>{{#each data.posts}}<li>{{meta.title}}</li>{{/each}}</ul></body></html>`

const INDEX_SIDECAR = `
export async function load({ findEntities }) {
    const posts = await findEntities({ collection: 'documents', type: 'document', format: 'md' })
    return { posts }
}
`

function postDoc(title, body = '<p>body</p>') {
    return `---\nlayout: post\ntitle: ${title}\n---\n${body}`
}

function indexDoc() {
    return `---\nlayout: index\n---\n`
}

function rendered(stdout) {
    const m = stdout.match(/Rendered: (\d+)/)
    return m ? Number(m[1]) : 0
}

describe('aggregate layout invalidation', () => {
    const workdir = freshWorkdir('aggregate')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/index.html': indexDoc(),
            'documents/posts/post-1.md': postDoc('Post 1'),
            'documents/posts/post-2.md': postDoc('Post 2'),
            'layouts/index.hbs': INDEX_LAYOUT,
            'layouts/index.js': INDEX_SIDECAR,
            'layouts/post.hbs': POST_LAYOUT,
        })
    })

    it('cold renders index + 2 posts', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.equal(rendered(combined), 3, `expected 3 renders (index + 2 posts)\n${combined}`)
    })

    it('add a new post → index re-renders AND the new post renders', async () => {
        await writeFile(
            path.join(workdir, 'documents/posts/post-3.md'),
            postDoc('Post 3'),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        // New post matches the index's query filter → index invalidates.
        // Plus the new post itself renders.
        assert.equal(rendered(combined), 2, `expected 2 renders (index + post-3)\n${combined}`)
    })

    it('modify existing post → index re-renders + that post re-renders', async () => {
        await writeFile(
            path.join(workdir, 'documents/posts/post-1.md'),
            postDoc('Post 1 (updated)'),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        // post-1 mutated → matches index's filter → index invalidates.
        // post-1 itself also re-renders (inputHash changed).
        assert.equal(rendered(combined), 2, `expected 2 renders (index + post-1)\n${combined}`)
    })

    it('delete a post → index re-renders', async () => {
        await rm(path.join(workdir, 'documents/posts/post-2.md'))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        // post-2 DELETE in journal → mutatedEntities has it → index's
        // query matcher sees it → index invalidates. The deleted post
        // itself doesn't render (manifest.remove cleans the snapshot).
        assert.equal(rendered(combined), 1, `expected 1 render (index only)\n${combined}`)
    })

    it('no changes → nothing renders', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.equal(rendered(combined), 0, `expected 0 renders\n${combined}`)
    })
})

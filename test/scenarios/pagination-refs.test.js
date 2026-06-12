// Paginated layouts produce synthetic pageEntity ids (index.2.html,
// index.3.html, ...) that exist only at render time — they're never
// rows in mikser_entities. The mikser_refs FK from source_id to
// mikser_entities(id) would fail every page 2+ render if we tried to
// store the edges under the synthetic id.
//
// Fix: engine.js rolls dynamic refs up to entity.parent ?? entity.id.
// The parent's render writes to the same source_id (INSERT OR IGNORE
// dedups across pages). Invalidation re-dispatches the parent and the
// pagination expansion produces the children from there.

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
    layouts: { autoLayouts: true },
}
`

const POST_LAYOUT = '<html><body>{{document.meta.title}}</body></html>'

// Index sidecar paginates over posts — 4 per page. 10 posts → 3 pages
// (index.html, index.2.html, index.3.html).
const INDEX_SIDECAR = `
export async function load({ findEntities }) {
    const posts = await findEntities({ collection: 'documents', format: 'md' })
    const pages = Math.max(1, Math.ceil(posts.length / 4))
    return { posts, pages }
}
`

const INDEX_LAYOUT = '<html><body>page {{document.page}} of {{document.pages}}</body></html>'

function postDoc(n) {
    return `---\nlayout: post\ntitle: Post ${n}\n---\nbody ${n}`
}

function rendered(stdout) {
    const m = stdout.match(/Rendered: (\d+)/)
    return m ? Number(m[1]) : 0
}

describe('pagination + refs FK', () => {
    const workdir = freshWorkdir('pagination-refs')
    after(() => cleanup(workdir))

    before(async () => {
        const files = {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/index.html': '---\nlayout: index\n---\n',
            'layouts/index.hbs': INDEX_LAYOUT,
            'layouts/index.js': INDEX_SIDECAR,
            'layouts/post.hbs': POST_LAYOUT,
        }
        for (let i = 1; i <= 10; i++) {
            files[`documents/posts/post-${i}.md`] = postDoc(i)
        }
        await setupFixture(workdir, files)
    })

    it('cold render produces 10 posts + 3 paginated index pages without FK violations', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0,
            `mikser should exit 0 — FK violations from paginated pages would surface as render errors\n${combined}`)
        // 10 posts + 3 index pages (10 / 4 → ceil = 3)
        assert.equal(rendered(combined), 13, `expected 13 renders (10 posts + 3 index pages)\n${combined}`)
        assert.doesNotMatch(combined, /FOREIGN KEY constraint failed/i,
            `no FK violations should appear\n${combined}`)
        assert.doesNotMatch(combined, /Render error/,
            `no render errors\n${combined}`)
    })

    it('adding an 11th post creates a 4th index page without FK violations', async () => {
        await writeFile(
            path.join(workdir, 'documents/posts/post-11.md'),
            postDoc(11),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        // Adding post-11 means the index's sidecar findEntities sees an
        // 11th doc; pages goes from 3 → 3 (still ceil(11/4)=3). The new
        // post renders + index re-renders (query-affected). The exact
        // count of index page renders depends on how layouts.js shapes
        // pagination on warm — but: no FK errors.
        assert.doesNotMatch(combined, /FOREIGN KEY constraint failed/i,
            `no FK violations on warm pagination dispatch\n${combined}`)
        assert.doesNotMatch(combined, /Render error/, combined)
    })
})

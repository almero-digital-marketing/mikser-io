// Comprehensive pagination scenarios — the surface that's easy to
// break in subtle ways. Covers:
//   - cold render with pagination
//   - warm no-op (manifest skip across all paginated children)
//   - mutating a post that's in the paginated set
//   - adding a post that fits in current capacity
//   - adding a post that grows the page count
//   - deleting a post that fits in current capacity
//   - deleting a post that shrinks the page count (orphan output cleanup)
//   - collapsing pagination entirely (orphan output cleanup at scale)
//
// Each test runs mikser as a subprocess against an evolving workdir;
// the suite is ordered so each test starts from the previous test's
// state. That mirrors a real watch-mode session and exercises the
// per-cycle journal / catalog / manifest plumbing under realistic
// transitions.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const MINIMAL_CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), frontMatter(), yaml(), layouts({ autoLayouts: true }), renderHbs()],
    layouts: { autoLayouts: true },
}
`

const POST_LAYOUT = '<html><body>{{document.meta.title}}</body></html>'

// Pages of 4 posts each. ceil(N/4) → pages.
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

function pageFile(workdir, n) {
    const name = n === 1 ? 'index.html' : `index.${n}.html`
    return path.join(workdir, 'out', name)
}

describe('pagination — full lifecycle', () => {
    const workdir = freshWorkdir('pagination')
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

    it('cold: 10 posts → 3 pages, no FK violations', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.doesNotMatch(combined, /FOREIGN KEY|Render error/i,
            `FK violations or render errors\n${combined}`)
        // 10 posts + 3 index pages
        assert.equal(rendered(combined), 13, combined)
        assert.ok(existsSync(pageFile(workdir, 1)), 'page 1 output exists')
        assert.ok(existsSync(pageFile(workdir, 2)), 'page 2 output exists')
        assert.ok(existsSync(pageFile(workdir, 3)), 'page 3 output exists')
        assert.ok(!existsSync(pageFile(workdir, 4)), 'page 4 should NOT exist')
    })

    it('warm no-op: nothing renders', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(rendered(combined), 0,
            `expected 0 renders on warm no-op; paginated pages must be skipped by the manifest\n${combined}`)
    })

    it('modify a post: that post + all 3 paginated index pages re-render', async () => {
        await writeFile(
            path.join(workdir, 'documents/posts/post-1.md'),
            postDoc('1 updated'),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        // The modified post itself + 3 index pages (post-1 matches the
        // index's query filter, so all paginated pages invalidate via
        // manifest.queryAffected)
        assert.equal(rendered(combined), 4, combined)
    })

    it('add an 11th post: still 3 pages, post + index pages re-render', async () => {
        await writeFile(
            path.join(workdir, 'documents/posts/post-11.md'),
            postDoc(11),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        // 11 posts → ceil(11/4) = 3 pages still
        // Renders: new post (1) + 3 paginated index pages = 4
        assert.equal(rendered(combined), 4, combined)
    })

    it('add 2 more posts (12 + 13): now 4 pages, new page 4 output appears', async () => {
        await writeFile(path.join(workdir, 'documents/posts/post-12.md'), postDoc(12))
        await writeFile(path.join(workdir, 'documents/posts/post-13.md'), postDoc(13))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        // 13 posts → ceil(13/4) = 4 pages now
        // Renders: 2 new posts + 4 paginated index pages = 6
        assert.equal(rendered(combined), 6, combined)
        assert.ok(existsSync(pageFile(workdir, 4)), 'new page 4 output should exist')
    })

    it('delete post-13: back to 3 pages, page 4 output is cleaned up', async () => {
        await rm(path.join(workdir, 'documents/posts/post-13.md'))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        // 12 posts → 3 pages
        // Renders: 3 index pages (post-13's render is gone; its output
        // is cleaned by manifest)
        assert.equal(rendered(combined), 3, combined)
        assert.ok(!existsSync(pageFile(workdir, 4)),
            'orphaned page 4 output should be cleaned up by manifest pagination-shrunk')
    })

    it('collapse to 3 posts: pagination drops to 1 page; pages 2 and 3 are cleaned', async () => {
        // Delete posts 4..12 — keep 1, 2, 3 only
        for (let i = 4; i <= 12; i++) {
            await rm(path.join(workdir, `documents/posts/post-${i}.md`))
        }

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        // 3 posts → 1 page
        // Render: index (only 1 page now)
        assert.equal(rendered(combined), 1, combined)
        assert.ok(existsSync(pageFile(workdir, 1)), 'page 1 still exists')
        assert.ok(!existsSync(pageFile(workdir, 2)),
            'page 2 output should be cleaned (pagination shrunk)')
        assert.ok(!existsSync(pageFile(workdir, 3)),
            'page 3 output should be cleaned (pagination shrunk)')
    })

    it('warm no-op after collapse: still 0 renders', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(rendered(combined), 0, combined)
    })
})

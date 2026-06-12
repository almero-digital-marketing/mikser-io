// findEntities()/iterateEntities() with no filter records a null
// query dep that conservatively invalidates on every mutation. The
// engine warns the author once per offending rendering entity so they
// know to narrow the call.
//
// Verifies:
//   1. The warning surfaces when a sidecar calls findEntities() with
//      no args
//   2. Authors who narrow the call no longer see the warning

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

const NULL_FILTER_SIDECAR = `
export async function load({ findEntities }) {
    const all = await findEntities()
    return { posts: all }
}
`

const SPECIFIC_FILTER_SIDECAR = `
export async function load({ findEntities }) {
    const posts = await findEntities({ collection: 'documents', format: 'md' })
    return { posts }
}
`

const INDEX_LAYOUT = '<html><body>{{#each data.posts}}<li>{{meta.title}}</li>{{/each}}</body></html>'
const POST_LAYOUT = '<html>{{document.meta.title}}</html>'

describe('null-filter query warning', () => {
    const workdir = freshWorkdir('null-filter')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/index.html': '---\nlayout: index\n---\n',
            'documents/posts/post-1.md': '---\nlayout: post\ntitle: Post 1\n---\nbody',
            'layouts/index.hbs': INDEX_LAYOUT,
            'layouts/index.js': NULL_FILTER_SIDECAR,
            'layouts/post.hbs': POST_LAYOUT,
        })
    })

    it('sidecar with findEntities() and no args triggers a warning', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(combined, /findEntities.+called with no filter from \/documents\/index\.html/,
            `expected the null-filter warning to surface naming the rendering entity\n${combined}`)
        assert.match(combined, /meta\.href.+\$exists/,
            `expected the warning to surface the "all renderable entities" pattern\n${combined}`)
        assert.match(combined, /indexed column/,
            `expected the warning to point at indexed columns as the right shape\n${combined}`)
    })

    it('warning is suppressed once the sidecar narrows the call', async () => {
        // Switch sidecar to a specific filter — no warning expected
        await writeFile(
            path.join(workdir, 'layouts/index.js'),
            SPECIFIC_FILTER_SIDECAR,
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.doesNotMatch(combined, /called with no filter/,
            `narrowed sidecar should not trigger the warning anymore\n${combined}`)
    })
})

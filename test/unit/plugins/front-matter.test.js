import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { frontMatter } from '../../../src/plugins/front-matter.js'
import { createHarness } from '../plugin-harness.js'

function setup(journal) {
    const h = createHarness({ journal })
    frontMatter()(h.core)
    return h
}

describe('front-matter plugin', () => {
    it('registers a single onProcess hook', () => {
        const h = setup([])
        assert.equal(h.hooks.process.length, 1)
    })

    it('parses YAML front matter and assigns it to entity.meta', async () => {
        const entity = {
            id: '/documents/post.md',
            collection: 'documents',
            format: 'md',
            content: '---\ntitle: Hello\nlang: en\n---\nbody here',
        }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.equal(entity.meta.title, 'Hello')
        assert.equal(entity.meta.lang, 'en')
        assert.equal(entity.content.trim(), 'body here')
    })

    it('merges parsed front matter into an existing meta object', async () => {
        const entity = {
            id: '/documents/post.md',
            collection: 'documents',
            format: 'md',
            meta: { existing: 'kept' },
            content: '---\ntitle: Hi\n---\n',
        }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.equal(entity.meta.existing, 'kept')
        assert.equal(entity.meta.title, 'Hi')
    })

    it('leaves entity untouched when content has no front matter', async () => {
        const entity = {
            id: '/documents/raw.md',
            collection: 'documents',
            format: 'md',
            content: 'no front matter here',
        }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.equal(entity.meta, undefined)
        assert.equal(entity.content, 'no front matter here')
    })

    it('ignores entries that have no content', async () => {
        const entity = { id: '/documents/empty.md', collection: 'documents', format: 'md' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.equal(entity.meta, undefined)
    })

    it('processes both CREATE and UPDATE operations', async () => {
        const created = { id: '/a.md', collection: 'documents', content: '---\nx: 1\n---\n' }
        const updated = { id: '/b.md', collection: 'documents', content: '---\ny: 2\n---\n' }
        const deleted = { id: '/c.md', collection: 'documents', content: '---\nz: 3\n---\n' }
        const h = setup([
            { entity: created, operation: 'create' },
            { entity: updated, operation: 'update' },
            { entity: deleted, operation: 'delete' },
        ])
        await h.runHook('process')
        assert.equal(created.meta?.x, 1)
        assert.equal(updated.meta?.y, 2)
        assert.equal(deleted.meta, undefined) // delete should be skipped
    })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { mapper } from '../../../src/plugins/mapper.js'
import { createHarness } from '../plugin-harness.js'

function setup({ mappers = [], journal = [] } = {}) {
    const h = createHarness({ journal })
    mapper({ mappers })(h.core)
    return h
}

describe('mapper plugin', () => {
    it('registers a single onProcess hook', () => {
        const h = setup()
        assert.equal(h.hooks.process.length, 1)
    })

    it('is a no-op when no mappers are configured', async () => {
        const entity = { id: '/a', collection: 'documents' }
        const h = setup({ journal: [{ entity, operation: 'create' }] })
        await h.runHook('process')
        // No log, no mutation
        assert.equal(h.logs.filter(l => l.level === 'trace').length, 0)
    })

    it('applies the map() function to matched entities', async () => {
        const entityA = { id: '/blog/a', collection: 'documents', meta: { tags: ['x'] } }
        const entityB = { id: '/pages/b', collection: 'documents', meta: { tags: ['y'] } }
        const h = setup({
            mappers: [{
                match: { collection: 'documents' },
                map: (e) => { e.meta.touched = true },
            }],
            journal: [
                { entity: entityA, operation: 'create' },
                { entity: entityB, operation: 'update' },
            ],
        })
        await h.runHook('process')
        assert.equal(entityA.meta.touched, true)
        assert.equal(entityB.meta.touched, true)
    })

    it('honors a string glob match', async () => {
        const matched = { id: '/blog/a', collection: 'documents' }
        const skipped = { id: '/pages/b', collection: 'documents' }
        const h = setup({
            mappers: [{
                match: '/blog/**',
                map: (e) => { e.tagged = true },
            }],
            journal: [
                { entity: matched, operation: 'create' },
                { entity: skipped, operation: 'create' },
            ],
        })
        await h.runHook('process')
        assert.equal(matched.tagged, true)
        assert.equal(skipped.tagged, undefined)
    })

    it('respects custom operations list', async () => {
        const created = { id: '/a', collection: 'documents' }
        const deleted = { id: '/b', collection: 'documents' }
        const h = setup({
            mappers: [{
                match: () => true,
                operations: ['delete'],
                map: (e) => { e.seenByMapper = true },
            }],
            journal: [
                { entity: created, operation: 'create' },
                { entity: deleted, operation: 'delete' },
            ],
        })
        await h.runHook('process')
        assert.equal(created.seenByMapper, undefined)
        assert.equal(deleted.seenByMapper, true)
    })

    it('catches map() errors and logs them without aborting the run', async () => {
        const okEntity = { id: '/ok', collection: 'documents', meta: {} }
        const badEntity = { id: '/bad', collection: 'documents', meta: {} }
        const h = setup({
            mappers: [{
                match: () => true,
                map: (e) => {
                    if (e.id === '/bad') throw new Error('boom')
                    e.meta.ok = true
                },
            }],
            journal: [
                { entity: okEntity, operation: 'create' },
                { entity: badEntity, operation: 'create' },
            ],
        })
        await h.runHook('process')
        assert.equal(okEntity.meta.ok, true)
        const errors = h.logs.filter(l => l.level === 'error')
        assert.equal(errors.length, 1)
        assert.match(errors[0].args[0], /Mapper error/)
    })
})

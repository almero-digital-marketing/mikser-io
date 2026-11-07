// A DELETE carries the entity as the catalog last knew it.
//
// Every consumer of a DELETE judges it against a filter — an aggregate's
// recorded query, the api cache, the preview cache, a data export — and the
// callers that see a file vanish know only its path. The lookup has to happen
// when the DELETE is journaled: the catalog applies it at persist, before any
// consumer runs, and the row is gone after that.
//
// The entry is caught at runtime.validate, which every operation passes
// through before it is journaled, so no database is needed to see it.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { deleteEntity } from '../../src/lifecycle.js'
import { OPERATION } from '../../src/constants.js'

const PAGE = {
    id: '/documents/bg/aparati/new.md',
    collection: 'documents',
    type: 'document',
    format: 'md',
    name: 'bg/aparati/new',
    meta: { layout: 'page', lang: 'bg', href: '/devices/new' },
}

// What deleteEntity would have journaled. Rejecting stops it short of the
// journal, which a unit test has no database for.
async function journaled(payload) {
    let seen
    runtime.validators = [async (entry) => {
        seen = entry
        return false
    }]
    await deleteEntity(payload)
    return seen
}

describe('deleteEntity', () => {
    beforeEach(() => {
        runtime.engine = { logger: { debug() {}, warn() {}, error() {} } }
        const rows = new Map([[PAGE.id, PAGE]])
        runtime.catalog = { findById: (id) => rows.get(id) ?? null }
    })

    it('journals the catalog row for a path-only payload', async () => {
        const entry = await journaled({ id: PAGE.id, type: 'document', collection: 'documents' })
        assert.equal(entry.operation, OPERATION.DELETE)
        assert.deepEqual(entry.entity, PAGE)
    })

    it('lets the caller\'s fields win over the stored row', async () => {
        const entry = await journaled({ ...PAGE, meta: { layout: 'post', lang: 'en' } })
        assert.deepEqual(entry.entity.meta, { layout: 'post', lang: 'en' })
    })

    it('journals what it was given when the catalog has no such row', async () => {
        const entry = await journaled({ id: '/documents/never.md', type: 'document', collection: 'documents' })
        assert.deepEqual(entry.entity, { id: '/documents/never.md', type: 'document', collection: 'documents' })
    })

    it('does not hand out the catalog\'s own object', async () => {
        // The row comes from the catalog's cache; a validator that touched
        // the journaled copy would otherwise edit what every reader sees.
        const entry = await journaled({ id: PAGE.id })
        assert.notEqual(entry.entity, PAGE)
    })
})

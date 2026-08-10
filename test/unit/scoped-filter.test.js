// Endpoint scope composition. The shape decides whether the scope reaches SQL
// or runs over materialized rows, and that is the difference between an
// endpoint whose cost tracks its result set and one whose cost tracks the
// whole catalog.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { scopedFilter } from '../../src/catalog.js'

describe('scopedFilter', () => {
    const scope = { 'meta.href': { $regex: '^/(web|system)' } }

    it('is the scope itself when the caller filters on nothing', () => {
        // The case that matters: an unfiltered list against a scoped endpoint
        // must still narrow in the query, not after it.
        assert.deepEqual(scopedFilter(undefined, scope), scope)
        assert.deepEqual(scopedFilter({}, scope), scope)
    })

    it('ands the two together when the caller filters as well', () => {
        const filter = { 'meta.lang': 'bg' }
        assert.deepEqual(scopedFilter(filter, scope), { $and: [filter, scope] })
    })

    it('leaves the filter alone for a function scope', () => {
        // Not translatable, so it stays a post-fetch predicate and the caller
        // keeps applying it.
        const filter = { 'meta.lang': 'bg' }
        assert.equal(scopedFilter(filter, () => true), filter)
        assert.equal(scopedFilter(undefined, () => true), undefined)
    })

    it('is a no-op without a scope', () => {
        const filter = { 'meta.lang': 'bg' }
        assert.equal(scopedFilter(filter, null), filter)
        assert.equal(scopedFilter(filter, undefined), filter)
    })

    it('does not mutate what it is given', () => {
        const filter = { 'meta.lang': 'bg' }
        const before = JSON.stringify(filter)
        scopedFilter(filter, scope)
        assert.equal(JSON.stringify(filter), before)
    })
})

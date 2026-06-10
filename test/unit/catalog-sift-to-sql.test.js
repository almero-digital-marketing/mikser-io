// Unit tests for the sift→SQL translator.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { translate } from '../../src/catalog-sift-to-sql.js'

describe('translate — basic equality', () => {
    it('empty filter → no WHERE clause', () => {
        const t = translate({})
        assert.equal(t.sql, '')
        assert.deepEqual(t.params, [])
        assert.equal(t.jsFilter, null)
        assert.equal(t.scanAll, false)
    })

    it('null filter → no WHERE clause', () => {
        const t = translate(null)
        assert.equal(t.sql, '')
        assert.equal(t.scanAll, false)
    })

    it('indexed field equality → indexed column WHERE', () => {
        const t = translate({ collection: 'documents' })
        assert.equal(t.sql, 'WHERE collection = ?')
        assert.deepEqual(t.params, ['documents'])
        assert.equal(t.jsFilter, null)
    })

    it('multiple indexed fields → AND', () => {
        const t = translate({ collection: 'documents', type: 'document' })
        assert.equal(t.sql, 'WHERE collection = ? AND type = ?')
        assert.deepEqual(t.params, ['documents', 'document'])
    })

    it('dotted-path indexed field → underscore column', () => {
        const t = translate({ 'meta.href': '/foo' })
        assert.equal(t.sql, 'WHERE meta_href = ?')
        assert.deepEqual(t.params, ['/foo'])
    })

    it('non-indexed field → js fallback', () => {
        const t = translate({ 'meta.status': 'published' })
        assert.equal(t.sql, '')
        assert.deepEqual(t.jsFilter, { 'meta.status': 'published' })
    })

    it('mixed indexed + non-indexed → partial pushdown + js fallback', () => {
        const t = translate({ collection: 'documents', 'meta.status': 'published' })
        assert.equal(t.sql, 'WHERE collection = ?')
        assert.deepEqual(t.params, ['documents'])
        assert.deepEqual(t.jsFilter, { 'meta.status': 'published' })
    })
})

describe('translate — operators', () => {
    it('$lt / $gt / $lte / $gte', () => {
        const t = translate({ time: { $lt: 100, $gte: 50 } })
        assert.equal(t.sql, 'WHERE time < ? AND time >= ?')
        assert.deepEqual(t.params, [100, 50])
    })

    it('$in', () => {
        const t = translate({ collection: { $in: ['a', 'b', 'c'] } })
        assert.equal(t.sql, 'WHERE collection IN (?, ?, ?)')
        assert.deepEqual(t.params, ['a', 'b', 'c'])
    })

    it('$in empty → never-matches sentinel', () => {
        const t = translate({ collection: { $in: [] } })
        assert.equal(t.sql, 'WHERE 0')
    })

    it('$nin includes IS NULL for sift parity', () => {
        const t = translate({ id: { $nin: ['x', 'y'] } })
        assert.equal(t.sql, 'WHERE (id IS NULL OR id NOT IN (?, ?))')
        assert.deepEqual(t.params, ['x', 'y'])
    })

    it('$ne against null → IS NOT NULL', () => {
        const t = translate({ type: { $ne: null } })
        assert.equal(t.sql, 'WHERE type IS NOT NULL')
    })

    it('$ne against value → null-safe inequality', () => {
        const t = translate({ type: { $ne: 'document' } })
        assert.equal(t.sql, 'WHERE (type IS NULL OR type != ?)')
        assert.deepEqual(t.params, ['document'])
    })

    it('$exists: true', () => {
        const t = translate({ 'meta.href': { $exists: true } })
        assert.equal(t.sql, 'WHERE meta_href IS NOT NULL')
    })

    it('$exists: false', () => {
        const t = translate({ 'meta.href': { $exists: false } })
        assert.equal(t.sql, 'WHERE meta_href IS NULL')
    })

    it('$regex (string)', () => {
        const t = translate({ id: { $regex: '^/blog/' } })
        assert.equal(t.sql, 'WHERE id REGEXP ?')
        assert.deepEqual(t.params, ['^/blog/'])
    })

    it('$regex (RegExp object) → source', () => {
        const t = translate({ id: { $regex: /^\/foo/ } })
        assert.equal(t.sql, 'WHERE id REGEXP ?')
        assert.deepEqual(t.params, ['^\\/foo'])
    })

    it('unknown operator → js fallback', () => {
        const t = translate({ collection: { $weird: 'x' } })
        assert.equal(t.sql, '')
        assert.deepEqual(t.jsFilter, { collection: { $weird: 'x' } })
    })

    it('translatable + non-translatable op on same field → field js fallback', () => {
        // Mixed → defer entirely to JS so semantics match sift.
        const t = translate({ time: { $lt: 100, $weird: 'x' } })
        assert.equal(t.sql, '')
        assert.deepEqual(t.jsFilter, { time: { $lt: 100, $weird: 'x' } })
    })
})

describe('translate — $or / $and', () => {
    it('$or of indexed equalities', () => {
        const t = translate({
            $or: [{ id: '/foo' }, { 'meta.href': '/foo' }],
        })
        assert.equal(t.sql, 'WHERE ((id = ?) OR (meta_href = ?))')
        assert.deepEqual(t.params, ['/foo', '/foo'])
    })

    it('$or with regex (refFilter shape)', () => {
        const t = translate({
            $or: [
                { id: '/foo' },
                { 'meta.href': '/foo' },
                { id: { $regex: '^/foo\\.[^./]+$' } },
            ],
        })
        assert.equal(t.sql, 'WHERE ((id = ?) OR (meta_href = ?) OR (id REGEXP ?))')
        assert.deepEqual(t.params, ['/foo', '/foo', '^/foo\\.[^./]+$'])
    })

    it('$or with un-indexed inside → js fallback for the whole $or', () => {
        const t = translate({
            $or: [{ id: '/foo' }, { 'meta.status': 'x' }],
        })
        assert.equal(t.sql, '')
        assert.ok(t.jsFilter.$or)
    })

    it('$and with indexed sub-clauses', () => {
        const t = translate({
            $and: [{ collection: 'documents' }, { type: 'document' }],
        })
        assert.equal(t.sql, 'WHERE ((collection = ?) AND (type = ?))')
    })
})

describe('translate — scanAll detection', () => {
    it('all js-fallback → scanAll true', () => {
        const t = translate({ 'meta.status': 'published' })
        assert.equal(t.scanAll, true)
    })

    it('mixed → scanAll false (partial pushdown)', () => {
        const t = translate({ collection: 'documents', 'meta.status': 'published' })
        assert.equal(t.scanAll, false)
    })

    it('all indexed → scanAll false', () => {
        const t = translate({ collection: 'documents' })
        assert.equal(t.scanAll, false)
    })

    it('non-object filter → scanAll true', () => {
        const t = translate('not an object')
        assert.equal(t.scanAll, true)
    })
})

describe('translate — observer sweep filter (audit real case)', () => {
    it('translates the full observer sweep shape', () => {
        const t = translate({
            type:       'document',
            format:     'html',
            collection: 'documents',
            time:       { $lt: 1000 },
            id:         { $nin: ['/a', '/b'] },
        })
        // All indexed dimensions → fully pushed down
        assert.equal(t.jsFilter, null)
        assert.equal(t.scanAll, false)
        // Order matches Object.entries iteration order
        assert.match(t.sql, /^WHERE /)
        assert.match(t.sql, /type = \?/)
        assert.match(t.sql, /format = \?/)
        assert.match(t.sql, /collection = \?/)
        assert.match(t.sql, /time < \?/)
        assert.match(t.sql, /id IS NULL OR id NOT IN \(\?, \?\)/)
    })
})

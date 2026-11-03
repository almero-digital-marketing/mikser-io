// Unit tests for the sift→SQL translator.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'

import Database from 'better-sqlite3'
import sift from 'sift'

import { translate } from '../../../src/database/sift-to-sql.js'

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

    it('equality against null → IS NULL, not `= NULL`', () => {
        // `column = NULL` is NULL in SQL and therefore never true, so this
        // pushed down as a clause matching NOTHING — while sift reads
        // `{field: null}` as "null or absent" and matches both. The clause
        // WAS translatable, so no jsFilter was left behind to correct it and
        // the query simply returned no rows.
        //
        // The shape that found it: a multilingual catalog asking for its
        // language-neutral entities, `{ 'meta.lang': null }`, which is every
        // row imported once because it has no language.
        const t = translate({ 'meta.lang': null })
        assert.equal(t.sql, 'WHERE meta_lang IS NULL')
        assert.deepEqual(t.params, [])
        assert.equal(t.jsFilter, null, 'nothing was left for sift to re-check')
    })

    it('$eq against null → IS NULL', () => {
        const t = translate({ 'meta.lang': { $eq: null } })
        assert.equal(t.sql, 'WHERE meta_lang IS NULL')
        assert.deepEqual(t.params, [])
    })

    it('equality against a value is unchanged', () => {
        const t = translate({ 'meta.lang': 'bg' })
        assert.equal(t.sql, 'WHERE meta_lang = ?')
        assert.deepEqual(t.params, ['bg'])
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

    it('$regex (string) → primary-key range plus the pattern', () => {
        const t = translate({ id: { $regex: '^/blog/' } })
        assert.equal(t.sql, 'WHERE (id >= ? AND id < ? AND id REGEXP ?)')
        assert.deepEqual(t.params, ['/blog/', '/blog0', '^/blog/'])
    })

    it('$regex (RegExp object) → source', () => {
        const t = translate({ id: { $regex: /^\/foo/ } })
        assert.equal(t.sql, 'WHERE (id >= ? AND id < ? AND id REGEXP ?)')
        assert.deepEqual(t.params, ['/foo', '/fop', '^\\/foo'])
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
        assert.equal(
            t.sql,
            'WHERE ((id = ?) OR (meta_href = ?) OR ((id >= ? AND id < ? AND id REGEXP ?)))')
        assert.deepEqual(t.params, ['/foo', '/foo', '/foo.', '/foo/', '^/foo\\.[^./]+$'])
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

    // An $and is true only when every branch is, so any subset of the branches
    // selects a superset of the answer and the rest is the residual matcher's.
    // Punting the whole conjunction instead is a full scan and a JSON.parse per
    // row — the shape every scoped api endpoint takes, caller filter AND scope.
    it('$and pushes the indexed branch and leaves the rest to sift', () => {
        const t = translate({
            $and: [{ 'meta.status': 'published' }, { collection: 'documents' }],
        })
        assert.equal(t.sql, 'WHERE ((collection = ?))')
        assert.deepEqual(t.params, ['documents'])
        assert.deepEqual(t.jsFilter, { $and: [{ 'meta.status': 'published' }] })
        assert.equal(t.scanAll, false)
    })

    it('$and keeps the un-pushed half of a partially pushed branch', () => {
        const t = translate({
            $and: [{ collection: 'documents', 'meta.status': 'x' }],
        })
        assert.equal(t.sql, 'WHERE ((collection = ?))')
        assert.deepEqual(t.jsFilter, { $and: [{ 'meta.status': 'x' }] })
    })

    it('$and with no indexed branch at all still scans', () => {
        const t = translate({
            $and: [{ 'meta.status': 'x' }, { 'meta.route': '/' }],
        })
        assert.equal(t.sql, '')
        assert.equal(t.scanAll, true)
        assert.deepEqual(t.jsFilter, {
            $and: [{ 'meta.status': 'x' }, { 'meta.route': '/' }],
        })
    })

    // The asymmetry with $and: a branch SQL cannot evaluate makes a
    // disjunction unanswerable, because dropping it excludes rows that branch
    // alone would have matched.
    it('$or with one un-indexed branch still punts entirely', () => {
        const t = translate({
            $or: [{ collection: 'documents' }, { 'meta.status': 'x' }],
        })
        assert.equal(t.sql, '')
        assert.ok(t.jsFilter.$or)
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


// The range exists so a $regex on the primary key can be SEEKED instead of
// scanned — inside refFilter's $or it is also what keeps the other three
// branches indexed, since one unindexable branch disqualifies SQLite's
// multi-index OR for all of them. It is only ever a narrowing: the REGEXP
// term still decides, so a prefix read too greedily does not return wrong
// rows, it loses right ones. Hence the agreement test below.
describe('translate — $regex prefix range', () => {
    const paramsFor = (pattern) => translate({ id: { $regex: pattern } }).params

    it('an unanchored pattern has no prefix to range on', () => {
        const t = translate({ id: { $regex: '/blog/' } })
        assert.equal(t.sql, 'WHERE id REGEXP ?')
        assert.deepEqual(t.params, ['/blog/'])
    })

    it('a metacharacter straight after the anchor has none either', () => {
        const t = translate({ id: { $regex: '^(web|system)' } })
        assert.equal(t.sql, 'WHERE id REGEXP ?')
    })

    it('only on the primary key — a secondary index is slower seeked', () => {
        // Measured, not assumed: an index walk plus a primary-key lookup per
        // surviving row cost 5x a plain scan over a 49MB catalog.
        const t = translate({ 'meta.href': { $regex: '^/web/' } })
        assert.equal(t.sql, 'WHERE meta_href REGEXP ?')
        assert.deepEqual(t.params, ['^/web/'])
    })

    it('stops before a character a quantifier can skip', () => {
        assert.deepEqual(paramsFor('^ab*c').slice(0, 2), ['a', 'b'])
        assert.deepEqual(paramsFor('^ab?c').slice(0, 2), ['a', 'b'])
        assert.deepEqual(paramsFor('^ab{2}c').slice(0, 2), ['a', 'b'])
    })

    it('keeps a character `+` requires, and stops after it', () => {
        assert.deepEqual(paramsFor('^ab+c').slice(0, 2), ['ab', 'ac'])
    })

    it('reads an escaped metacharacter as the character itself', () => {
        assert.deepEqual(paramsFor('^a\\.b').slice(0, 2), ['a.b', 'a.c'])
    })

    it('stops at a class escape, which is not a literal', () => {
        assert.deepEqual(paramsFor('^ab\\dz').slice(0, 2), ['ab', 'ac'])
    })

    it('a flagged pattern is left to sift, which honours the flags', () => {
        // The user function compiles the SOURCE and gets no flags, so pushing
        // `/Foo/i` down quietly made it `/Foo/` — the same filter answering
        // differently depending on whether the field happened to be indexed.
        const t = translate({ id: { $regex: /^\/Foo/i } })
        assert.equal(t.sql, '')
        assert.deepEqual(t.jsFilter, { id: { $regex: /^\/Foo/i } })
    })
})

describe('translate — $regex pushdown agrees with sift', () => {
    const ids = [
        '/documents/blog/post.html',
        '/documents/blog/post.md',
        '/documents/blog/post',
        '/documents/blog/post/index.html',
        '/documents/blog/poster.html',
        '/documents/blog/post.with.dots.html',
        '/documents/blog0/post.html',
        '/documents/BLOG/post.html',
        '/documents/blog/post-2.html',
        '/files/blog/post.html',
        '/documents/бг/страница.html',
        '/documents/blog/emoji-😀.html',
    ]

    const db = new Database(':memory:')
    db.exec('CREATE TABLE mikser_entities (id TEXT PRIMARY KEY) WITHOUT ROWID')
    const compiled = new Map()
    db.function('REGEXP', { deterministic: true }, (pattern, value) => {
        if (value == null) return 0
        let regex = compiled.get(pattern)
        if (regex === undefined) {
            try { regex = new RegExp(pattern) } catch { regex = null }
            compiled.set(pattern, regex)
        }
        return regex?.test(String(value)) ? 1 : 0
    })
    const insert = db.prepare('INSERT INTO mikser_entities (id) VALUES (?)')
    for (const id of ids) insert.run(id)
    after(() => db.close())

    const patterns = [
        '^/documents/blog/post\\.[^./]+$',
        '^/documents/blog/post',
        '^/documents/blog/post$',
        '^/documents/blog/post(er)?\\.html$',
        '^/documents/blog/posts*\\.html$',
        '^/documents/blog0?/post\\.html$',
        '^/documents/b[lL]og/post\\.html$',
        '^/documents/\\u0431\\u0433/',
        '^/documents/бг/',
        '^/documents/blog/emoji-😀\\.html$',
        '^/files/',
        '^/',
        'blog',
        '^/documents/blog/post\\d*\\.html$',
    ]

    for (const pattern of patterns) {
        it(`${pattern} selects what sift selects`, () => {
            const filter = { id: { $regex: pattern } }
            const expected = ids.map(id => ({ id })).filter(sift(filter))
                .map(row => row.id).sort()
            const t = translate(filter)
            assert.equal(t.jsFilter, null, 'the whole clause pushed down')
            const actual = db.prepare(`SELECT id FROM mikser_entities ${t.sql}`)
                .raw().all(...t.params).map(row => row[0]).sort()
            assert.deepEqual(actual, expected)
        })
    }
})

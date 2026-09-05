// Phase 3B — catalog query tracking via manifest's refClosure.
//
// shouldSkip needs to handle `kind: 'query'` entries differently from
// target-based entries: rather than matching an id in mutatedRefs, it
// replays the stored sift filter against the cycle's mutated entities
// and returns false if any of them matches. A null filter (sentinel
// for unserializable predicates like function filters) always
// invalidates conservatively.
//
// The catalog-side query recording is exercised end-to-end by the
// smoke fixture (mikser bootstraps with a real catalog, render
// context, and journal). This file covers the decision logic in
// isolation so we can be precise about each branch.

import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import { createManifest, SNAPSHOTS_SCHEMA, FAILURES_SCHEMA } from '../../src/manifest/index.js'
import { createSqliteDatabase } from '../../src/database/index.js'

// The real schema, imported rather than copied — a copy drifts the moment
// the table gains a column and fails with a bare SQLITE_ERROR.
const MANIFEST_SCHEMA = SNAPSHOTS_SCHEMA

// Fresh in-memory database per test so state doesn't leak.
function makeDb() {
    const db = createSqliteDatabase({
        runtimeFolder: '/tmp',
        version: 'test',
        config: { filename: ':memory:' },
        schemas: new Map([
            ['mikser_snapshots', MANIFEST_SCHEMA],
            // The manifest reads mikser_failures too — a retried render is
            // decided from it, so a db without it is not a manifest.
            ['mikser_failures', FAILURES_SCHEMA],
        ]),
    })
    db.open()
    return db
}

// Every test here means "the last render's output is still on disk, so the
// only open question is the query closure". skipDecision checks that premise
// now — a snapshot whose file is gone re-renders regardless of any filter —
// so the destinations have to actually exist or every case short-circuits to
// `output-missing` before reaching the branch under test.
const DESTINATIONS = ['/sitemap.xml', '/featured.html']
const outputFolder = mkdtempSync(path.join(tmpdir(), 'manifest-query-'))
after(() => rmSync(outputFolder, { recursive: true, force: true }))

beforeEach(() => {
    // findById is called by manifest.collectEdges + buildRefClosure
    // to hash $-ref targets. These tests don't seed $-refs, so a stub
    // that's just shaped right is enough — return undefined and the
    // closure falls back to the conservative path.
    runtime.catalog = { byId: new Map() }
    runtime.options ??= {}
    runtime.options.outputFolder = outputFolder
    for (const destination of DESTINATIONS) {
        const file = path.join(outputFolder, destination)
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, 'rendered')
    }
})

describe('manifest.shouldSkip with query closure entries', () => {

    it('skips when no mutation matches the stored filter', () => {
        const m = createManifest(makeDb())
        const entity = { id: '/sitemap', destination: '/sitemap.xml', meta: {}, content: '' }
        m.record(entity, [
            { kind: 'query', filter: { 'meta.layout': 'post' } },
        ])

        const mutatedRefs = new Set(['/authors/foo'])
        const mutatedEntities = new Map([
            ['/authors/foo', { id: '/authors/foo', meta: { layout: 'author' } }],
        ])

        const skip = m.shouldSkip(entity, mutatedRefs, new Map(), mutatedEntities)
        assert.equal(skip, true, 'author mutation should not invalidate a post-query render')
    })

    it('invalidates when a mutation matches the stored filter', () => {
        const m = createManifest(makeDb())
        const entity = { id: '/sitemap', destination: '/sitemap.xml', meta: {}, content: '' }
        m.record(entity, [
            { kind: 'query', filter: { 'meta.layout': 'post' } },
        ])

        const mutatedRefs = new Set(['/posts/new'])
        const mutatedEntities = new Map([
            ['/posts/new', { id: '/posts/new', meta: { layout: 'post', title: 'New' } }],
        ])

        const skip = m.shouldSkip(entity, mutatedRefs, new Map(), mutatedEntities)
        assert.equal(skip, false, 'a post mutation should invalidate a post-query render')
    })

    it('null filter (function-predicate sentinel) always invalidates', () => {
        const m = createManifest(makeDb())
        const entity = { id: '/sitemap', destination: '/sitemap.xml', meta: {}, content: '' }
        m.record(entity, [
            { kind: 'query', filter: null },
        ])

        const skip = m.shouldSkip(entity, new Set(), new Map(), new Map())
        assert.equal(skip, false, 'unserializable filter must force re-render')
    })

    it('mixed closure: layout + query, only the query invalidates', () => {
        const m = createManifest(makeDb())
        const entity = {
            id: '/sitemap',
            destination: '/sitemap.xml',
            meta: {},
            content: '',
            layout: { id: '/layouts/sitemap.hbs', content: '<sitemap/>' },
        }
        // Engine would build [layout, query] from track. Bypass engine
        // here and feed deps directly.
        m.record(entity, [
            { kind: 'layout', target: '/layouts/sitemap.hbs', hash: 'layoutHash' },
            { kind: 'query', filter: { collection: 'posts' } },
        ])

        // Mutation: layout unchanged (no hash difference simulated),
        // post added. Layout entry passes the hash check; query entry
        // matches the post → invalidate.
        const mutatedRefs = new Set(['/posts/new'])
        const currentHashes = new Map()
        const mutatedEntities = new Map([
            ['/posts/new', { id: '/posts/new', collection: 'posts', meta: {} }],
        ])

        const skip = m.shouldSkip(entity, mutatedRefs, currentHashes, mutatedEntities)
        assert.equal(skip, false)
    })

    it('sift operators (e.g. $in, $regex) work in stored filters', () => {
        const m = createManifest(makeDb())
        const entity = { id: '/featured', destination: '/featured.html', meta: {}, content: '' }
        m.record(entity, [
            { kind: 'query', filter: { 'meta.tags': { $in: ['featured', 'editor-pick'] } } },
        ])

        // Non-matching mutation
        const noMatch = m.shouldSkip(
            entity,
            new Set(['/posts/a']),
            new Map(),
            new Map([['/posts/a', { id: '/posts/a', meta: { tags: ['ordinary'] } }]]),
        )
        assert.equal(noMatch, true)

        // Matching mutation
        const match = m.shouldSkip(
            entity,
            new Set(['/posts/b']),
            new Map(),
            new Map([['/posts/b', { id: '/posts/b', meta: { tags: ['featured', 'ordinary'] } }]]),
        )
        assert.equal(match, false)
    })

    it('empty mutations Set skips query renders regardless of filter', () => {
        const m = createManifest(makeDb())
        const entity = { id: '/sitemap', destination: '/sitemap.xml', meta: {}, content: '' }
        m.record(entity, [
            { kind: 'query', filter: { 'meta.layout': 'post' } },
        ])

        const skip = m.shouldSkip(entity, new Set(), new Map(), new Map())
        assert.equal(skip, true, 'no mutations → nothing to match → skip OK')
    })

    it('refClosure dedupes query entries by serialized filter', () => {
        const m = createManifest(makeDb())
        const entity = { id: '/sitemap', destination: '/sitemap.xml', meta: {}, content: '' }
        // Same filter recorded twice (e.g. helper called repeatedly).
        m.record(entity, [
            { kind: 'query', filter: { 'meta.layout': 'post' } },
            { kind: 'query', filter: { 'meta.layout': 'post' } },
        ])
        const snapshot = m.lookup(entity)
        const queryEntries = snapshot.refClosure.filter(e => e.kind === 'query')
        assert.equal(queryEntries.length, 1, 'duplicate query filters collapse to one closure entry')
    })
})

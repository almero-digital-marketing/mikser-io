// Tests for the engine-level inverse-reference index (`runtime.refs`).
// Covers the DB-backed index data structure + subscriber dispatch in
// isolation over an in-memory sqlite database. The lifecycle
// integration (catalog.onPersist maintains catalog_refs inside its
// transaction; engine.js calls replaceDynamic after each render) and
// rename cascade are exercised end-to-end via the smoke test and
// scenarios; this file covers the data-structure invariants without
// driving the full engine harness.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createIndex, createSubscribers } from '../../src/refs.js'
import { createSqliteDatabase } from '../../src/database/index.js'

// catalog_entities schema (parent of the FK). Bare-bones — refs
// tests don't exercise catalog columns.
const CATALOG_SCHEMA = `
    CREATE TABLE IF NOT EXISTS catalog_entities (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
    ) WITHOUT ROWID;
`

// catalog_refs schema. Mirrors the production registration in
// src/refs.js — duplicated here so refs tests don't import side-
// effecting modules just to grab a schema string.
const REFS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS catalog_refs (
        source_id   TEXT NOT NULL,
        target_ref  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        field       TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, target_ref, kind, field)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_catalog_refs_target ON catalog_refs(target_ref);
`

// Open a fresh in-memory database with the two-table schema. Each
// test gets its own DB so state doesn't bleed between tests.
function makeTestDb() {
    const db = createSqliteDatabase({
        runtimeFolder: '/tmp',
        version: 'test',
        config: { filename: ':memory:' },
        schemas: new Map([
            ['catalog_entities', CATALOG_SCHEMA],
            ['catalog_refs',     REFS_SCHEMA],
        ]),
    })
    db.open()
    return db
}

// Build a bare index over a fresh DB. Used by tests that exercise the
// index data structure (indexEntity, rebuild, outboundFor, etc.)
// without needing a subscriber rig.
function makeIdx() {
    return createIndex(makeTestDb())
}

// Build an index + subscribers harness over a fresh DB, pre-seeded
// with the provided entities. Mirrors what catalog.onPersist does in
// production (indexEntity per CREATE/UPDATE).
function makeRig(entities = []) {
    const db = makeTestDb()
    const byId = new Map(entities.map(e => [e.id, e]))
    const index = createIndex(db)
    for (const e of entities) index.indexEntity(e)
    const subs = createSubscribers(index, (id) => byId.get(id))
    return { index, subs, byId, db }
}

describe('createIndex', () => {
    it('starts empty', () => {
        const idx = makeIdx()
        assert.deepEqual(idx.allRefs(), [])
        assert.deepEqual(idx.size(), { refs: 0, sources: 0, edges: 0, dynamicSources: 0, dynamicEdges: 0 })
        assert.deepEqual(idx.inboundFor('/x'), [])
        assert.deepEqual(idx.outboundFor('/x'), [])
    })

    it('indexes top-level $-keyed refs', () => {
        const idx = makeIdx()
        idx.indexEntity({
            id: '/blog/launch.md',
            meta: {
                $author: '/authors/dick',
                $hero:   '/images/launch-hero',
                title:   'Launch',          // non-ref field — ignored
            },
        })

        const inboundAuthor = idx.inboundFor('/authors/dick')
        const inboundHero   = idx.inboundFor('/images/launch-hero')
        assert.deepEqual(inboundAuthor, [{ id: '/blog/launch.md', field: '$author' }])
        assert.deepEqual(inboundHero,   [{ id: '/blog/launch.md', field: '$hero' }])

        const outbound = idx.outboundFor('/blog/launch.md')
        assert.equal(outbound.length, 2)
        assert.ok(outbound.find(r => r.field === '$author' && r.ref === '/authors/dick'))
        assert.ok(outbound.find(r => r.field === '$hero'   && r.ref === '/images/launch-hero'))
    })

    it('indexes array-valued refs with index-bearing field paths', () => {
        const idx = makeIdx()
        idx.indexEntity({
            id: '/blog/post.md',
            meta: { $related: ['/blog/a', '/blog/b'] },
        })

        assert.deepEqual(idx.inboundFor('/blog/a'), [{ id: '/blog/post.md', field: '$related.0' }])
        assert.deepEqual(idx.inboundFor('/blog/b'), [{ id: '/blog/post.md', field: '$related.1' }])

        const outbound = idx.outboundFor('/blog/post.md')
        assert.equal(outbound.length, 2)
        assert.deepEqual(outbound.map(r => r.ref).sort(), ['/blog/a', '/blog/b'])
    })

    it('handles nested $-keys', () => {
        const idx = makeIdx()
        idx.indexEntity({
            id: '/landing.md',
            meta: {
                seo: { $ogImage: '/images/og' },
                sections: [
                    { $image: '/images/hero', kind: 'hero' },
                    { $image: '/images/feat', kind: 'feat' },
                ],
            },
        })

        assert.deepEqual(idx.inboundFor('/images/og'),
            [{ id: '/landing.md', field: 'seo.$ogImage' }])
        assert.deepEqual(idx.inboundFor('/images/hero'),
            [{ id: '/landing.md', field: 'sections.0.$image' }])
        assert.deepEqual(idx.inboundFor('/images/feat'),
            [{ id: '/landing.md', field: 'sections.1.$image' }])
    })

    it('aggregates multiple sources pointing at the same ref', () => {
        const idx = makeIdx()
        idx.indexEntity({ id: '/post-a.md', meta: { $author: '/authors/dick' } })
        idx.indexEntity({ id: '/post-b.md', meta: { $author: '/authors/dick' } })
        idx.indexEntity({ id: '/post-c.md', meta: { $author: '/authors/other' } })

        const dick = idx.inboundFor('/authors/dick')
        assert.equal(dick.length, 2)
        assert.deepEqual(dick.map(e => e.id).sort(), ['/post-a.md', '/post-b.md'])
    })

    it('aggregates multiple fields on one source pointing at the same ref', () => {
        const idx = makeIdx()
        idx.indexEntity({
            id: '/post.md',
            meta: { $author: '/authors/dick', $editor: '/authors/dick' },
        })

        const dick = idx.inboundFor('/authors/dick')
        assert.equal(dick.length, 2)
        assert.deepEqual(dick.map(e => e.field).sort(), ['$author', '$editor'])
    })

    it('rebuild() replaces the entire index atomically', () => {
        const idx = makeIdx()
        idx.indexEntity({ id: '/a.md', meta: { $author: '/authors/dick' } })
        assert.equal(idx.inboundFor('/authors/dick').length, 1)

        idx.rebuild([
            { id: '/b.md', meta: { $author: '/authors/other' } },
        ])

        assert.equal(idx.inboundFor('/authors/dick').length, 0)
        assert.equal(idx.inboundFor('/authors/other').length, 1)
        assert.deepEqual(idx.allRefs(), ['/authors/other'])
    })

    it('rebuild() with an empty list clears the index', () => {
        const idx = makeIdx()
        idx.indexEntity({ id: '/a.md', meta: { $author: '/x' } })
        idx.rebuild([])
        assert.deepEqual(idx.size(), { refs: 0, sources: 0, edges: 0, dynamicSources: 0, dynamicEdges: 0 })
    })

    it('size() counts refs, sources, and edges correctly', () => {
        const idx = makeIdx()
        idx.rebuild([
            { id: '/a.md', meta: { $x: '/t1', $y: '/t2' } },              // 2 edges from a
            { id: '/b.md', meta: { $x: '/t1' } },                          // 1 edge from b (same t1)
            { id: '/c.md', meta: { $z: ['/t3', '/t4'] } },                 // 2 edges from c
        ])

        const stats = idx.size()
        assert.equal(stats.refs,    4)      // t1, t2, t3, t4
        assert.equal(stats.sources, 3)      // a, b, c
        assert.equal(stats.edges,   5)      // a.x, a.y, b.x, c.z.0, c.z.1
    })

    it('outboundFor() returns a fresh copy (caller can mutate without breaking the index)', () => {
        const idx = makeIdx()
        idx.indexEntity({ id: '/a.md', meta: { $x: '/t1' } })

        const copy = idx.outboundFor('/a.md')
        copy.push({ field: '$y', ref: '/forged' })

        // The index should still show one outbound edge for /a.md.
        assert.equal(idx.outboundFor('/a.md').length, 1)
    })

    it('ignores entities with no id or no meta', () => {
        const idx = makeIdx()
        idx.indexEntity({ meta: { $x: '/t' } })                // no id
        idx.indexEntity({ id: '/a.md' })                       // no meta
        idx.indexEntity({ id: '/b.md', meta: null })           // null meta
        assert.deepEqual(idx.size(), { refs: 0, sources: 0, edges: 0, dynamicSources: 0, dynamicEdges: 0 })
    })

    it('ignores $-keys whose values are not strings or string arrays', () => {
        const idx = makeIdx()
        // extractRefs already filters out invalid shapes; this test
        // double-checks the index does not crash and produces no edges
        // for invalid entries.
        idx.indexEntity({
            id: '/a.md',
            meta: {
                $bad1: 42,
                $bad2: { nested: 'object' },
                $good: '/t',
            },
        })
        assert.deepEqual(idx.allRefs(), ['/t'])
        assert.equal(idx.inboundFor('/t').length, 1)
    })
})

describe('createSubscribers — dispatch', () => {
    it('fires onAffected when the mutated entity matches the subscriber filter directly (depth 0)', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick', title: 'Old' } }
        const { subs } = makeRig([
            article,
            { id: '/authors/dick', meta: { name: 'Dick' } },
        ])

        const calls = []
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],
            onAffected: ({ root, mutated }) => calls.push({ root: root.id, mutated: mutated.id }),
        })

        // The article itself mutated.
        await subs.dispatch([{ id: '/blog/launch', meta: { ...article.meta, title: 'New' } }])
        assert.deepEqual(calls, [{ root: '/blog/launch', mutated: '/blog/launch' }])
    })

    it('fires onAffected when a 1-hop dependency mutates', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author = { id: '/authors/dick', meta: { name: 'Dick' } }
        const { subs } = makeRig([article, author])

        const calls = []
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],
            onAffected: ({ root, mutated }) => calls.push({ root: root.id, mutated: mutated.id }),
        })

        await subs.dispatch([author])
        assert.deepEqual(calls, [{ root: '/blog/launch', mutated: '/authors/dick' }])
    })

    it('fires onAffected when a 2-hop dependency mutates (deeper expand)', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author  = { id: '/authors/dick', meta: { $organization: '/orgs/almero' } }
        const org     = { id: '/orgs/almero', meta: { name: 'Almero' } }
        const { subs } = makeRig([article, author, org])

        const calls = []
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author.organization'],
            onAffected: ({ root, mutated }) => calls.push({ root: root.id, mutated: mutated.id }),
        })

        await subs.dispatch([org])
        assert.deepEqual(calls, [{ root: '/blog/launch', mutated: '/orgs/almero' }])
    })

    it('does NOT fire onAffected for mutations beyond the subscriber\'s expand depth', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author  = { id: '/authors/dick', meta: { $organization: '/orgs/almero' } }
        const org     = { id: '/orgs/almero', meta: { name: 'Almero' } }
        const { subs } = makeRig([article, author, org])

        const calls = []
        // Subscriber only expands one hop. The org is at depth 2; it
        // shouldn't trigger this subscriber when it mutates.
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],
            onAffected: ({ root }) => calls.push({ root: root.id }),
        })

        await subs.dispatch([org])
        assert.deepEqual(calls, [])
    })

    it('does NOT fire onAffected for entities outside the filter', async () => {
        const articleA = { id: '/blog/launch-a', meta: { $author: '/authors/dick' } }
        const articleB = { id: '/blog/launch-b', meta: { $author: '/authors/dick' } }
        const author   = { id: '/authors/dick',   meta: { name: 'Dick' } }
        const { subs } = makeRig([articleA, articleB, author])

        const calls = []
        // Subscribe only to article B; an author update should fire
        // for B but not for A.
        subs.add({
            filter: e => e.id === '/blog/launch-b',
            expand: ['author'],
            onAffected: ({ root, mutated }) => calls.push({ root: root.id, mutated: mutated.id }),
        })

        await subs.dispatch([author])
        assert.deepEqual(calls, [{ root: '/blog/launch-b', mutated: '/authors/dick' }])
    })

    it('dispatches independently to multiple subscribers with overlapping coverage', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author  = { id: '/authors/dick', meta: { name: 'Dick' } }
        const { subs } = makeRig([article, author])

        const callsA = []
        const callsB = []
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],
            onAffected: ({ root }) => callsA.push(root.id),
        })
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],
            onAffected: ({ root }) => callsB.push(root.id),
        })

        await subs.dispatch([author])
        assert.deepEqual(callsA, ['/blog/launch'])
        assert.deepEqual(callsB, ['/blog/launch'])
    })

    it('dispose() removes a subscriber from future dispatch', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author  = { id: '/authors/dick', meta: { name: 'Dick' } }
        const { subs } = makeRig([article, author])

        const calls = []
        const { dispose } = subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],
            onAffected: ({ root }) => calls.push(root.id),
        })

        await subs.dispatch([author])
        assert.equal(calls.length, 1)

        dispose()
        await subs.dispatch([author])
        assert.equal(calls.length, 1)   // no additional dispatch
    })

    it('AbortSignal disposes the subscriber when aborted', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author  = { id: '/authors/dick', meta: { name: 'Dick' } }
        const { subs } = makeRig([article, author])

        const calls = []
        const ac = new AbortController()
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],
            signal: ac.signal,
            onAffected: ({ root }) => calls.push(root.id),
        })

        await subs.dispatch([author])
        assert.equal(calls.length, 1)

        ac.abort()
        await subs.dispatch([author])
        assert.equal(calls.length, 1)   // no additional dispatch
    })

    it('does not register a subscriber whose signal is already aborted', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author  = { id: '/authors/dick', meta: { name: 'Dick' } }
        const { subs } = makeRig([article, author])

        const calls = []
        const ac = new AbortController()
        ac.abort()
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],
            signal: ac.signal,
            onAffected: ({ root }) => calls.push(root.id),
        })

        await subs.dispatch([author])
        assert.equal(calls.length, 0)
    })

    it('breaks naturally on cycles in the inverse graph', async () => {
        // A references B, B references A. Both at depth ≤ 5 of either.
        const a = { id: '/a', meta: { $partner: '/b' } }
        const b = { id: '/b', meta: { $partner: '/a' } }
        const { subs } = makeRig([a, b])

        const calls = []
        // Sub on `a`, expand 3 hops. Inverse walk from a mutation
        // visits b (via inbound) and then a again (via b's inbound),
        // but `visited` dedupes — no infinite loop.
        subs.add({
            filter: e => e.id === '/a',
            expand: ['partner.partner.partner'],
            onAffected: ({ root, mutated }) => calls.push({ root: root.id, mutated: mutated.id }),
        })

        await subs.dispatch([a])
        // depth-0 visit of /a itself fires once.
        assert.deepEqual(calls, [{ root: '/a', mutated: '/a' }])

        const callsB = []
        subs.add({
            filter: e => e.id === '/a',
            expand: ['partner.partner.partner'],
            onAffected: ({ root, mutated }) => callsB.push({ root: root.id, mutated: mutated.id }),
        })
        await subs.dispatch([b])
        // Mutation of /b → inverse walks to /a (depth 1), fires for both subs.
        assert.equal(calls.length, 2)
        assert.equal(callsB.length, 1)
    })

    it('handles multiple mutations in one dispatch call', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick', $hero: '/images/hero' } }
        const author  = { id: '/authors/dick', meta: { name: 'Dick' } }
        const hero    = { id: '/images/hero',  meta: { alt: 'Hero' } }
        const { subs } = makeRig([article, author, hero])

        const calls = []
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author', 'hero'],
            onAffected: ({ mutated }) => calls.push(mutated.id),
        })

        await subs.dispatch([author, hero])
        assert.deepEqual(calls.sort(), ['/authors/dick', '/images/hero'])
    })

    it('uses different reach depths for subscribers with different expand specs', async () => {
        const article = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author  = { id: '/authors/dick', meta: { $organization: '/orgs/almero' } }
        const org     = { id: '/orgs/almero', meta: { name: 'Almero' } }
        const { subs } = makeRig([article, author, org])

        const shallowCalls = []
        const deepCalls = []
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author'],                       // depth 1
            onAffected: ({ root, mutated }) => shallowCalls.push({ root: root.id, mutated: mutated.id }),
        })
        subs.add({
            filter: e => e.id === '/blog/launch',
            expand: ['author.organization'],           // depth 2
            onAffected: ({ root, mutated }) => deepCalls.push({ root: root.id, mutated: mutated.id }),
        })

        await subs.dispatch([org])
        // Only the deep subscriber sees the org mutation; the shallow
        // one stops walking at depth 1.
        assert.equal(shallowCalls.length, 0)
        assert.deepEqual(deepCalls, [{ root: '/blog/launch', mutated: '/orgs/almero' }])
    })

    it('inverseReach returns just the start at depth 0', () => {
        const { subs } = makeRig([
            { id: '/a', meta: { $b: '/b' } },
            { id: '/b', meta: {} },
        ])
        const reached = subs.inverseReach({ id: '/b', meta: {} }, 0)
        assert.deepEqual([...reached.keys()], ['/b'])
        assert.equal(reached.get('/b'), 0)
    })

    it('inverseReach walks up multiple levels of $-key referrers and records hop counts', () => {
        const a = { id: '/a', meta: { $b: '/b' } }
        const b = { id: '/b', meta: { $c: '/c' } }
        const c = { id: '/c', meta: {} }
        const { subs } = makeRig([a, b, c])

        const reached = subs.inverseReach(c, 2)
        // From /c: hop 0 = /c, hop 1 = /b, hop 2 = /a.
        assert.deepEqual([...reached.keys()].sort(), ['/a', '/b', '/c'])
        assert.equal(reached.get('/c'), 0)
        assert.equal(reached.get('/b'), 1)
        assert.equal(reached.get('/a'), 2)
    })

    it('inverseReach matches when the source wrote a ref using meta.href', () => {
        // Author wrote $author: /authors/dick in the article, while
        // the author entity's id is /authors/dick.yml. The matcher
        // should still find the article from the author via the
        // author's meta.href.
        const article = { id: '/blog/launch.md', meta: { $author: '/authors/dick' } }
        const author  = { id: '/authors/dick.yml', meta: { href: '/authors/dick' } }
        const { subs } = makeRig([article, author])

        const reached = subs.inverseReach(author, 1)
        assert.deepEqual([...reached.keys()].sort(), ['/authors/dick.yml', '/blog/launch.md'])
    })

    it('dispatch is a no-op with no subscribers or no mutations', async () => {
        const { subs } = makeRig([
            { id: '/a', meta: { $b: '/b' } },
            { id: '/b', meta: {} },
        ])

        // No subscribers: doesn't throw.
        await subs.dispatch([{ id: '/a', meta: {} }])

        // No mutations: doesn't throw.
        const calls = []
        subs.add({ filter: () => true, expand: [], onAffected: () => calls.push(1) })
        await subs.dispatch([])
        assert.deepEqual(calls, [])
    })

    it('continues dispatching to other subscribers after one throws', async () => {
        const { subs } = makeRig([
            { id: '/a', meta: { $b: '/b' } },
            { id: '/b', meta: {} },
        ])

        const calls = []
        subs.add({
            filter: () => true,
            expand: ['b'],
            onAffected: () => { throw new Error('boom') },
        })
        subs.add({
            filter: () => true,
            expand: ['b'],
            // Push the ROOT id (the entity matching the filter at this
            // visit), not mutated.id, so we can verify the dispatch
            // reached every visited node.
            onAffected: ({ root }) => calls.push(root.id),
        })

        await subs.dispatch([{ id: '/b', meta: {} }])
        // Inverse walk visits /b (depth 0) and /a (depth 1). The
        // healthy subscriber pushes the root id for each.
        assert.ok(calls.includes('/b'), `expected /b in calls, got: ${JSON.stringify(calls)}`)
        assert.ok(calls.includes('/a'), `expected /a in calls, got: ${JSON.stringify(calls)}`)
    })
})

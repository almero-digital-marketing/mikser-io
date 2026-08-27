// refs_inbound has to answer "what breaks if I delete this".
//
// The index holds `$`-keyed refs only, because those are what the engine
// resolves and invalidates on. But a site links to a page far more often
// with a plain string — `items: [{ label, href: '/about' }]` in a nav or a
// footer — so the honest answer to that question was `count: 0` while two
// live pages linked to the target. For a question asked before deleting
// something, a silent miss is worse than no answer.
//
// Plain values are matched at READ time with json_tree over each entity's
// meta: indexing every string in every meta would put the whole catalog in
// the edge table to serve a diagnostic, and the engine does not invalidate
// on plain strings anyway — which is why the two kinds stay labelled rather
// than merged.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createIndex, REFS_SCHEMA } from '../../src/refs.js'
import { createSqliteDatabase } from '../../src/database/index.js'

const CATALOG_SCHEMA = `
    CREATE TABLE IF NOT EXISTS mikser_entities (
        id        TEXT PRIMARY KEY,
        meta_href TEXT,
        meta_url  TEXT,
        data      TEXT NOT NULL
    ) WITHOUT ROWID;
`

// The motivating shape: a nav and a footer both linking to /about with a
// plain href, one of them nested two levels inside arrays.
const ENTITIES = [
    { id: '/documents/bg/system/navigation.yml', meta: { href: '/system/navigation', items: [
        { label: 'Начало', href: '/' }, { label: 'За нас', href: '/about' }] } },
    { id: '/documents/bg/system/footer.yml', meta: { href: '/system/footer', columns: [
        { links: [{ label: 'За нас', href: '/about' }] }] } },
    { id: '/documents/bg/about.md', meta: { href: '/about' } },
    { id: '/documents/bg/post.md', meta: { $author: '/authors/dick' } },
]

describe('inboundFor: plain hrefs as well as $-refs', () => {
    let db, index
    before(() => {
        db = createSqliteDatabase({
            runtimeFolder: '/tmp', version: 'test', config: { filename: ':memory:' },
            schemas: new Map([['mikser_entities', CATALOG_SCHEMA], ['mikser_refs', REFS_SCHEMA]]),
        })
        db.open()
        index = createIndex(db)
        const insert = db.prepare(
            'INSERT INTO mikser_entities (id, meta_href, meta_url, data) VALUES (?, ?, ?, ?)')
        for (const e of ENTITIES) {
            insert.run(e.id, e.meta?.href ?? null, e.meta?.url ?? null, JSON.stringify(e))
            index.indexEntity(e)
        }
    })
    after(() => db?.close?.())

    it('finds a plain href in a nav item list', () => {
        const hit = index.inboundFor('/about')
            .find(e => e.id === '/documents/bg/system/navigation.yml')
        assert.ok(hit, 'the nav links to /about and must be reported')
        assert.equal(hit.kind, 'href')
        assert.equal(hit.field, 'items[1].href', 'names which item')
    })

    it('finds a second copy nested deeper, in the footer', () => {
        // Found by accident in the session this comes from. One call has to
        // surface every copy or the next edit misses one.
        const hit = index.inboundFor('/about')
            .find(e => e.id === '/documents/bg/system/footer.yml')
        assert.ok(hit)
        assert.equal(hit.field, 'columns[0].links[0].href')
    })

    it('does not report the target itself as a referrer', () => {
        // about.md declares `href: /about` — that is its own address, not a
        // link to itself, and listing it among "what breaks if I delete this"
        // is noise at best.
        const ids = index.inboundFor('/about').map(e => e.id)
        assert.ok(!ids.includes('/documents/bg/about.md'))
    })

    it('still reports $-keyed refs, tagged as such', () => {
        const entries = index.inboundFor('/authors/dick')
        assert.equal(entries.length, 1)
        assert.deepEqual(entries[0], { id: '/documents/bg/post.md', field: '$author', kind: 'ref' })
    })

    it('does not double-report a $-ref as a plain match', () => {
        // json_tree sees the $-keyed value too, and spells the key
        // `"$author"` (quoted) where the index spells it `$author` — so the
        // dedup only works after unquoting.
        const entries = index.inboundFor('/authors/dick')
        assert.equal(entries.filter(e => e.kind === 'href').length, 0)
    })

    it('returns nothing for a value nobody references', () => {
        assert.deepEqual(index.inboundFor('/nowhere'), [])
    })
})

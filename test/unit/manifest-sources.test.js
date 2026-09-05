// The reverse direction: "what produced this?"
//
// Snapshots answer "what did this entity produce". sourcesBehind answers the
// opposite, and it belongs in the engine because the refClosure IS the
// engine's record of what a render consumed — which is what makes the answer
// authoritative rather than a guess about which file might hold something.
//
// It lived in mikser-io-mcp until it moved here, which meant the engine could
// not answer the question on its own and no non-MCP consumer could ask it.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { sourcesBehind, sourcesOf, createManifest, SNAPSHOTS_SCHEMA, FAILURES_SCHEMA } from '../../src/manifest/index.js'
import { createSqliteDatabase } from '../../src/database/index.js'

const ENTITIES = [
    { id: '/styles/tokens/buttons.css', collection: 'styles' },
    { id: '/styles/sections/panel.css', collection: 'styles' },
    { id: '/documents/bg/about.md', collection: 'documents' },
]

beforeEach(() => {
    runtime.catalog = {
        byId: new Map(ENTITIES.map(e => [e.id, e])),
        findEntities: async (query) =>
            (query?.collection ? ENTITIES.filter(e => e.collection === query.collection) : ENTITIES),
    }
    delete runtime.manifest
})

const ids = (sources) => sources.map(s => s.id).sort()
const viaOf = (sources, id) => sources.find(s => s.id === id)?.via

describe('sourcesBehind', () => {
    it('always includes the entity that renders there', async () => {
        const sources = await sourcesBehind({ id: '/documents/bg/about.md', destination: '/bg/about/index.html' })
        assert.deepEqual(ids(sources), ['/documents/bg/about.md'])
        assert.deepEqual(viaOf(sources, '/documents/bg/about.md'), ['renders to this destination'])
    })

    it('resolves a recorded query to the members that went in', async () => {
        // The case this exists for: a bundle assembled from
        // findEntities({collection:'styles'}). The built file names no source
        // and the sources name no destination; only the recorded query joins
        // them.
        const sources = await sourcesBehind({
            id: '/documents/bg/styles.yml',
            refClosure: [{ kind: 'query', filter: { collection: 'styles' } }],
        })
        assert.deepEqual(ids(sources),
            ['/documents/bg/styles.yml', '/styles/sections/panel.css', '/styles/tokens/buttons.css'])
        assert.deepEqual(viaOf(sources, '/styles/tokens/buttons.css'), ['query {"collection":"styles"}'])
    })

    it('claims nothing for a query whose filter could not be serialized', async () => {
        // A null filter invalidates on ANY mutation, which is not the same as
        // "every entity fed this render". Naming the whole catalog would be a
        // confidently wrong answer.
        const sources = await sourcesBehind({
            id: '/documents/x.md',
            refClosure: [{ kind: 'query', filter: null }],
        })
        assert.deepEqual(ids(sources), ['/documents/x.md'])
    })

    it('follows a resolved edge to what it bound to, tagged by kind', async () => {
        const sources = await sourcesBehind({
            id: '/documents/bg/about.md',
            refClosure: [
                { kind: 'layout',  target: 'page', targetId: '/layouts/page.hbs' },
                { kind: 'partial', target: 'nav',  targetId: '/layouts/nav.hbs' },
            ],
        })
        assert.deepEqual(viaOf(sources, '/layouts/page.hbs'), ['layout'])
        assert.deepEqual(viaOf(sources, '/layouts/nav.hbs'), ['partial'])
    })

    it('follows every binding when a name resolved to several', async () => {
        // A meta.href shared by language variants resolves to more than one.
        const sources = await sourcesBehind({
            id: '/documents/bg/x.md',
            refClosure: [{ kind: 'ref', target: '/about', targetIds: ['/documents/bg/about.md', '/documents/en/about.md'] }],
        })
        assert.ok(ids(sources).includes('/documents/en/about.md'))
    })

    it('still names an edge that resolved to nothing', async () => {
        // A forward reference to a page that does not exist yet is a real
        // answer to "what feeds this", and dropping it hides why a link breaks.
        const sources = await sourcesBehind({
            id: '/documents/bg/x.md',
            refClosure: [{ kind: 'ref', target: '/not-yet-written' }],
        })
        assert.deepEqual(viaOf(sources, '/not-yet-written'), ['ref (unresolved)'])
    })

    it('accumulates every route to one source rather than the first found', async () => {
        // An entity can reach a render more than one way — a layout that is
        // also a $-ref target. Collapsing to the first quietly answers a
        // different question.
        const sources = await sourcesBehind({
            id: '/documents/bg/x.md',
            refClosure: [
                { kind: 'layout', target: 'page', targetId: '/layouts/page.hbs' },
                { kind: 'ref',    target: 'page', targetId: '/layouts/page.hbs' },
            ],
        })
        assert.deepEqual(viaOf(sources, '/layouts/page.hbs'), ['layout', 'ref'])
    })

    it('returns nothing for no snapshot, rather than throwing', async () => {
        assert.deepEqual(await sourcesBehind(null), [])
        assert.deepEqual(await sourcesBehind(undefined), [])
    })
})

describe('sourcesOf — by destination, which is what a caller actually holds', () => {
    function manifestWith(snapshots) {
        const db = createSqliteDatabase({
            runtimeFolder: '/tmp', version: 'test', config: { filename: ':memory:' },
            schemas: new Map([['mikser_snapshots', SNAPSHOTS_SCHEMA], ['mikser_failures', FAILURES_SCHEMA]]),
        })
        db.open()
        const m = createManifest(db)
        for (const { entity, deps } of snapshots) m.record(entity, deps)
        runtime.manifest = m
        return m
    }

    it('unions the sources of every entity claiming the destination', async () => {
        // More than one claimant is a collision. Reporting one arbitrary
        // winner would hide the other half of what is actually going on.
        manifestWith([
            { entity: { id: '/documents/bg/index.md',  destination: '/bg/index.html', meta: {} },
              deps: [{ kind: 'layout', target: 'stub', targetId: '/layouts/stub.hbs' }] },
            { entity: { id: '/documents/bg/index.yml', destination: '/bg/index.html', meta: {} },
              deps: [{ kind: 'layout', target: 'page', targetId: '/layouts/page.hbs' }] },
        ])
        const sources = await sourcesOf('/bg/index.html')
        assert.deepEqual(ids(sources), [
            '/documents/bg/index.md', '/documents/bg/index.yml',
            '/layouts/page.hbs', '/layouts/stub.hbs',
        ])
    })

    it('merges the routes when two claimants share a source', async () => {
        manifestWith([
            { entity: { id: '/documents/a.md', destination: '/x.html', meta: {} },
              deps: [{ kind: 'layout', target: 'page', targetId: '/layouts/page.hbs' }] },
            { entity: { id: '/documents/b.md', destination: '/x.html', meta: {} },
              deps: [{ kind: 'partial', target: 'page', targetId: '/layouts/page.hbs' }] },
        ])
        const sources = await sourcesOf('/x.html')
        assert.deepEqual(viaOf(sources, '/layouts/page.hbs').sort(), ['layout', 'partial'])
    })

    it('is empty for a destination no render claims', async () => {
        manifestWith([])
        assert.deepEqual(await sourcesOf('/nothing/here.html'), [])
    })
})

// The observer plugin pulls entities from an external API and keeps the
// catalog in step with it: create what is new, update what changed, remove
// what the source no longer has.
//
// It had no tests at all, and the delete path was broken.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { observer } from '../../../src/plugins/observer.js'
import { createHarness } from '../plugin-harness.js'

const URI = 'https://api.example.com/items'

function setup({ entities = [], findEntities, ...observers } = {}) {
    const h = createHarness({ entities })
    const core = findEntities ? { ...h.core, findEntities } : h.core
    observer(observers)(core)
    return h
}

const items = (...metas) => async () => metas
const ops = (h) => h.journal.map(e => [e.operation, e.entity.id])

describe('observer plugin', () => {
    it('creates an entity for each record the source returns', async () => {
        const h = setup({ things: { uri: URI, readMany: items({ id: 1, name: 'one' }, { id: 2, name: 'two' }) } })
        await h.runHook('import')
        assert.deepEqual(ops(h), [
            ['create', '/observer/things/1'],
            ['create', '/observer/things/2'],
        ])
    })

    it('derives the entity from the record', async () => {
        const h = setup({ things: { uri: URI, readMany: items({ id: 7, name: 'seven' }) } })
        await h.runHook('import')
        const { entity } = h.journal.at(-1)
        assert.equal(entity.uri, `${URI}/7`, 'addressable back at the source')
        assert.equal(entity.collection, 'things')
        assert.equal(entity.format, 'observer')
        assert.equal(entity.meta.name, 'seven')
        assert.ok(entity.checksum, 'checksummed, or nothing can tell an unchanged record from a changed one')
    })

    it('writes nothing when the record has not changed', async () => {
        // The checksum is the whole point: an hourly cron over a thousand
        // records must not produce a thousand updates every hour.
        const first = createHarness({})
        observer({ things: { uri: URI, readMany: items({ id: 1, name: 'one' }) } })(first.core)
        await first.runHook('import')
        const created = first.journal.at(-1).entity

        const h = setup({ entities: [created], things: { uri: URI, readMany: items({ id: 1, name: 'one' }) } })
        await h.runHook('import')
        assert.deepEqual(ops(h), [], 'an unchanged record is not rewritten')
    })

    it('updates when the record actually changed', async () => {
        const first = createHarness({})
        observer({ things: { uri: URI, readMany: items({ id: 1, name: 'one' }) } })(first.core)
        await first.runHook('import')
        const created = first.journal.at(-1).entity

        const h = setup({ entities: [created], things: { uri: URI, readMany: items({ id: 1, name: 'renamed' }) } })
        await h.runHook('import')
        assert.deepEqual(ops(h), [['update', '/observer/things/1']])
    })

    it('refuses a duplicate id rather than writing it twice', async () => {
        const h = setup({ things: { uri: URI, readMany: items({ id: 1, name: 'one' }, { id: 1, name: 'again' }) } })
        await h.runHook('import')
        assert.deepEqual(ops(h), [['create', '/observer/things/1']], 'the second is dropped')
        assert.ok(h.logs.some(l => l.level === 'error'), 'and said out loud — a colliding id is a source bug')
    })

    it('removes entities the source no longer has', async () => {
        // Otherwise a record deleted upstream lives in the catalog forever
        // and keeps rendering.
        const stale = { id: '/observer/things/99', collection: 'things', type: 'document', format: 'observer' }
        const h = setup({
            findEntities: async () => [stale],
            things: { uri: URI, readMany: items({ id: 1, name: 'one' }) },
        })
        await h.runHook('import')
        assert.ok(ops(h).some(([op, id]) => op === 'delete' && id === '/observer/things/99'))
    })

    it('reports a source that throws instead of failing the build', async () => {
        const h = setup({ things: { uri: URI, readMany: async () => { throw new Error('upstream 503') } } })
        await h.runHook('import')
        assert.deepEqual(ops(h), [])
        assert.ok(h.logs.some(l => l.level === 'error' && /503/.test(JSON.stringify(l))))
    })
})

describe('syncing one record by id', () => {
    // The webhook path: the source says "item 5 changed", mikser fetches
    // just that one.
    const single = (meta) => ({ uri: URI, readOne: async () => meta, readMany: items() })

    it('creates it when it is new', async () => {
        const h = setup({ things: single({ id: 5, name: 'five' }) })
        await h.runHook('loaded')
        await h.runSync('things', { context: { id: 5 } })
        assert.deepEqual(ops(h), [['create', '/observer/things/5']])
    })

    it('deletes it when the source no longer has it', async () => {
        // This did not work. `entity` is declared inside the branch that
        // builds it, so the delete branch referenced a name that was not in
        // scope — a ReferenceError, swallowed by the surrounding try/catch
        // into one log line. The record vanished upstream and stayed in the
        // catalog, rendering, forever.
        const existing = { id: '/observer/things/5', collection: 'things', type: 'document', format: 'observer' }
        const h = setup({ entities: [existing], things: { uri: URI, readOne: async () => null, readMany: items() } })
        await h.runHook('loaded')
        await h.runSync('things', { context: { id: 5 } })
        assert.deepEqual(ops(h), [['delete', '/observer/things/5']])
    })

    it('does nothing when it never existed and the source has nothing', async () => {
        const h = setup({ things: { uri: URI, readOne: async () => null, readMany: items() } })
        await h.runHook('loaded')
        await h.runSync('things', { context: { id: 5 } })
        assert.deepEqual(ops(h), [])
    })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { json } from '../../../src/plugins/json.js'
import { createHarness } from '../plugin-harness.js'

function setup(journal) {
    const h = createHarness({ journal })
    json()(h.core)
    return h
}

describe('json plugin', () => {
    it('registers a single onProcess hook', () => {
        const h = setup([])
        assert.equal(h.hooks.process.length, 1)
    })

    it('parses entities with format=json and drops content', async () => {
        const entity = { id: '/data/site.json', format: 'json', content: '{"title":"Hi","n":3}' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.deepEqual(entity.meta, { title: 'Hi', n: 3 })
        assert.equal(entity.content, undefined)
    })

    it('skips other formats', async () => {
        const entity = { id: '/data/site.yml', format: 'yml', content: 'x: 1' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.equal(entity.meta, undefined)
    })

    it('merges into existing meta', async () => {
        const entity = { id: '/data/x.json', format: 'json', meta: { keep: 1 }, content: '{"add":2}' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.deepEqual(entity.meta, { keep: 1, add: 2 })
    })

    it('throws on invalid JSON (unlike yaml plugin, json plugin does not catch)', async () => {
        const entity = { id: '/bad.json', format: 'json', content: '{not valid' }
        const h = setup([{ entity, operation: 'create' }])
        await assert.rejects(() => h.runHook('process'), SyntaxError)
    })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { yaml } from '../../../src/plugins/yaml.js'
import { createHarness } from '../plugin-harness.js'

function setup(journal) {
    const h = createHarness({ journal })
    yaml()(h.core)
    return h
}

describe('yaml plugin', () => {
    it('registers a single onProcess hook', () => {
        const h = setup([])
        assert.equal(h.hooks.process.length, 1)
    })

    it('parses entities with format=yml and drops content', async () => {
        const entity = { id: '/data/site.yml', format: 'yml', content: 'title: Hello\nlang: en' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.deepEqual(entity.meta, { title: 'Hello', lang: 'en' })
        assert.equal(entity.content, undefined)
    })

    it('parses entities with format=yaml too', async () => {
        const entity = { id: '/data/site.yaml', format: 'yaml', content: 'foo: 1' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.deepEqual(entity.meta, { foo: 1 })
    })

    it('skips other formats', async () => {
        const entity = { id: '/data/site.json', format: 'json', content: '{"x": 1}' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.equal(entity.meta, undefined)
        assert.equal(entity.content, '{"x": 1}')
    })

    it('merges into existing meta', async () => {
        const entity = { id: '/data/x.yml', format: 'yml', meta: { keep: true }, content: 'add: 1' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.deepEqual(entity.meta, { keep: true, add: 1 })
    })

    it('logs an error on invalid YAML, leaves entity intact', async () => {
        const entity = { id: '/bad.yml', format: 'yml', content: ':\nthis: is: invalid' }
        const h = setup([{ entity, operation: 'create' }])
        await h.runHook('process')
        assert.equal(entity.content, ':\nthis: is: invalid')
        const errLogs = h.logs.filter(l => l.level === 'error')
        assert.equal(errLogs.length, 1)
        assert.match(errLogs[0].args[0], /Yaml error/)
    })
})

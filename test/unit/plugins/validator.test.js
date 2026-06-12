import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { validator } from '../../../src/plugins/validator.js'
import { createHarness } from '../plugin-harness.js'

function setup(validators) {
    const h = createHarness()
    validator({ validators })(h.core)
    return h
}

describe('validator plugin', () => {
    it('registers a single onLoad hook', () => {
        const h = setup([])
        assert.equal(h.hooks.load.length, 1)
    })

    it('registers an onValidate callback per configured validator', async () => {
        const h = setup([
            { match: { collection: 'documents' }, validate: () => true },
            { match: { collection: 'layouts' }, validate: () => true },
        ])
        await h.runHook('load')
        assert.equal(h.hooks.validate.length, 2)
    })

    it('calls validate() only for entries whose entity matches and has meta', async () => {
        let called = 0
        const h = setup([
            {
                match: { collection: 'documents' },
                validate: async (entity) => { called++; return true },
            },
        ])
        await h.runHook('load')
        const { cb } = h.hooks.validate[0]

        // Wrong collection: skipped
        assert.equal(await cb({ entity: { collection: 'layouts', meta: { x: 1 } } }), undefined)
        assert.equal(called, 0)

        // No meta: skipped
        assert.equal(await cb({ entity: { collection: 'documents' } }), undefined)
        assert.equal(called, 0)

        // Match + meta: called
        const result = await cb({ entity: { collection: 'documents', meta: { x: 1 } } })
        assert.equal(result, true)
        assert.equal(called, 1)
    })

    it('default operations are CREATE and UPDATE', async () => {
        const h = setup([{ match: () => true, validate: () => true }])
        await h.runHook('load')
        assert.deepEqual(h.hooks.validate[0].operations, ['create', 'update'])
    })

    it('honors a custom operations list', async () => {
        const h = setup([{ match: () => true, operations: ['delete'], validate: () => true }])
        await h.runHook('load')
        assert.deepEqual(h.hooks.validate[0].operations, ['delete'])
    })
})

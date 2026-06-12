import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resources } from '../../../src/plugins/resources.js'
import { createHarness } from '../plugin-harness.js'

describe('resources plugin', () => {
    it('loads without throwing when no resources config is present', () => {
        const h = createHarness()
        assert.doesNotThrow(() => resources()(h.core))
    })

    it('registers onLoaded, onProcessed, onFinalize', () => {
        const h = createHarness()
        resources()(h.core)
        assert.ok(h.hooks.loaded.length >= 1)
        assert.ok(h.hooks.processed.length >= 1)
        assert.ok(h.hooks.finalize.length >= 1)
    })
})

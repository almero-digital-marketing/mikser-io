import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { commands } from '../../../src/plugins/commands.js'
import { createHarness } from '../plugin-harness.js'

describe('commands plugin', () => {
    it('registers a callback for every supported lifecycle hook', () => {
        const h = createHarness()
        commands()(h.core)
        const expected = [
            'load', 'loaded', 'import', 'imported',
            'process', 'processed', 'persist', 'persisted',
            'beforeRender', 'render', 'afterRender',
            'cancel', 'cancelled', 'finalize', 'finalized',
        ]
        for (const name of expected) {
            assert.equal(h.hooks[name].length, 1, `expected one ${name} hook`)
        }
    })

    it('exposes executeCommand on the returned api', () => {
        const h = createHarness()
        const api = commands()(h.core)
        assert.equal(typeof api.executeCommand, 'function')
    })

    it('is a no-op when no commands are configured for the hook', async () => {
        const h = createHarness()
        commands()(h.core)
        // load hook fires executeCommands('load') with no entries — should resolve
        await assert.doesNotReject(() => h.runHook('load'))
    })
})

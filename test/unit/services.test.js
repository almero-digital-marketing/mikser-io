// A plugin offers something; another plugin asks core for it.
//
// The point is what is NOT here: neither side names the other, neither
// imports the other, and neither cares where the other sits in the plugins
// array.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    provideService, useService, requireService, resetServices, serviceInventory,
} from '../../src/services.js'

beforeEach(() => resetServices())

describe('a service one plugin provides', () => {
    it('reaches a consumer that never named the provider', () => {
        provideService('layouts', { inspect: () => 'looked' }, { plugin: 'mikser-io-layouts' })
        assert.equal(useService('layouts').inspect(), 'looked')
    })

    it('is undefined when nothing provides it, so a consumer can degrade', () => {
        // The consumer's `if (!layouts) return` has to mean "not installed",
        // not "threw somewhere".
        assert.equal(useService('layouts'), undefined)
    })

    it('names the package to install when the caller cannot do without it', () => {
        assert.throws(() => requireService('schemas', { from: 'mikser-io-schemas' }),
            /Install mikser-io-schemas/)
    })

    it('refuses a second provider instead of silently preferring one', () => {
        // Last-write-wins would hand consumers whichever plugin happened to
        // be constructed later — the order dependence this replaces.
        provideService('schemas', { lookup: () => 'first' }, { plugin: 'plugin-a' })
        assert.throws(() => provideService('schemas', { lookup: () => 'second' }, { plugin: 'plugin-b' }),
            /already provided by plugin-a/)
        assert.equal(useService('schemas').lookup(), 'first')
    })
})

describe('what is registered', () => {
    it('answers which plugin provides what', () => {
        provideService('preview', { get: () => {} }, { plugin: 'mikser-io' })
        provideService('layouts', { inspect: () => {} }, { plugin: 'mikser-io-layouts' })
        assert.deepEqual(serviceInventory(), [
            { name: 'preview', plugin: 'mikser-io' },
            { name: 'layouts', plugin: 'mikser-io-layouts' },
        ])
    })

    it('is emptied by a reset, so one run does not leak into the next', () => {
        // A watcher re-reads its config in the same process, which re-runs
        // every factory. Without this, the second load collides with the
        // copy of itself the first one registered.
        provideService('preview', { get: () => {} })
        resetServices()
        assert.equal(useService('preview'), undefined)
    })
})

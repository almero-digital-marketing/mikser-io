// A reload must rebuild the loaded-plugin list, not add to it.
//
// The load phase runs again in the same process whenever a watcher re-reads
// its config — plugins.js already clears the service registry there for the
// same reason, or a provider would collide with the copy of itself it
// registered last time. `runtime.plugins` is the same kind of module state:
// appended to on every load it would report each plugin once per reload, so a
// long watch session would show a site running twenty copies of layouts.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness } from '../../testing/harness.js'
import runtime from '../../src/runtime.js'

// Whatever the import registers is what the import registered — the same
// diffing plugins.js uses to attribute hooks. plugins.js adds three load
// hooks; only the one that dispatches factories is under test, and the others
// want more of the engine than a unit provides, so their failure is ignored
// and the assertion is on what the dispatcher produced.
const registeredBefore = runtime.hooks.load.length
await import('../../src/plugins.js')
const loadHooks = runtime.hooks.load.slice(registeredBefore)

const declaring = () => () => ({ module: import.meta.url })
const silent = () => () => {}

let priorOptions, priorConfig, priorEngine
before(() => {
    priorOptions = runtime.options
    priorConfig = runtime.config
    priorEngine = runtime.engine
    const harness = createHarness({ options: { workingFolder: process.cwd() } })
    runtime.engine = { logger: harness.logger }
    runtime.config = { plugins: [] }
})
after(() => {
    runtime.options = priorOptions
    runtime.config = priorConfig
    runtime.engine = priorEngine
})

// One pass of the load phase, as a watcher's config re-read would run it.
async function load() {
    runtime.options = { ...runtime.options, plugins: [declaring(), silent()] }
    for (const hook of loadHooks) {
        try { await hook() } catch { /* needs more engine than this unit builds */ }
    }
}

describe('loading twice', () => {
    it('reports each plugin once, not once per load', async () => {
        await load()
        assert.equal(runtime.plugins?.length, 2,
            `the dispatcher did not run\n${JSON.stringify(runtime.plugins)}`)

        await load()
        assert.equal(runtime.plugins.length, 2,
            `a reload must replace the list, not append to it\n${JSON.stringify(runtime.plugins, null, 2)}`)
    })

    it('still names the plugin that declared, and admits the one that did not', () => {
        const packages = runtime.plugins.map(p => p.package)
        assert.ok(packages.includes('mikser-io'), `the declaring plugin is named: ${packages}`)
        assert.ok(packages.includes(null), `the silent one is listed, unnamed: ${packages}`)
    })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
    assetUrlHelper, hrefUrlHelpers, resourceUrlHelper, fileHelpers,
    renderHbs, renderPreset,
} from '../../index.js'

// The `render` prefix was doing two jobs. Two of the six factories in
// src/plugins/render really are renderers — they have a render() and turn an
// entity into a file. The other four only install helpers on `runtime` for
// templates to call. Naming all six after the object they concern rather than
// the job they do led someone to add renderPreset() expecting a template
// helper and watch every page render throw: the inference was wrong and
// entirely reasonable.
describe('helper factories are named for their role', () => {
    const helpers = [
        ['assetUrlHelper', assetUrlHelper, 'asset'],
        ['hrefUrlHelpers', hrefUrlHelpers, 'href'],
        ['resourceUrlHelper', resourceUrlHelper, 'resource'],
        ['fileHelpers', fileHelpers, 'file'],
    ]

    for (const [name, factory] of helpers) {
        it(`${name} installs helpers and renders nothing`, () => {
            const descriptor = factory({})
            assert.equal(typeof descriptor.load, 'function')
            assert.equal(descriptor.render, undefined,
                         'a helper factory must not have render() — that is the whole distinction')
        })
    }

    it('the two real renderers keep their names and DO have render()', () => {
        // Renaming these would have been the mistake the exercise is about.
        assert.equal(typeof renderHbs({}).render, 'function')
        assert.equal(typeof renderPreset({}).render, 'function')
    })
})

describe('the old names are gone', () => {
    // Closed beta, so a clean break rather than aliases that linger. An alias
    // kept "for safety" is how two names for one thing become permanent.
    const removed = ['renderAsset', 'renderHref', 'renderResource', 'renderFile']

    it('are not exported', async () => {
        const mod = await import('../../index.js')
        for (const name of removed) {
            assert.equal(mod[name], undefined, `${name} must not be exported`)
        }
    })

    it('leave no deprecation shim behind', async () => {
        // The shim existed for one commit. If it comes back, so does the
        // ambiguity it was meant to smooth over.
        await assert.rejects(
            () => import('../../src/plugins/render/deprecated.js'),
            /Cannot find module|ERR_MODULE_NOT_FOUND/,
        )
    })

    it('are not referenced by the engine any more', async () => {
        const index = await readFile(new URL('../../index.js', import.meta.url), 'utf8')
        for (const name of removed) {
            assert.ok(!new RegExp(`\\b${name}\\b`).test(index), `${name} still in index.js`)
        }
    })
})

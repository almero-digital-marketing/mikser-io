import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
    hrefUrlHelpers, resourceUrlHelper, fileHelpers, renderHbs,
} from '../../index.js'

// The `render` prefix was doing two jobs. One of the four factories left in
// src/plugins/render really is a renderer — it has a render() and turns an
// entity into a file. The other three only install helpers on `runtime` for
// templates to call. Naming them after the object they concern rather than
// the job they do led someone to add a renderer expecting a template helper
// and watch every page render throw: the inference was wrong and entirely
// reasonable.
//
// assetUrlHelper and renderPreset went to mikser-io-assets; the same
// distinction is asserted there, against that package's own exports, because
// a convention that spans two packages has to hold in both.
describe('helper factories are named for their role', () => {
    const helpers = [
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

    it('the real renderer keeps its name and DOES have render()', () => {
        // Renaming this would have been the mistake the exercise is about.
        assert.equal(typeof renderHbs({}).render, 'function')
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

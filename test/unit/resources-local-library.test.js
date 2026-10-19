// A resources library declared with `match` and no `url`.
//
// This plugin fetches REMOTE things and serves them locally. The download
// writes into resourcesFolder and that folder is symlinked into the output —
// inside `if (downloads.length)`, so a library with nothing to download links
// nothing anywhere. A local `match` reaches neither half: it creates an entity
// pointing at a file already in the working folder and stamps `meta.url` on
// it, promising a deployed path that nothing here deploys.
//
// It is also never re-read. The entity is built inside onProcessed while
// walking the journal, so its checksum is recomputed only when a referencing
// DOCUMENT is journalled. Editing the file does nothing; a restart does
// nothing either, because the startup scan's checksum gate skips the unchanged
// document so it never enters the journal. Reported from a real site: an 82MB
// video replaced in place, both derivatives stale, and the only thing that
// rebuilt them was touching an unrelated document that referenced it.
//
// Correct on the first build and stale forever after is the most expensive
// shape a mistake can take, so it says so out loud.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness } from './plugin-harness.js'
import { resources } from '../../src/plugins/resources.js'

const load = async (libraries) => {
    const harness = createHarness({ options: { workingFolder: '/tmp/x', outputFolder: '/tmp/x/out' } })
    resources({ libraries })(harness.core)
    for (const hook of harness.hooks.loaded) await hook()
    return harness
}

const warnings = (harness) => harness.logs
    .filter(l => l.level === 'warn')
    .map(l => l.args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))

describe('a resources library declared with a local `match`', () => {
    it('says so, and names the plugin that does the job', async () => {
        const harness = await load({ storage: { match: '^/media/' } })
        const text = warnings(harness).join('\n')
        assert.match(text, /resources-local-library/, 'not coded, so it cannot be deduped or reported')
        assert.match(text, /storage/, 'does not name the library')
        assert.match(text, /sources\(/, 'does not point at the plugin for unserved originals')
        assert.match(text, /files\(/, 'does not point at the plugin for served files')
    })

    it('still registers the library, so nothing breaks mid-build', async () => {
        // A warning, not a refusal: the build this fires on is a build that
        // was working, however stale, and failing it outright would take a
        // site down to deliver a message.
        const harness = await load({ storage: { match: '^/media/' } })
        assert.deepEqual(harness.runtime.state.resources.resourceLib, { '^/media/': 'storage' })
    })

    it('says nothing about a `url` library', async () => {
        // The shape the plugin is for. It downloads and it serves.
        const harness = await load({ cdn: { url: 'https://cdn.example.com/' } })
        assert.deepEqual(warnings(harness), [])
    })

    it('says nothing when `match` narrows a `url` library', async () => {
        // Legitimate: a remote library whose references do not begin with its
        // url, so the pattern that selects them is given explicitly.
        const harness = await load({ cdn: { url: 'https://cdn.example.com/', match: '^/vendor/' } })
        assert.deepEqual(warnings(harness), [])
    })
})

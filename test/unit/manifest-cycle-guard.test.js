// The finalize hook survives a cycle in a process where it never loaded.
//
// A plugin can schedule a cycle without the engine having been brought up —
// `createdHook` does exactly that, and mikser-io-forms calls it from an HTTP
// handler. If the manifest's own onLoaded never ran, `sharedManifest` is null
// and the finalize hook is asked to reconcile against nothing.
//
// It used to survive that by accident: every statement touching the manifest
// sat inside a loop over journal entries, and an empty journal never reached
// one. Adding a pass that reads its state unconditionally turned the accident
// into a TypeError thrown from inside a cycle — found by a forms test, not by
// this suite, which is why the case is now pinned here.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { registerManifestHooks } from '../../src/manifest/cycle.js'

describe('the manifest finalize hook with no manifest', () => {
    it('returns instead of throwing', async () => {
        // Registering the hooks WITHOUT running onLoaded is the whole point:
        // it leaves the module in the state a partially-brought-up process is
        // in. `createManifest` is never called, so nothing is assigned.
        const before = runtime.hooks?.finalize?.length ?? 0
        registerManifestHooks(() => { throw new Error('onLoaded must not have run') })
        const registered = (runtime.hooks?.finalize ?? []).slice(before)
        assert.ok(registered.length, 'precondition: a finalize hook was registered')

        for (const hook of registered) {
            await hook({ aborted: false })
        }
    })
})

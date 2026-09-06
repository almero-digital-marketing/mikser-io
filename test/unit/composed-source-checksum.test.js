// A collection that composes its catalog checksum must be compared on its own
// terms.
//
// `gateChecksum` takes `bytes`, so a plugin can store a checksum built from
// more than one file. mikser-io-layouts uses it: a layout's catalog checksum
// is md5("<template>:<sidecar>:<sharedDigest>"), so editing a .js sidecar
// invalidates the layout that uses it. That is deliberate and correct.
//
// What was not correct is comparing that stored value against a fresh md5 of
// the template. Two recipes, so they never match — and mikser_explain reported
// `differs: true` for EVERY layout on every site, permanently, about files
// nobody had touched. Verified on a live site: the catalog held
// bd5db4625ff3b11ecbd319a95266ce48 while the file hashed to
// 8a992a7c3fbaef26ac4367456e3bfd88, and
//
//   md5("8a992a7c3fbaef26ac4367456e3bfd88" + ":" + "" + ":" + "")
//     === "bd5db4625ff3b11ecbd319a95266ce48"
//
// so the two agreed exactly. A permanent false alarm is worse than no alarm:
// it teaches the reader to skip the real one.

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { registerSourceChecksum, recomputeSourceChecksum } from '../../src/source.js'

const md5 = (s) => createHash('md5').update(s).digest('hex')
let unregister = null
afterEach(() => { unregister?.(); unregister = null })

describe('the composition observed in production', () => {
    it('is exactly what the catalog held', () => {
        // Not a re-derivation of the formula — the real values, off a real
        // site, so a change to the recipe fails here rather than in the field.
        const template = '8a992a7c3fbaef26ac4367456e3bfd88'
        assert.equal(md5(`${template}::`), 'bd5db4625ff3b11ecbd319a95266ce48')
    })
})

describe('recomputeSourceChecksum', () => {
    it('returns null for a collection that composes nothing', async () => {
        // Which tells the caller to use the plain file hash — right for every
        // ordinary source, and what explain still does there.
        assert.equal(await recomputeSourceChecksum({ collection: 'documents', uri: '/x.md' }), null)
    })

    it('returns the collection\'s own value when one is registered', async () => {
        unregister = registerSourceChecksum('layouts', async (entity) => md5(`${entity.name}::`))
        assert.equal(await recomputeSourceChecksum({ collection: 'layouts', name: 'abc' }), md5('abc::'))
    })

    it('falls back to null rather than throwing when a recompute fails', async () => {
        // A plugin whose sidecar folder vanished must not take explain down
        // with it — the answer is "cannot tell", not a crash.
        unregister = registerSourceChecksum('layouts', async () => { throw new Error('gone') })
        assert.equal(await recomputeSourceChecksum({ collection: 'layouts', name: 'abc' }), null)
    })

    it('stops answering once unregistered', async () => {
        const off = registerSourceChecksum('layouts', async () => 'x')
        off()
        assert.equal(await recomputeSourceChecksum({ collection: 'layouts', name: 'a' }), null)
    })

    it('refuses a registration that cannot work', () => {
        assert.throws(() => registerSourceChecksum('layouts'), /requires both/)
        assert.throws(() => registerSourceChecksum(null, async () => 'x'), /requires both/)
    })
})

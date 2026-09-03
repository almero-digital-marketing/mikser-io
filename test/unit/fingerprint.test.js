// The two properties that make a fingerprint comparable, tested where they
// live. A scenario cannot force globby to return files in a hostile order, so
// neither property is observable end to end — and an untestable guard is one
// that gets removed later by someone who checks that the tests still pass.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { combineEntries } from '../../src/fingerprint.js'

const entry = (file, hash) => ({ file, hash })

describe('combineEntries', () => {
    it('does not depend on the order it is given', () => {
        // The real failure: hashing per directory block meant the result
        // depended on the order the blocks came back, so two runs over
        // byte-identical trees hashed differently — a false CHANGED, which
        // sends someone hunting a regression that never happened.
        const a = [entry('a.html', 'h1'), entry('derived/web/x.webp', 'h2'), entry('b.css', 'h3')]
        const b = [entry('b.css', 'h3'), entry('a.html', 'h1'), entry('derived/web/x.webp', 'h2')]
        assert.equal(combineEntries(a), combineEntries(b))
    })

    it('changes when a file moves, because a rename is a change', () => {
        const before = [entry('a.html', 'h1')]
        const after = [entry('moved/a.html', 'h1')]
        assert.notEqual(combineEntries(before), combineEntries(after))
    })

    it('changes when content changes', () => {
        assert.notEqual(combineEntries([entry('a.html', 'h1')]),
            combineEntries([entry('a.html', 'h2')]))
    })

    it('separates a path/content boundary that concatenation would blur', () => {
        // `ab` + `c` and `a` + `bc` must not collide — the NUL keeps them
        // apart, and without it two different trees could share a hash.
        assert.notEqual(combineEntries([entry('ab', 'c')]), combineEntries([entry('a', 'bc')]))
    })

    it('is empty-safe', () => {
        assert.equal(typeof combineEntries([]), 'string')
    })
})

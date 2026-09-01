// A resources library key has two consumers and they must agree.
//
// `resources()` derives the key with escapeStringRegexp(url) — you only escape
// a string you are about to compile, so the key is a REGULAR EXPRESSION source
// and a url-declared library is a prefix pattern.
//
// Two places read it: the plugin's discovery walk, which decides what to
// DOWNLOAD, and the `resource` render helper, which builds the url a page
// links. Discovery used a GLOB matcher, which demands a full match, so a key
// derived from `url` — a bare prefix with no trailing wildcard — matched
// nothing at all. No url-declared library was ever downloaded, while the
// helper went on building links to the files nobody fetched: a green build
// serving missing images, found only when the output was read back and the
// references checked.
//
// Both now call matchesLibrary, so they cannot drift apart again.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import escapeStringRegexp from 'escape-string-regexp'

import { matchesLibrary, matchEntity } from '../../src/utils.js'

// Exactly how resources() builds the key for `{ url: '...' }`.
const keyFor = (url) => escapeStringRegexp(url)

describe('resources library matching', () => {
    it('matches a url under a library declared by its base url', () => {
        const key = keyFor('https://placehold.co/')
        assert.equal(matchesLibrary('https://placehold.co/600x400.jpg', key), true)
        assert.equal(matchesLibrary('https://lorem.video/720p.mp4', key), false)
    })

    it('is the reason the glob matcher was wrong', () => {
        // Kept as an executable statement of the bug: the same key, read as a
        // glob, matches nothing — which is why nothing downloaded.
        const key = keyFor('https://placehold.co/')
        assert.equal(matchEntity('https://placehold.co/600x400.jpg', key), false)
        assert.equal(matchesLibrary('https://placehold.co/600x400.jpg', key), true)
    })

    it('honors an explicit match pattern', () => {
        assert.equal(matchesLibrary('https://cdn.test/a/b.jpg', '^https://cdn\\.test/'), true)
        assert.equal(matchesLibrary('https://other.test/a/b.jpg', '^https://cdn\\.test/'), false)
    })

    it('treats an unparseable pattern as matching nothing rather than throwing', () => {
        // The walk visits every string in every entity's meta; one bad
        // hand-written `match` must not take the build down.
        assert.doesNotThrow(() => matchesLibrary('https://x.test/a.jpg', '('))
        assert.equal(matchesLibrary('https://x.test/a.jpg', '('), false)
    })

    it('ignores non-strings and an empty pattern', () => {
        assert.equal(matchesLibrary(undefined, 'x'), false)
        assert.equal(matchesLibrary(42, 'x'), false)
        assert.equal(matchesLibrary('https://x.test/', ''), false)
    })
})

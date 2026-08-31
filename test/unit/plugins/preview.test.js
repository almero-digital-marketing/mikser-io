// The preview cache: render bytes held in memory and served at a URL, so an
// agent can show someone a page without publishing it.
//
// Three things have to hold or it stops being a cache and becomes a leak: it
// expires, it stays under its byte ceiling, and it lets go of anything whose
// content changed underneath it.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { preview } from '../../../src/plugins/preview.js'
import { createHarness } from '../plugin-harness.js'

function setup({ journal = [], ...options } = {}) {
    const h = createHarness({ journal })
    h.core.runtime.options ??= {}
    preview(options)(h.core)
    return { h, cache: h.core.runtime.options.preview }
}

const bytes = (n) => Buffer.alloc(n, 'x')

describe('the preview cache', () => {
    it('publishes its surface at factory time, before any hook runs', () => {
        // mcp's preview tools read this during their own onLoaded, so it
        // cannot wait for one.
        const { cache } = setup()
        assert.deepEqual(Object.keys(cache).sort(), ['config', 'get', 'stats', 'store'])
    })

    it('stores and returns bytes', () => {
        const { cache } = setup()
        cache.store({ filename: 'a.html', bytes: '<p>hi</p>', mime: 'text/html', ttlMs: 60_000 })
        const entry = cache.get('a.html')
        assert.equal(entry.bytes, '<p>hi</p>')
        assert.equal(entry.mime, 'text/html')
    })

    it('returns null for something it never had', () => {
        const { cache } = setup()
        assert.equal(cache.get('nope.html'), null)
    })

    it('forgets an entry once its ttl has passed', () => {
        const { cache } = setup()
        cache.store({ filename: 'a.html', bytes: 'x', mime: 'text/html', ttlMs: -1 })
        assert.equal(cache.get('a.html'), null, 'expired')
        assert.equal(cache.stats().count, 0, 'and dropped, not merely hidden')
    })

    it('gives back the bytes it accounted for', () => {
        // The counter is what the ceiling is enforced against; if it drifts,
        // eviction either never fires or fires constantly.
        const { cache } = setup()
        cache.store({ filename: 'a.html', bytes: bytes(1000), mime: 'text/html', ttlMs: 60_000 })
        assert.equal(cache.stats().bytesInUse, 1000)
        cache.store({ filename: 'b.html', bytes: bytes(500), mime: 'text/html', ttlMs: 60_000 })
        assert.equal(cache.stats().bytesInUse, 1500)
        assert.equal(cache.stats().count, 2)
    })

    it('evicts the oldest entries to stay under the ceiling', () => {
        const { cache } = setup({ maxBytes: 1000 })
        cache.store({ filename: 'old.html', bytes: bytes(600), mime: 'text/html', ttlMs: 60_000 })
        cache.store({ filename: 'new.html', bytes: bytes(600), mime: 'text/html', ttlMs: 60_000 })
        assert.equal(cache.get('old.html'), null, 'the oldest goes')
        assert.ok(cache.get('new.html'), 'the newest stays')
        assert.equal(cache.stats().bytesInUse, 600, 'and the counter follows')
    })

    it('counts a read as recent, so the ceiling evicts the least used', () => {
        const { cache } = setup({ maxBytes: 1200 })
        cache.store({ filename: 'a.html', bytes: bytes(500), mime: 'text/html', ttlMs: 60_000 })
        cache.store({ filename: 'b.html', bytes: bytes(500), mime: 'text/html', ttlMs: 60_000 })
        cache.get('a.html')   // a is now the most recently used
        cache.store({ filename: 'c.html', bytes: bytes(500), mime: 'text/html', ttlMs: 60_000 })
        assert.ok(cache.get('a.html'), 'the one that was read survives')
        assert.equal(cache.get('b.html'), null, 'the untouched one is evicted')
    })
})

describe('letting go when the content changes', () => {
    const mutated = (id) => [{ entity: { id, collection: 'documents' }, operation: 'update' }]

    it('evicts a preview whose dependency was mutated', async () => {
        // A preview of a page whose source just changed is worse than no
        // preview: it looks current and is not.
        const { h, cache } = setup({ journal: mutated('/documents/a.md') })
        cache.store({
            filename: 'a.html', bytes: 'stale', mime: 'text/html', ttlMs: 60_000,
            deps: [{ id: '/documents/a.md' }],
        })
        await h.runHook('persist')
        assert.equal(cache.get('a.html'), null)
        assert.equal(cache.stats().bytesInUse, 0, 'the byte count is released too')
    })

    it('keeps a preview whose dependency did not move', async () => {
        const { h, cache } = setup({ journal: mutated('/documents/other.md') })
        cache.store({
            filename: 'a.html', bytes: 'fresh', mime: 'text/html', ttlMs: 60_000,
            deps: [{ id: '/documents/a.md' }],
        })
        await h.runHook('persist')
        assert.ok(cache.get('a.html'), 'unrelated edits must not clear the cache')
    })

    it('keeps a preview that declared no dependencies', async () => {
        // Those are ttl-only by design — the caller said nothing about what
        // the bytes depend on, so mikser cannot decide they went stale.
        const { h, cache } = setup({ journal: mutated('/documents/a.md') })
        cache.store({ filename: 'a.html', bytes: 'x', mime: 'text/html', ttlMs: 60_000 })
        await h.runHook('persist')
        assert.ok(cache.get('a.html'))
    })

    it('evicts on any mutation when a dependency could not be expressed', async () => {
        // A null filter is the sentinel for a predicate that could not be
        // serialized. Conservative on purpose: wrongly keeping a stale
        // preview is worse than wrongly dropping a live one.
        const { h, cache } = setup({ journal: mutated('/documents/unrelated.md') })
        cache.store({
            filename: 'a.html', bytes: 'x', mime: 'text/html', ttlMs: 60_000, deps: [null],
        })
        await h.runHook('persist')
        assert.equal(cache.get('a.html'), null)
    })
})

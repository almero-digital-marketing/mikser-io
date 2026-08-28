// The read-recording view behind a layout's RUNTIME contract.
//
// Walking templates finds what the templates read. It cannot find what a
// SIDECAR reads, because a sidecar is plain JavaScript — `row.meta?.hero?.tags`
// has no syntax for any template parser to look for. Observing the access is
// the only way, and observing it on the one object every engine is handed makes
// it engine-agnostic by construction rather than by porting effort.
//
// Two properties matter and are easy to get wrong. It must record deep paths in
// the same vocabulary the static closure uses, so the two can be compared; and
// it must be perfectly transparent, because a view that changed the answers
// would be a worse bug than the blindness it is fixing.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recordReads } from '../../src/track.js'

const observe = (value, prefix = 'meta') => {
    const seen = new Set()
    return { view: recordReads(value, prefix, p => seen.add(p)), seen }
}

describe('recordReads: what it records', () => {
    it('records a deep path one segment at a time', () => {
        const { view, seen } = observe({ hero: { title: 'T' } })
        void view.hero.title
        assert.deepEqual([...seen].sort(), ['meta.hero', 'meta.hero.title'])
    })

    it('collapses array indices to a single element marker', () => {
        // The contract wants "each tag has a label", not "tag 7 has a label" —
        // and this is the vocabulary the static closure already reports in, so
        // the two line up without translation.
        const { view, seen } = observe({ tags: [{ label: 'a' }, { label: 'b' }] })
        for (const t of view.tags) void t.label
        assert.ok(seen.has('meta.tags[].label'))
        assert.ok(![...seen].some(p => /\[\]\[\]|\.\d/.test(p)), `unexpected index in ${[...seen]}`)
    })

    it('sees a read made by plain JavaScript, which is the whole point', () => {
        // Exactly the shape a sidecar uses, and exactly what no parser finds.
        const { view, seen } = observe({ seo: { canonical: '/a' } })
        void (view.meta?.seo?.canonical ?? view.seo?.canonical ?? null)
        assert.ok(seen.has('meta.seo.canonical'))
    })

    it('ignores properties the object does not have', () => {
        // Engines probe every value for protocol members — LiquidJS asks for
        // `toLiquid`, iteration asks for `next`. Recording those would put one
        // engine's machinery into a document's contract.
        const { view, seen } = observe({ title: 'T' })
        void view.toLiquid
        void view.next
        void view.title
        assert.deepEqual([...seen], ['meta.title'])
    })

    it('ignores the bookkeeping properties every object has', () => {
        const { view, seen } = observe({ items: [1, 2, 3] })
        void view.items.length
        void view.toString
        assert.deepEqual([...seen], ['meta.items'])
    })
})

describe('recordReads: transparency', () => {
    const source = { hero: { title: 'T', tags: [{ label: 'a' }] }, n: 1, flag: false, nothing: null }

    it('serializes identically to the object it wraps', () => {
        const { view } = observe(source)
        assert.equal(JSON.stringify(view), JSON.stringify(source))
    })

    it('keeps keys, spread and `in` honest', () => {
        const { view } = observe(source)
        assert.deepEqual(Object.keys(view), Object.keys(source))
        assert.deepEqual(Object.keys({ ...view }), Object.keys(source))
        assert.ok('hero' in view)
        assert.ok(!('absent' in view))
    })

    it('holds identity, so `a.b === a.b` still works', () => {
        const { view } = observe(source)
        assert.equal(view.hero, view.hero)
    })

    it('passes primitives straight through', () => {
        const { view } = observe(source)
        assert.equal(view.n, 1)
        assert.equal(view.flag, false)
        assert.equal(view.nothing, null)
        assert.equal(view.absent, undefined)
    })

    it('survives a cycle instead of recursing forever', () => {
        const cyclic = { name: 'root' }
        cyclic.self = cyclic
        const { view } = observe(cyclic)
        assert.equal(view.self.self.name, 'root')
    })
})

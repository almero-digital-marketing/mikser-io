// The findById cache is bounded by the bytes it holds, not only by how many
// entries it holds.
//
// The entry cap was sized against light entities — 10k × ~7KB ≈ 70MB — and
// the same 10k entries over a catalog of 88KB rows is 1.7GB. Measured with a
// forced collection at every lifecycle boundary on a corpus of 4,000 such
// entities: 693MB live across the render AND postprocess phases, three
// quarters of everything that survived the build, released only because the
// finalize drain invalidates every id it writes. Nothing leaked. The cache
// did exactly what it was told, for a corpus ten times heavier than the one
// the number was chosen for.
//
// A build is the only honest place to assert it: the cache fills from ref
// resolution and dispatch, and a unit test driving `cacheSet` directly would
// pin the arithmetic while saying nothing about whether anything fills it.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

// Each document is heavy enough that a handful of them pass the budget, and
// each points at the next, so resolving refs walks the whole ring and every
// one of them goes through findById.
const DOCUMENTS = 40
const BODY_BYTES = 64 * 1024
const BUDGET = 256 * 1024

const config = (cache) => `
import { documents, frontMatter, renderHbs, onAfterRender, runtime, useLogger } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'

// After the render, which is where the cache is fullest: the finalize drain
// invalidates every id it writes, so asking afterwards asks the wrong moment.
const report = () => () => {
    onAfterRender(() => {
        const { entries, bytes, maxBytes } = runtime.catalog.cacheStats()
        useLogger().info('cache-stats entries=%d bytes=%d maxBytes=%d', entries, bytes, maxBytes)
    })
}

export default {${cache}
    plugins: [documents(), frontMatter(), layouts(), renderHbs(), report()],
}
`

const body = (n) => Array.from(
    { length: Math.ceil(BODY_BYTES / 48) },
    (_, i) => `<p>document ${n} paragraph ${i}</p>`,
).join('\n')

const FIXTURE = {
    'mikser.config.js': config(''),
    'layouts/page.html.hbs': '<!doctype html><title>{{document.meta.title}}</title>',
    ...Object.fromEntries(Array.from({ length: DOCUMENTS }, (_, i) => [
        `documents/d${i}.html`,
        `---\nlayout: page\ntitle: Document ${i}\n$next: /documents/d${(i + 1) % DOCUMENTS}\n---\n${body(i)}`,
    ])),
}

const stats = (combined) => {
    const m = combined.match(/cache-stats entries=(\d+) bytes=(\d+) maxBytes=(\d+)/)
    assert.ok(m, `no cache-stats line\n${combined.slice(-1500)}`)
    return { entries: Number(m[1]), bytes: Number(m[2]), maxBytes: Number(m[3]) }
}

describe('the findById cache under a byte budget', () => {
    const workdir = freshWorkdir('catalog-cache-bounds')
    after(() => cleanup(workdir))
    let unbounded, bounded

    before(async () => {
        await setupFixture(workdir, FIXTURE)
        const first = await runMikser(workdir)
        assert.equal(first.code, 0, first.combined.slice(-1500))
        unbounded = stats(first.combined)

        // A config change wipes the cache, so the second run is a cold build
        // over the same corpus and the two are comparable.
        await writeFile(path.join(workdir, 'mikser.config.js'),
            config(`\n    catalog: { cache: { bytes: ${BUDGET} } },`))
        const second = await runMikser(workdir)
        assert.equal(second.code, 0, second.combined.slice(-1500))
        bounded = stats(second.combined)
    })

    it('holds the whole corpus when the corpus fits, so the bound costs nothing it should not', () => {
        assert.equal(unbounded.maxBytes, 128 * 1024 * 1024, 'the default budget')
        assert.ok(unbounded.bytes > BUDGET * 4,
            `the corpus has to overrun the budget for the next test to mean anything: ${unbounded.bytes}`)
        assert.ok(unbounded.entries >= DOCUMENTS,
            `every document cached: ${unbounded.entries} of ${DOCUMENTS}`)
    })

    it('stops at the budget instead of at the entry count', () => {
        assert.ok(bounded.bytes <= BUDGET + BODY_BYTES * 2,
            `held ${bounded.bytes} against a budget of ${BUDGET}`)
        assert.ok(bounded.entries < unbounded.entries,
            `evicted something: ${bounded.entries} vs ${unbounded.entries}`)
    })

    it('still caches, rather than thrashing itself empty', () => {
        // The ceiling is the budget PLUS one entity on purpose. An entity
        // bigger than the whole budget would otherwise be evicted on arrival
        // and never be there for the next lookup, which is a cache that costs
        // what it costs and returns nothing.
        assert.ok(bounded.entries >= 1, `kept nothing: ${JSON.stringify(bounded)}`)
    })
})

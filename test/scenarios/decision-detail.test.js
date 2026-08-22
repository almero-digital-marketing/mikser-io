// Why a render happened, at the level of "which one".
//
// A reason on its own answers a question nobody asked. `query-matched` on a
// page with eighteen query edges says a query matched; the reader needs to
// know which, and what tripped it. `ref-changed` says a dependency moved;
// which dependency, and whether it changed, vanished, or was never resolved
// in the first place are three different things to go and look at.
//
// All of it is live in skipDecision at the moment it decides, so a consumer
// having to reconstruct it from the database is a report that failed. Detail
// keys are per-reason — `changed`, `matched`, `dependency` — because each
// means something specific, and one polymorphic field would push the type
// switch onto every consumer.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({
            autoLayouts: false,
            match: { '@/index': 'listing', '@/unfiltered': 'unfiltered', '@/devices/**': 'page', '@/page-*': 'page' },
            cleanUrls: false,
        }),
        renderHbs(),
    ],
}
`

// A narrow query, and an unfiltered one on a separate page. Keeping them
// apart matters: the null-filter path returns before any mutation is
// examined, so a page carrying both would mask the narrow case.
const LISTING = `
export async function load({ findEntities }) {
    const devices = await findEntities({ id: { $regex: '^/documents/devices/' } })
    return { devices: devices.map(d => d.id) }
}
`
const UNFILTERED = `
export async function load({ findEntities }) {
    const all = await findEntities()
    return { count: all.length }
}
`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/listing.js': LISTING,
    'layouts/listing.hbs': '<ul>{{#each data.devices}}<li>{{this}}</li>{{/each}}</ul>',
    'layouts/unfiltered.js': UNFILTERED,
    'layouts/unfiltered.hbs': '<p>{{data.count}}</p>',
    'layouts/page.hbs': '<h1>{{document.meta.title}}</h1>',
    'documents/index.md': '---\ntitle: Listing\n---\nx\n',
    'documents/unfiltered.md': '---\ntitle: Unfiltered\n---\nx\n',
    'documents/devices/hera.md': '---\ntitle: Hera\n---\nbody\n',
    'documents/page-a.md': '---\ntitle: A\n$friend: /page-b\n---\nbody\n',
    'documents/page-b.md': '---\ntitle: B\nhref: /page-b\n---\nbody\n',
}

describe('render decision detail', () => {
    const workdir = freshWorkdir('decision-detail')
    after(() => cleanup(workdir))

    // ONE build per test, read several entries out of it. Calling a
    // per-entry helper that builds each time means the second read happens
    // after the first build already settled everything, so nothing renders
    // and the entry is simply absent.
    const build = async () => {
        const rendered = JSON.parse((await runMikser(workdir, ['--json'])).stdout).rendered
        return {
            all: rendered,
            at: (destination) => rendered.find(e => e.destination === destination),
        }
    }

    it('builds cold', async () => {
        await setupFixture(workdir, FIXTURE)
        const { all } = await build()
        assert.ok(all.length >= 5, `expected the corpus to render, got ${all.length}`)
    })

    it('names the filter and its trigger, and separates the unfiltered case', async () => {
        // One edit, two query pages, read from the same build. The narrow
        // filter reports what matched; the unfiltered one reports that it has
        // no filter at all — a different statement, pointing at the fix
        // catalog.js already warns about.
        await writeFile(path.join(workdir, 'documents', 'devices', 'hera.md'),
            '---\ntitle: Hera v2\n---\nbody\n')
        const { at } = await build()

        const listing = at('/index.html')
        assert.equal(listing.reason, 'query-matched')
        assert.deepEqual(listing.matched.filter, { id: { $regex: '^/documents/devices/' } })
        assert.equal(listing.matched.by, '/documents/devices/hera.md')

        const unfiltered = at('/unfiltered.html')
        assert.equal(unfiltered.reason, 'query-matched')
        assert.equal(unfiltered.matched.filter, null,
            'an unserializable predicate is not a filter that matched')
        assert.equal(unfiltered.matched.by, null)
    })

    it('ref-changed names the dependency and says it changed', async () => {
        await writeFile(path.join(workdir, 'documents', 'page-b.md'),
            '---\ntitle: B v2\nhref: /page-b\n---\nbody\n')
        const entry = (await build()).at('/page-a.html')
        assert.equal(entry.reason, 'ref-changed')
        assert.equal(entry.dependency.kind, 'ref')
        assert.equal(entry.dependency.target, '/page-b')
        assert.equal(entry.dependency.cause, 'changed')
    })

    it('ref-changed reports `deleted` when the target is gone', async () => {
        // The cause is the difference between "go look at what changed" and
        // "this reference is now dangling", which the same reason word hides.
        await rm(path.join(workdir, 'documents', 'page-b.md'))
        const entry = (await build()).at('/page-a.html')
        assert.equal(entry.reason, 'ref-changed')
        assert.equal(entry.dependency.cause, 'deleted')
    })

    it('carries no detail key that does not apply to the reason', async () => {
        // A consumer switches on `reason` and reads one field. A stray key
        // from another branch would make that switch wrong. Asserted over
        // every entry seen across this file's builds, not just the last.
        await writeFile(path.join(workdir, 'documents', 'devices', 'hera.md'),
            '---\ntitle: Hera v3\n---\nbody\n')
        const { all } = await build()
        assert.ok(all.length > 0, 'the check needs entries to check')
        for (const entry of all) {
            if (entry.reason === 'inputs-changed') {
                assert.ok(!('matched' in entry) && !('dependency' in entry))
            }
            if (entry.reason === 'query-matched') {
                assert.ok(!('changed' in entry) && !('dependency' in entry))
            }
            if (entry.reason === 'ref-changed') {
                assert.ok(!('changed' in entry) && !('matched' in entry))
            }
        }
    })
})

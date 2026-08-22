// Query edges in --explain, and whether they resolve to anything.
//
// A query edge is a PREDICATE — "any entity matching this" — and the
// recording layer stores the filter without its results on purpose. That
// is what makes an entity appearing later invalidate the page that links
// to it, and it must stay that way: an edge that recorded its bindings
// would record nothing for a query matching nothing, and creating the
// target tomorrow would then re-render nothing.
//
// Explaining is a different situation — read-only, reporting instead of
// building, catalog already open — so the count is computed at read time.
// Without it, a query matching nothing prints identically to one matching
// a hundred entities, and on a site whose references all go through a
// sidecar's findEntity that is every reference it has.
//
// Evaluated through findEntities rather than hand-rolled SQL, because
// stored filters include $regex and anything else sift accepts, and one
// code path is the only way the count means what the render meant.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' }, cleanUrls: false }),
        renderHbs(),
    ],
}
`

// One sidecar making four kinds of query: resolvable, unresolvable, a
// $regex, and an unfiltered call (the null-predicate sentinel).
const SIDECAR = `
export async function load({ findEntity, findEntities }) {
    const nav     = await findEntity({ 'meta.href': '/system/navigation' })
    const missing = await findEntity({ 'meta.href': '/cosmetics/celestetic' })
    const re      = await findEntities({ id: { $regex: '^/documents/page' } })
    const all     = await findEntities()
    return { nav: nav?.id ?? null, missing: missing?.id ?? null, re: re.length, all: all.length }
}
`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.js': SIDECAR,
    'layouts/page.hbs': '<p>{{data.nav}}</p>',
    'documents/page-a.md': '---\ntitle: A\n---\nbody\n',
    'documents/navigation.yml': 'href: /system/navigation\ntitle: Nav\n',
}

describe('--explain: query edges', () => {
    const workdir = freshWorkdir('explain-query-edges')
    after(() => cleanup(workdir))

    const queries = async () => {
        const result = await runMikser(workdir, ['--explain', '/documents/page-a.md', '--json'])
        const report = JSON.parse(result.stdout)
        return report.renders[0].refClosure.filter(e => e.kind === 'query')
    }
    const byHref = (edges, href) =>
        edges.find(e => e.filter?.['meta.href'] === href)

    it('records the sidecar\'s queries as edges', async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir)
        assert.equal((await queries()).length, 4)
    })

    it('reports 0 for a query that matches nothing', async () => {
        const edge = byHref(await queries(), '/cosmetics/celestetic')
        assert.equal(edge.matched, 0, 'a dangling reference must be visible as such')
    })

    it('reports the match and names it when there is exactly one', async () => {
        const edge = byHref(await queries(), '/system/navigation')
        assert.equal(edge.matched, 1)
        assert.equal(edge.sample, '/documents/navigation.yml')
    })

    it('evaluates a $regex filter rather than giving up on it', async () => {
        const edge = (await queries()).find(e => e.filter?.id?.$regex)
        assert.equal(edge.matched, 1)
    })

    it('reports null — not 0 — for an unserializable predicate', async () => {
        // findEntities() with no argument records `null`, which invalidates
        // on any mutation by design. There is nothing to evaluate, and a 0
        // there would read as "this reference is broken".
        const edge = (await queries()).find(e => e.filter === null)
        assert.equal(edge.matched, null)
    })

    it('every query edge carries `matched` explicitly', async () => {
        // A MISSING key is ambiguous: an audit script reading absence as
        // "unresolved" reports every query edge as dangling. The field is
        // always present so absence never has to be interpreted.
        for (const edge of await queries()) {
            assert.ok('matched' in edge, `no matched key on ${JSON.stringify(edge.filter)}`)
        }
    })

    it('flips to matched once the target is created', async () => {
        // The property the recording layer protects, observable end to end:
        // the edge was stored without results, so the page still depends on
        // a filter whose answer changes when the entity appears.
        await writeFile(path.join(workdir, 'documents', 'celestetic.md'),
            '---\ntitle: Celestetic\nhref: /cosmetics/celestetic\n---\nbody\n')
        await runMikser(workdir)
        const edge = byHref(await queries(), '/cosmetics/celestetic')
        assert.equal(edge.matched, 1)
        assert.equal(edge.sample, '/documents/celestetic.md')
    })
})

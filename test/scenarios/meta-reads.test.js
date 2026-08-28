// What a render actually READ from the entity's meta, recorded and persisted.
//
// mikser_layouts_inspect assembles a layout's contract by walking templates.
// That finds what the TEMPLATES read and cannot, even in principle, find what a
// SIDECAR reads: a sidecar is plain JavaScript, so `entity.meta?.seo?.canonical`
// has no syntax for any template parser to look for. A key required by the
// sidecar and named nowhere in the markup is invisible to static analysis, and
// an agent diffing a document against a static contract would call it unused.
//
// So the two halves are collected separately and reported separately: the
// static closure says what the templates COULD read, this says what WAS read.
// Neither is complete alone — this one is blind to a branch no sample took, the
// other is blind to the sidecar.
//
// The fixture is built so that only the observed half can succeed: the sidecar
// reads two keys the template never mentions.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir, readManifest } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' } }),
        renderHbs(),
    ],
}
`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    // Mentions `title` and the sidecar's output. Never mentions `seo` or
    // `hero` — a parser reading this file would not learn they are required.
    'layouts/page.hbs': '<html><body>{{document.meta.title}}<span>{{document.badge}}</span></body></html>',
    // Plain JavaScript. This is the half no engine's parser can see.
    //
    // It calls expandEntity() on the entity it was handed, which is what a real
    // sidecar does and what broke in 9.39.0: the entity's meta is a recording
    // view, expandEntity clones so it never mutates the caller's catalog row,
    // and structuredClone rejects any Proxy. Every ref-expanding sidecar threw
    // DataCloneError. The fixture expands a ref so that path is exercised here.
    'layouts/page.js': `
        import { expandEntity } from 'mikser-io'
        export async function load({ entity, findEntity }) {
            const expanded = await expandEntity(entity, ['$'], {
                findRef: async (ref) => await findEntity({ id: ref }),
            })
            const canonical = expanded.meta?.seo?.canonical ?? null
            const tags = expanded.meta?.hero?.tags ?? []
            const author = expanded.meta?.$author?.meta?.name ?? '?'
            return { ...expanded, badge: tags.length ? tags[0].label + '/' + author : (canonical ? 'seo' : 'none') }
        }
    `,
    'documents/a.md':
        '---\nhref: /a\ntitle: One\n$author: /documents/author.md\nseo:\n  canonical: /a\n'
        + 'hero:\n  tags:\n    - label: Alpha\n---\n',
    'documents/author.md': '---\nhref: /author\nname: Ada\n---\n',
}

describe('meta reads observed during a render', () => {
    const workdir = freshWorkdir('meta-reads')
    after(() => cleanup(workdir))

    let snapshot, output
    before(async () => {
        await setupFixture(workdir, FIXTURE)
        const result = await runMikser(workdir, [])
        output = result
        const manifest = await readManifest(workdir)
        snapshot = manifest.find(s => s.id === '/documents/a.md')
    })

    it('records a key only the SIDECAR read', () => {
        // The single most important assertion here: `seo.canonical` appears in
        // no template, so nothing but observation can find it.
        assert.ok(snapshot?.metaReads, `no metaReads recorded: ${JSON.stringify(snapshot)}`)
        assert.ok(snapshot.metaReads.includes('meta.seo.canonical'),
            `expected meta.seo.canonical, got: ${snapshot.metaReads.join(', ')}`)
    })

    it('records a deep key read through an array in the sidecar', () => {
        assert.ok(snapshot.metaReads.includes('meta.hero.tags[].label'),
            `expected meta.hero.tags[].label, got: ${snapshot.metaReads.join(', ')}`)
    })

    it('records what the TEMPLATE read too, and keeps the two apart', () => {
        // `data.meta.` is what a template reads — the entity as the renderer
        // sees it, after any transform the sidecar applied. `meta.` is the
        // document's own keys, read before that. Same object, different
        // questions, so they carry different prefixes.
        assert.ok(snapshot.metaReads.includes('data.meta.title'))
        assert.ok(snapshot.metaReads.some(p => p.startsWith('meta.')))
    })

    it('does not record engine machinery as content keys', () => {
        // Renderers probe every value for protocol members. Recording those
        // would put one engine's internals into a document's contract.
        for (const noise of ['toLiquid', 'next', 'length', 'toJSON', 'constructor']) {
            assert.ok(!snapshot.metaReads.some(p => p.endsWith(`.${noise}`)),
                `${noise} leaked into the contract: ${snapshot.metaReads.join(', ')}`)
        }
    })

    it('let the sidecar EXPAND refs — the 9.39.0 regression', () => {
        // structuredClone rejects any Proxy, so a recording view reaching
        // expandEntity threw DataCloneError and took the whole render with it.
        // If the ref did not resolve, the sidecar degraded silently instead.
        assert.match(output.stdout + output.stderr, /^(?!.*DataCloneError)/s,
            'DataCloneError in the build output')
        assert.ok(snapshot?.metaReads?.some(p => p.startsWith('meta.')),
            'the sidecar read nothing — it probably threw')
    })

    it('does not disturb the render', () => {
        // A read-recording view that changed what a template sees would be a
        // worse bug than the blindness it fixes.
        assert.equal(output.code, 0)
    })
})

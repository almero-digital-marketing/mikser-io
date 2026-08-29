// Which fields of OTHER entities a render reads.
//
// `metaReads` answers "what did rendering this entity read". This answers it
// from the other side — what does anything need FROM it — and that is the only
// sense in which a document that never renders has a contract at all. Without
// it, mikser_check_entity could say WHICH pages pulled a navigation document in,
// because the manifest records the query filters, but not which of its fields
// those pages then took: a consumer list and an apology instead of a check.
//
// There are two ways another entity reaches a render, and both are covered here
// because covering one and not the other would leave a project blind depending
// on how its layouts happen to be written:
//
//   - a sidecar's findEntity / findEntities
//   - a template's lookupHref
//
// `lookupUrl` needs no equivalent: it returns a URL string, so nothing is ever
// read off an entity by the caller.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir, readManifest, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [ documents(), frontMatter(), layouts({ autoLayouts: false }), renderHbs() ],
}
`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    // Reads two fields off the entity the sidecar handed it, and reaches a
    // second entity itself through lookupHref.
    'layouts/page.hbs':
        '<html>{{#each document.nav}}<a>{{this.label}}</a>{{/each}}'
        + '<b>{{#with (lookupHref "/other")}}{{this.meta.title}}{{/with}}</b></html>',
    'layouts/page.js': `
        export async function load({ entity, findEntity }) {
            const nav = await findEntity({ 'meta.href': '/system/nav' })
            return { ...entity, nav: (nav?.meta?.items ?? []).map(i => ({ label: i.label })) }
        }
    `,
    'documents/page.md': '---\nhref: /page\ntitle: Home\nlayout: page\n---\n',
    // Never renders. Its contract is whatever consumers read off it.
    // Front-matter form: this config loads documents + frontMatter, with no
    // yaml() plugin, so a bare .yml body would carry no meta at all.
    'documents/nav.md':
        '---\nhref: /system/nav\nitems:\n  - label: Home\n    hidden: false\nmenuLabel: Menu\n---\n',
    'documents/other.md': '---\nhref: /other\ntitle: Other\nsubtitle: Unread\n---\n',
}

describe('fields read off other entities', () => {
    const workdir = freshWorkdir('consumed-reads')
    after(() => cleanup(workdir))

    let consumed
    before(async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir, [])
        const manifest = await readManifest(workdir)
        const page = manifest.find(s => s.id === '/documents/page.md')
        consumed = new Map((page?.consumedReads ?? []).map(([id, paths]) => [id, paths]))
    })

    it('records what a SIDECAR read off an entity it queried', () => {
        const nav = consumed.get('/documents/nav.md')
        assert.ok(nav, `nothing recorded for nav.md: ${JSON.stringify([...consumed])}`)
        assert.ok(nav.includes('items[].label'), `got: ${nav.join(', ')}`)
    })

    it('records what a TEMPLATE read through lookupHref', () => {
        // No sidecar involved. Covering only the sidecar path would leave a
        // project blind depending on how its layouts are written.
        const other = consumed.get('/documents/other.md')
        assert.ok(other, `nothing recorded for other.md: ${JSON.stringify([...consumed])}`)
        assert.ok(other.includes('title'), `got: ${other.join(', ')}`)
    })

    it('records ONLY what was read, which is what makes it a contract', () => {
        // A field nobody touched must not appear, or "unused" means nothing and
        // the whole check collapses into noise.
        assert.ok(!consumed.get('/documents/nav.md').includes('menuLabel'))
        assert.ok(!consumed.get('/documents/nav.md').some(p => p.endsWith('hidden')))
        assert.ok(!consumed.get('/documents/other.md').includes('subtitle'))
    })

    it('keys them by the entity they belong to, not by the render', () => {
        // The question is asked from the other side: "what does anything read
        // from nav.yml". Keying by the consumed entity is what makes that a
        // lookup rather than a scan of every field of every render.
        for (const id of consumed.keys()) assert.match(id, /^\/documents\//)
        assert.ok(!consumed.has('/documents/page.md'), 'a render does not consume itself')
    })
})

// --explain is where a person at a terminal asks about ONE entity, so it is
// where "and here is what its render actually read" belongs. refClosure already
// answers "what would re-render this"; these answer "what does it actually
// use", which is the question behind a document that renders to a hole.
describe('--explain reports what a render read', () => {
    const workdir = freshWorkdir('explain-reads')
    after(() => cleanup(workdir))

    let text, json
    before(async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir, [])
        text = stripAnsi((await runMikser(workdir, ['--explain', '/documents/page.md'])).stdout)
        json = JSON.parse((await runMikser(workdir, ['--explain', '/documents/page.md', '--json'])).stdout)
    })

    it('names the entity whose fields it read, and which fields', () => {
        assert.match(text, /consumed\s+\/documents\/nav\.md/)
        assert.match(text, /items\[\]\.label/)
    })

    it('carries the same facts in --json, per render', () => {
        // Per render, not per entity: a paginated document has several, and
        // they can differ.
        const consumed = json.renders?.[0]?.consumedReads ?? []
        const nav = consumed.find(c => c.entity === '/documents/nav.md')
        assert.ok(nav, `consumedReads: ${JSON.stringify(consumed)}`)
        assert.ok(nav.keys.includes('items[].label'))
    })

    it('says nothing when there is nothing to say', () => {
        // A document that read no other entity must not gain an empty heading —
        // a report grows a section per feature and stops being readable.
        const other = stripAnsi(text)
        assert.ok(!/consumed\s+$/m.test(other))
    })
})

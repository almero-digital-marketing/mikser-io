// searchEntities — the "where does this appear?" primitive.
//
// Covers the three scopes, the scoping option that keeps it safe to put
// behind a request, and the byte-level text decision that replaced an
// extension allowlist.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import {
    searchEntities, countMatches, snippetAround, lineOfFirstMatch, flattenMeta, findOccurrences,
} from '../../src/search.js'

let dir

// The catalog with no database open reads runtime.catalog.byId and applies
// sift for real, so `filter` is exercised by the engine's own matcher rather
// than by a stub that approximates it.
const stub = (list) => {
    runtime.catalog = { byId: new Map(list.map(e => [e.id, e])) }
}

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-search-'))
    runtime.options = { ...runtime.options, outputFolder: path.join(dir, 'out') }
    stub([])
})
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('search primitives', () => {
    it('counts every occurrence, not just the first', () => {
        // The count is what names a component: seven on one page and one on
        // nine others is a different fact from "present on ten pages".
        assert.equal(countMatches('a b a b a', 'a', false, false), 3)
        assert.equal(countMatches('AbAb', 'a', false, true), 2)
        assert.equal(countMatches('xyz', 'a', false, false), 0)
    })

    it('does not hang on a zero-width regex', () => {
        // /a*/g returns an empty match at a non-matching position forever
        // unless lastIndex is advanced by hand.
        assert.equal(typeof countMatches('bbb', 'a*', true, false), 'number')
    })

    it('reports the line of the first match, 1-based', () => {
        assert.equal(lineOfFirstMatch('one\ntwo\nthree', 'three', false, false), 3)
        assert.equal(lineOfFirstMatch('one\ntwo', 'nope', false, false), null)
    })

    it('puts the snippet on the match, not the start of the file', () => {
        const text = 'x'.repeat(400) + 'NEEDLE' + 'y'.repeat(400)
        const snippet = snippetAround(text, 'NEEDLE', false, false)
        assert.ok(snippet.includes('NEEDLE'), 'the match must be in the snippet')
        assert.ok(snippet.length < 200, 'and it must not be the whole file')
    })

    it('flattens meta to the dotted paths refs report', () => {
        const paths = [...flattenMeta({ a: { b: 'x' }, list: ['p', 'q'] })].map(([p]) => p)
        assert.deepEqual(paths, ['a.b', 'list[0]', 'list[1]'])
    })

    it('separates a declaration from a use by where it sits on the line', () => {
        const css = '.btn {\n  color: red;\n}\n.card .btn { color: blue }\n'
        const sites = findOccurrences(css, '.btn')
        assert.equal(sites.length, 2)
        assert.equal(sites[0].leading, true, 'the declaration begins its line')
        assert.equal(sites[1].leading, false, 'the use sits mid-line')
    })
})

describe('searchEntities', () => {
    it('requires a query rather than returning everything', async () => {
        await assert.rejects(() => searchEntities({}), /query is required/)
    })

    it('finds a value in meta and names the field', async () => {
        stub([{ id: '/documents/a.md', collection: 'documents', meta: { title: 'Hello Lozenets' } }])
        const { hits } = await searchEntities({ query: 'Lozenets', in: ['meta'] })
        assert.equal(hits.length, 1)
        assert.equal(hits[0].where, 'meta')
        assert.equal(hits[0].field, 'title')
    })

    it('searches source files whose extension it has never heard of', async () => {
        // The whole point of deciding by bytes: a .njk is searched like a .md.
        const uri = path.join(dir, 'theme.njk')
        await writeFile(uri, '{% block body %}Lozenets{% endblock %}', 'utf8')
        stub([{ id: '/layouts/theme.njk', collection: 'layouts', uri, meta: {} }])
        const { hits } = await searchEntities({ query: 'Lozenets', in: ['content'] })
        assert.equal(hits.length, 1)
        assert.equal(hits[0].where, 'content')
        assert.equal(hits[0].occurrences, 1)
        assert.equal(hits[0].line, 1)
    })

    it('skips a binary source instead of matching noise inside it', async () => {
        const uri = path.join(dir, 'photo.png')
        await writeFile(uri, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
        stub([{ id: '/files/photo.png', collection: 'files', uri, meta: {} }])
        const { hits } = await searchEntities({ query: 'PNG', in: ['content'] })
        assert.deepEqual(hits, [])
    })

    it('searches built output and ranks by how heavily each file carries it', async () => {
        const out = path.join(dir, 'out')
        await mkdir(path.join(out, 'bg'), { recursive: true })
        await writeFile(path.join(out, 'index.html'), '<a class="btn">x</a>', 'utf8')
        await writeFile(path.join(out, 'bg', 'page.html'), '<i class="btn"></i><i class="btn"></i>', 'utf8')
        stub([])
        const { hits } = await searchEntities({ query: 'btn', in: ['output'] })
        assert.deepEqual(hits.map(h => [h.destination, h.occurrences]),
            [['/bg/page.html', 2], ['/index.html', 1]],
            'the file carrying it most is the component, and must sort first')
    })

    it('searches output formats no extension list would have listed', async () => {
        // A renderer plugin can emit anything. Deciding by extension makes a
        // format unsearchable until someone remembers to add it, and the
        // failure looks exactly like "the string is not there".
        const out = path.join(dir, 'out')
        await mkdir(out, { recursive: true })
        await writeFile(path.join(out, 'app.webmanifest'), '{"name":"Lozenets"}', 'utf8')
        await writeFile(path.join(out, 'site.brotli-map'), 'Lozenets', 'utf8')
        await writeFile(path.join(out, 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3]))
        const { hits } = await searchEntities({ query: 'Lozenets', in: ['output'] })
        assert.deepEqual(hits.map(h => h.destination).sort(),
            ['/app.webmanifest', '/site.brotli-map'])
    })

    it('does not decode a binary output file looking for a match', async () => {
        const out = path.join(dir, 'out')
        await mkdir(out, { recursive: true })
        // Bytes that contain the needle, inside a file that is not text.
        await writeFile(path.join(out, 'blob.bin'),
            Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('Lozenets', 'utf8')]))
        const { hits } = await searchEntities({ query: 'Lozenets', in: ['output'] })
        assert.deepEqual(hits, [])
    })

    it('says when the limit stopped it', async () => {
        // "these are the hits" and "these are the first N" are different
        // answers, and a caller acting on a blast radius cannot guess which.
        stub(Array.from({ length: 5 }, (_, i) => (
            { id: `/documents/${i}.md`, collection: 'documents', meta: { title: 'Lozenets' } })))
        const result = await searchEntities({ query: 'Lozenets', in: ['meta'], limit: 2 })
        assert.equal(result.hits.length, 2)
        assert.equal(result.truncated, true)
    })

    it('honours a filter, so a scoped caller cannot search past its scope', async () => {
        // The security property. A public endpoint that lists only published
        // documents must be able to search only those too.
        stub([
            { id: '/documents/live.md', collection: 'documents', meta: { title: 'Lozenets', published: true } },
            { id: '/documents/draft.md', collection: 'documents', meta: { title: 'Lozenets', published: false } },
        ])
        const { hits } = await searchEntities({
            query: 'Lozenets', in: ['meta'], filter: { 'meta.published': true },
        })
        assert.deepEqual(hits.map(h => h.id), ['/documents/live.md'],
            'the draft must not be reachable through search')
    })

    it('rejects an invalid regex instead of reporting no matches', async () => {
        stub([])
        await assert.rejects(() => searchEntities({ query: '([', regex: true, in: ['meta'] }))
    })
})

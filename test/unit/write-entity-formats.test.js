// writeEntity puts meta back the way the file carries it.
//
// It assumed front matter for everything. For a `.yml` or `.json` entity —
// which IS its meta, with no body — that was not a formatting quirk, it was
// destruction: with no `---` to find, the whole document was taken as the
// BODY and the patch written above it as fresh front matter. Re-parsing the
// result yielded the patch and nothing else. Measured on a price list, a
// one-key rename produced:
//
//     ---
//     title: Нова листа
//     ---
//     # Ценова листа
//     schema: pricelist          ← now inert text
//     categories: ...            ← now inert text
//
// and nothing threw. refs.rename reaches this for every entity that
// references a renamed one, which is the largest fan-out any request has.
//
// The fix is a registry rather than a yaml branch, because yaml is one of the
// formats mikser reads and the next one should not need this file edited.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

import { writeEntity, registerSourceFormat, sourceFormatFor, validateSource } from '../../src/utils/index.js'

let dir
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mikser-write-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const write = async (name, source, patch, entity = {}) => {
    const uri = path.join(dir, name)
    await writeFile(uri, source)
    await writeEntity({ uri, ...entity }, patch)
    return readFile(uri, 'utf8')
}

describe('a YAML document is meta all the way down', () => {
    it('patches in place instead of burying the document in front matter', async () => {
        const out = await write('index.yml',
            '# Ценова листа\nschema: pricelist\ntitle: old\n', { title: 'new' })
        assert.doesNotMatch(out, /^---/, 'no front matter shell')
        const parsed = YAML.parse(out)
        assert.equal(parsed.title, 'new')
        assert.equal(parsed.schema, 'pricelist', 'the rest of the document survives')
    })

    it('keeps comments, which a re-serialize would have dropped', async () => {
        const out = await write('a.yml', '# keep me\ntitle: old\n', { title: 'new' })
        assert.match(out, /# keep me/)
    })

    it('leaves values the patch does not name exactly as they were', async () => {
        const source = 'title: old\nnested:\n  deep:\n    - one\n    - two\n'
        const out = await write('b.yml', source, { title: 'new' })
        assert.match(out, /nested:\n {2}deep:\n {4}- one\n {4}- two/)
    })

    it('deletes a key on null, without touching its neighbours', async () => {
        // `keep: 1` rather than `keep: yes` on purpose — YAML 1.2, which this
        // parser speaks, reads `yes` as the STRING "yes"; only 1.1 made it a
        // boolean. A test that trips over that is testing the spec, not the
        // delete.
        const out = await write('c.yml', 'title: old\ndraft: true\nkeep: 1\n', { draft: null })
        const parsed = YAML.parse(out)
        assert.equal('draft' in parsed, false)
        assert.equal(parsed.title, 'old')
        assert.equal(parsed.keep, 1)
    })

    it('carries every document of a multi-document file through', async () => {
        // `---` between documents reads as front matter to the detector, so
        // consulting it sent exactly these files down the wrong path. And
        // parseDocument returns one carrying errors here, which throws on
        // stringify — a refusal where a patch was possible.
        const out = await write('multi.yml', '---\ntitle: old\n---\nsecond: doc\n', { title: 'new' })
        const documents = YAML.parseAllDocuments(out)
        assert.equal(documents.length, 2, 'the second document is still there')
        assert.equal(documents[0].toJS().title, 'new')
        assert.equal(documents[1].toJS().second, 'doc')
    })

    it('does not mistake a leading document marker for front matter', async () => {
        const out = await write('marker.yml', '---\ntitle: old\nkeep: 1\n', { title: 'new' })
        assert.equal(YAML.parse(out).keep, 1)
    })

    it('starts a fresh file cleanly', async () => {
        const uri = path.join(dir, 'new.yml')
        await writeEntity({ uri }, { title: 'first' })
        assert.equal(YAML.parse(await readFile(uri, 'utf8')).title, 'first')
    })
})

describe('front matter still behaves exactly as it did', () => {
    it('keeps the body', async () => {
        const out = await write('d.md', '---\ntitle: old\n---\n# Body\n', { title: 'new' })
        assert.match(out, /^---\ntitle: new\n---\n# Body\n$/)
    })

    it('grows a block on a file that has none', async () => {
        const out = await write('e.md', '# Just a body\n', { title: 'new' })
        assert.match(out, /^---\ntitle: new\n---\n# Just a body\n$/)
    })

    it('writes the body alone when the last key is removed', async () => {
        const out = await write('f.md', '---\ntitle: old\n---\n# Body\n', { title: null })
        assert.equal(out, '# Body\n')
    })
})

describe('JSON', () => {
    it('round-trips at the indent the file already used', async () => {
        const out = await write('g.json', '{\n    "title": "old",\n    "keep": 1\n}\n', { title: 'new' })
        assert.match(out, /^\{\n {4}"title": "new"/, 'four spaces, as it found them')
        assert.equal(JSON.parse(out).keep, 1)
    })
})

describe('the registry', () => {
    it('lets a format plugin claim its own sources without editing this file', async () => {
        const off = registerSourceFormat('shouty', {
            test: (entity) => entity?.format === 'shouty',
            write: ({ patch }) => `SHOUTY:${JSON.stringify(patch)}`,
        })
        try {
            const out = await write('h.shouty', 'ignored', { title: 'new' }, { format: 'shouty' })
            assert.equal(out, 'SHOUTY:{"title":"new"}')
        } finally { off() }
    })

    it('checks the newest registration first and the catch-all last', async () => {
        assert.equal(sourceFormatFor({ format: 'yml' }).name, 'yaml')
        assert.equal(sourceFormatFor({ format: 'json' }).name, 'json')
        assert.equal(sourceFormatFor({ format: 'md' }).name, 'front-matter')
        assert.equal(sourceFormatFor({}).name, 'front-matter', 'unknown formats fall through')
    })

    it('falls back to the extension when the catalog recorded no format', async () => {
        // A caller holding only a uri is one this still has to answer for.
        assert.equal(sourceFormatFor({ uri: '/x/y.yaml' }).name, 'yaml')
        assert.equal(sourceFormatFor({ uri: '/x/y.json' }).name, 'json')
    })
})

// Whether a proposed source still parses, asked before it lands.
//
// This is the guarantee a whole-file write cannot offer: a model that emits
// invalid YAML for a 900-line file is found out at the next build, by which
// time the file is already on disk. An edit that can be checked first can be
// refused instead.
describe('validateSource', () => {
    it('passes what parses and names what does not', () => {
        assert.equal(validateSource({ format: 'yml' }, 'a: 1\n'), null)
        assert.match(validateSource({ format: 'yml' }, 'a: [1\n b: 2\n') ?? '', /\S/)
        assert.equal(validateSource({ format: 'json' }, '{"a":1}'), null)
        assert.match(validateSource({ format: 'json' }, '{"a":') ?? '', /\S/)
    })

    it('says nothing about a format it has no parser for', () => {
        // The answer to "is this valid" for a stylesheet is not this module's
        // to give, and inventing one would refuse edits it cannot judge.
        assert.equal(validateSource({ format: 'css' }, 'body{'), null)
        assert.equal(validateSource({ format: 'liquid' }, '{% if %}'), null)
    })

    it('checks the front-matter block and ignores the body', () => {
        assert.equal(validateSource({ format: 'md' }, '---\ntitle: x\n---\n# anything { at all\n'), null)
    })
})

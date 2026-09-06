// An entity whose source is fetched, not read off the disk.
//
// mikser-io-csv pulls rows over http and gives the entity a `uri` of
// `https://…`. mikser_explain ran a filesystem checksum over that, got ENOENT,
// and reported `error: "file is gone"` — from which its verdict concluded:
//
//   "source file is gone — a build would DELETE this entity and unlink its
//    output"
//
// about an entity in perfect health. That is worse than a wrong checksum: it
// tells the reader a build is about to destroy something, and the obvious
// response is to go and "rescue" a file that never existed.
//
// Whether the REMOTE moved is a fair question, and not one a local checksum
// can answer. Answering it properly would put a network fetch inside a
// read-only explain, so the comparison is declined out loud instead.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { explain } from '../../src/explain.js'
import { isLocalUri, uriScheme } from '../../src/utils/index.js'

let priorCatalog
const catalogOf = (entities) => ({
    byId: new Map(entities.map(e => [e.id, e])),
    entities,
    findEntities: async () => entities,
})

beforeEach(() => { priorCatalog = runtime.catalog })
afterEach(() => { runtime.catalog = priorCatalog })

describe('uriScheme / isLocalUri', () => {
    it('treats no scheme and file:// as local, everything else as not', () => {
        assert.equal(isLocalUri('/srv/premium/documents/a.md'), true)
        assert.equal(isLocalUri('file:///srv/premium/documents/a.md'), true)
        assert.equal(isLocalUri('https://example.com/prices.csv'), false)
        assert.equal(isLocalUri('gdrive://folder/sheet'), false)
    })

    it('names the scheme, lowercased', () => {
        assert.equal(uriScheme('HTTPS://example.com/x.csv'), 'https')
        assert.equal(uriScheme('/plain/path.md'), null)
        assert.equal(uriScheme(undefined), null)
    })
})

describe('explaining a provider-backed entity', () => {
    const remote = {
        id: '/data/prices.csv',
        collection: 'data',
        uri: 'https://example.com/prices.csv',
        checksum: 'abc123',
    }

    it('does not claim the file is gone', async () => {
        runtime.catalog = catalogOf([remote])
        const report = await explain('/data/prices.csv')
        assert.equal(report.found, true)
        assert.notEqual(report.source?.error, 'file is gone')
        assert.doesNotMatch(report.verdict, /would DELETE this entity/,
            `a healthy remote entity must not be described as about to be deleted\n${report.verdict}`)

        // And it must say what IS true, not merely fail to say something
        // false: silence here would leave the reader with "never rendered",
        // which explains nothing about a source they cannot find on disk.
        assert.match(report.verdict, /fetched over https/,
            `the verdict must name how the source is obtained\n${report.verdict}`)
        assert.match(report.verdict, /no local file was compared/,
            `and say plainly that no comparison was made\n${report.verdict}`)
    })

    it('says the source is remote, and which scheme fetches it', async () => {
        runtime.catalog = catalogOf([remote])
        const { source } = await explain('/data/prices.csv')
        assert.equal(source.remote, true)
        assert.equal(source.scheme, 'https')
        assert.equal(source.catalogChecksum, 'abc123')
    })

    it('states why no comparison was made, rather than leaving differs absent', async () => {
        // Absent would read as false to anything checking truthiness — the
        // exact ambiguity that made the old `active` flag misleading.
        runtime.catalog = catalogOf([remote])
        const { source } = await explain('/data/prices.csv')
        assert.equal('differs' in source, false, 'no differs, because none was computed')
        assert.match(source.notCompared, /no local file/)
        assert.equal('fileChecksum' in source, false, 'and no file hash it never read')
    })

    it('still compares a local entity exactly as before', async () => {
        // The change must not cost the ordinary case its answer.
        runtime.catalog = catalogOf([{
            id: '/documents/a.md', collection: 'documents',
            uri: '/definitely/not/here.md', checksum: 'abc',
        }])
        const { source } = await explain('/documents/a.md')
        assert.equal(source.remote, undefined)
        assert.equal(source.error, 'file is gone', 'a local file that is really gone still reports so')
    })
})

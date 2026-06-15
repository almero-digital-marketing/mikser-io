// Regression test for the cross-emitter delete sweep.
//
// Before the fix, every file source's onLoaded sweep deleted all
// catalog entities in its target collection that weren't present
// on disk — including entities emitted by OTHER plugins (CSV row
// fan-out, gdrive sync, API-injected docs, …) that happen to live
// in the same collection. That class of entity was silently wiped
// on every cycle.
//
// The fix scopes the sweep to entities whose `uri` is rooted at the
// caller's `ownerPrefix` (the absolute folder this source owns).
// Foreign-emitter entities have a different `uri` shape (synthetic
// rows: empty, gdrive: gdrive://…, HTTP-pulled CSV parent: https://…)
// and are excluded by the LIKE clause.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import realRuntime from '../../src/runtime.js'
import { sweepDeleted } from '../../src/source.js'

describe('sweepDeleted: cross-emitter ownership', () => {
    it('requires ownerPrefix — refuses to run unscoped', async () => {
        await assert.rejects(
            sweepDeleted('documents', new Set(), async () => {}),
            /ownerPrefix is required/,
        )
    })

    it('leaves foreign-emitter entities alone (no db, fallback path)', async () => {
        const ownerFolder = '/tmp/docs-test'

        // Three entities, same collection, three different ownership shapes:
        //   - file-sourced from this folder (sweep target)
        //   - CSV fan-out row (synthetic, uri empty)
        //   - HTTP-fetched CSV parent (uri = https://…)
        //   - file-sourced from a DIFFERENT folder (some other source)
        const entities = [
            { id: '/documents/orphan.md', collection: 'documents', uri: `${ownerFolder}/orphan.md` },
            { id: '/documents/keep.md',   collection: 'documents', uri: `${ownerFolder}/keep.md`   },
            { id: '/authors/dr-pragma',   collection: 'documents', uri: '' },
            { id: '/csv-remote/x.csv',    collection: 'documents', uri: 'https://example.com/x.csv' },
            { id: '/from-other-source',   collection: 'documents', uri: '/tmp/other-folder/doc.md' },
        ]

        // Wire the catalog stub the harness uses, minus the full harness
        // (we only need findEntities for the fallback path).
        realRuntime.catalog = {
            byId: new Map(entities.map(e => [e.id, e])),
            version: 'test',
            cacheInvalidated: false,
            save: async () => {},
        }
        realRuntime.options = { workingFolder: '/tmp', plugins: [] }

        // Sweep what the file source saw — only `keep.md` was on disk.
        const scanned = new Set(['/documents/keep.md'])
        const deleted = []
        const count = await sweepDeleted(
            'documents',
            scanned,
            async (e) => { deleted.push(e.id) },
            ownerFolder,
        )

        assert.equal(count, 1, 'exactly one entity should be deleted')
        assert.deepEqual(deleted, ['/documents/orphan.md'])

        // The critical assertions — CSV-emitted entities (synthetic
        // and HTTP-fetched parent) AND other sources' entities must
        // all survive the sweep.
        assert.ok(!deleted.includes('/authors/dr-pragma'),
            'CSV row entity (empty uri) must not be swept')
        assert.ok(!deleted.includes('/csv-remote/x.csv'),
            'HTTP-fetched CSV parent (foreign scheme) must not be swept')
        assert.ok(!deleted.includes('/from-other-source'),
            'entity owned by a different source folder must not be swept')
    })

    it('handles ownerPrefix with or without trailing slash identically', async () => {
        const entities = [
            { id: '/a', collection: 'docs', uri: '/tmp/foo/a.md' },
            { id: '/b', collection: 'docs', uri: '/tmp/foo/b.md' },
        ]
        realRuntime.catalog = {
            byId: new Map(entities.map(e => [e.id, e])),
            version: 'test',
            cacheInvalidated: false,
            save: async () => {},
        }
        realRuntime.options = { workingFolder: '/tmp', plugins: [] }

        const ranWithSlash    = []
        const ranWithoutSlash = []
        await sweepDeleted('docs', new Set(), async e => ranWithSlash.push(e.id),    '/tmp/foo/')
        await sweepDeleted('docs', new Set(), async e => ranWithoutSlash.push(e.id), '/tmp/foo')

        assert.deepEqual(ranWithSlash.sort(), ['/a', '/b'])
        assert.deepEqual(ranWithoutSlash.sort(), ['/a', '/b'])
    })

    it('does not run when --force is set (operator owns the rebuild)', async () => {
        const entities = [
            { id: '/orphan', collection: 'docs', uri: '/tmp/owned/orphan.md' },
        ]
        realRuntime.catalog = {
            byId: new Map(entities.map(e => [e.id, e])),
            version: 'test',
            cacheInvalidated: false,
            save: async () => {},
        }
        realRuntime.options = { workingFolder: '/tmp', plugins: [], force: true }

        const deleted = []
        const count = await sweepDeleted('docs', new Set(), async e => deleted.push(e.id), '/tmp/owned')
        assert.equal(count, 0)
        assert.equal(deleted.length, 0)

        // Clean up so the next test isn't seeing force=true.
        realRuntime.options.force = false
    })
})

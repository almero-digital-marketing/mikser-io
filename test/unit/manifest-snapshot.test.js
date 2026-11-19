// A snapshot is finished the moment the render entry is read, and it keeps
// nothing of the entity it was read from.
//
// Both halves are the fix for an OOM. The finalize drain used to keep the
// whole journal entry per render — entity, deps and all — because the output
// hash could not be known until a later async pass, and `buildSnapshot` took
// that hash as an argument. On a full rebuild of 19k renders averaging 84 KB
// a row that list was ~1.6 GB held across a filesystem walk, and the process
// died in it on a 4 GB heap (gpointpremium.com, 19.11.2026).
//
// So the hash became the one field a caller attaches afterwards, and what the
// drain carries is this — which is only worth carrying if it is genuinely
// SEPARATE from the entity. A snapshot that shared so much as the meta object
// would pin the entity behind it and the drain would be back where it was,
// with nothing in the output to say so.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { buildSnapshot } from '../../src/manifest/snapshot.js'

const makeEntity = () => ({
    id: '/documents/post',
    destination: '/post/index.html',
    collection: 'documents',
    // The weight, and the thing that must not survive into the snapshot.
    content: 'x'.repeat(4096),
    checksum: 'abc123',
    meta: {
        layout: 'post',
        title: 'A post',
        $author: '/authors/ann',
        tags: ['one', 'two'],
    },
})

describe('buildSnapshot', () => {
    beforeEach(() => {
        // Shaped, not seeded: buildRefClosure resolves $-refs through the
        // catalog, and an empty one sends it down the conservative path.
        runtime.catalog = { byId: new Map() }
    })

    it('is complete without an output hash, and says so by leaving the key out', () => {
        const snapshot = buildSnapshot(makeEntity(), [], ['layouts/post.hbs'], [['/data/site', ['title']]], 'layouts')

        assert.equal('outputHash' in snapshot, false,
            'a file that has not been hashed yet is not a file whose hash is null')
        assert.deepEqual(snapshot.metaReads, ['layouts/post.hbs'])
        assert.deepEqual(snapshot.consumedReads, [['/data/site', ['title']]])
        assert.equal(snapshot.dispatcher, 'layouts')
        assert.ok(snapshot.inputHash, 'the inputs are hashed here, not later')
        assert.ok(snapshot.inputParts?.content, 'and per part, so a later run can name which one moved')
    })

    it('shares no object with the entity, so holding it does not hold the entity', () => {
        const entity = makeEntity()
        const snapshot = buildSnapshot(entity, [{ kind: 'ref', target: '/authors/ann', hash: 'h' }], [], [], null)

        const reachable = new Set()
        const walk = (value) => {
            if (!value || typeof value !== 'object' || reachable.has(value)) return
            reachable.add(value)
            for (const key of Object.keys(value)) walk(value[key])
        }
        walk(snapshot)

        for (const [what, object] of [['the entity', entity], ['its meta', entity.meta],
            ['its tags', entity.meta.tags]]) {
            assert.equal(reachable.has(object), false, `the snapshot reaches ${what}`)
        }
    })

    it('records what the content hashes to, never the content', () => {
        const entity = makeEntity()
        const snapshot = buildSnapshot(entity, [], [], [], null)

        assert.equal(JSON.stringify(snapshot).includes(entity.content), false,
            'the body of every page in the corpus would be in the drain again')
    })

    it('is unaffected by anything done to the entity afterwards', () => {
        const entity = makeEntity()
        const snapshot = buildSnapshot(entity, [], [], [], null)
        const before = JSON.stringify(snapshot)

        entity.destination = '/somewhere/else.html'
        entity.meta.title = 'Renamed'
        entity.content = ''

        assert.equal(JSON.stringify(snapshot), before)
    })
})

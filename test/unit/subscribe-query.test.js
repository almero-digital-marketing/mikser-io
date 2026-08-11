// runtime.refs.subscribeQuery — filter-based subscription primitive.
//
// Peer to subscribeGraph: instead of walking the inverse-ref graph
// rooted at filter-matching entities, subscribeQuery fires per
// mutation that matches a sift expression. Backs live-data dashboards
// (SDK consumers) and the preview plugin's per-cache invalidation.
//
// This file covers the dispatch semantics in isolation — registration,
// per-mutation matching, signal-driven dispose, error isolation.
// Integration with the engine's onPersist hook is exercised via the
// smoke fixture.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createQuerySubscribers } from '../../src/refs.js'

describe('createQuerySubscribers', () => {

    it('fires onAffected once per matching mutation', async () => {
        const subs = createQuerySubscribers()
        const calls = []
        subs.add({
            filter: { collection: 'posts' },
            onAffected: ({ mutated }) => calls.push(mutated.id),
        })
        await subs.dispatch([
            { id: '/posts/a', collection: 'posts' },
            { id: '/posts/b', collection: 'posts' },
            { id: '/authors/x', collection: 'authors' },
        ])
        assert.deepEqual(calls.sort(), ['/posts/a', '/posts/b'])
    })

    it('multiple subscribers see independent matches', async () => {
        const subs = createQuerySubscribers()
        const postsCalls = []
        const draftCalls = []
        subs.add({
            filter: { collection: 'posts' },
            onAffected: ({ mutated }) => postsCalls.push(mutated.id),
        })
        subs.add({
            filter: { 'meta.status': 'draft' },
            onAffected: ({ mutated }) => draftCalls.push(mutated.id),
        })
        await subs.dispatch([
            { id: '/posts/a', collection: 'posts', meta: { status: 'published' } },
            { id: '/posts/b', collection: 'posts', meta: { status: 'draft' } },
            { id: '/authors/x', collection: 'authors', meta: { status: 'draft' } },
        ])
        assert.deepEqual(postsCalls.sort(), ['/posts/a', '/posts/b'])
        assert.deepEqual(draftCalls.sort(), ['/authors/x', '/posts/b'])
    })

    it('sift operators ($in, $regex, $or) work in filters', async () => {
        const subs = createQuerySubscribers()
        const hits = []
        subs.add({
            filter: { 'meta.tags': { $in: ['featured', 'editor-pick'] } },
            onAffected: ({ mutated }) => hits.push(mutated.id),
        })
        await subs.dispatch([
            { id: '/a', meta: { tags: ['ordinary'] } },
            { id: '/b', meta: { tags: ['featured', 'ordinary'] } },
            { id: '/c', meta: { tags: ['editor-pick'] } },
        ])
        assert.deepEqual(hits.sort(), ['/b', '/c'])
    })

    it('dispose() removes a subscriber from future dispatches', async () => {
        const subs = createQuerySubscribers()
        const hits = []
        const handle = subs.add({
            filter: { collection: 'posts' },
            onAffected: ({ mutated }) => hits.push(mutated.id),
        })
        await subs.dispatch([{ id: '/posts/a', collection: 'posts' }])
        handle.dispose()
        await subs.dispatch([{ id: '/posts/b', collection: 'posts' }])
        assert.deepEqual(hits, ['/posts/a'])
    })

    it('signal abort disposes the subscriber', async () => {
        const subs = createQuerySubscribers()
        const hits = []
        const ac = new AbortController()
        subs.add({
            filter: { collection: 'posts' },
            onAffected: ({ mutated }) => hits.push(mutated.id),
            signal: ac.signal,
        })
        await subs.dispatch([{ id: '/posts/a', collection: 'posts' }])
        ac.abort()
        await subs.dispatch([{ id: '/posts/b', collection: 'posts' }])
        assert.deepEqual(hits, ['/posts/a'])
    })

    it('pre-aborted signal makes add() a no-op for future dispatches', async () => {
        const subs = createQuerySubscribers()
        const hits = []
        const ac = new AbortController()
        ac.abort()
        subs.add({
            filter: { collection: 'posts' },
            onAffected: ({ mutated }) => hits.push(mutated.id),
            signal: ac.signal,
        })
        await subs.dispatch([{ id: '/posts/a', collection: 'posts' }])
        assert.deepEqual(hits, [])
    })

    it('handler error in one subscriber does not block others', async () => {
        const subs = createQuerySubscribers()
        const good = []
        subs.add({
            filter: { collection: 'posts' },
            onAffected: () => { throw new Error('handler boom') },
        })
        subs.add({
            filter: { collection: 'posts' },
            onAffected: ({ mutated }) => good.push(mutated.id),
        })
        await subs.dispatch([{ id: '/posts/a', collection: 'posts' }])
        assert.deepEqual(good, ['/posts/a'])
    })

    it('empty mutation list and empty subscriber set are both no-ops', async () => {
        const subs = createQuerySubscribers()
        await subs.dispatch([])
        // no throw → ok
        subs.add({ filter: {}, onAffected: () => {} })
        await subs.dispatch([])
        // no throw → ok
    })
})


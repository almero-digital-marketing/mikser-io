import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import apiPlugin, { sendRenderOutput } from '../../../src/plugins/api.js'
import { createHarness } from '../plugin-harness.js'

// Lightweight fake of the Express `res` object — captures enough state for
// assertions without spinning up a server.
function createFakeRes() {
    const captured = { type: null, status: 200, sent: undefined, sentFile: null }
    const res = {
        type(t) { captured.type = t; return res },
        status(s) { captured.status = s; return res },
        send(body) { captured.sent = body; return res },
        sendFile(p) { captured.sentFile = p; return res },
        json(obj) { captured.type ??= 'application/json'; captured.sent = obj; return res },
    }
    return { res, captured }
}

describe('api plugin: sendRenderOutput', () => {
    it('responds 204 when output is null', async () => {
        const { res, captured } = createFakeRes()
        await sendRenderOutput(res, null, { destination: '/x.html' })
        assert.equal(captured.status, 204)
    })

    it('responds 204 when output.result is null', async () => {
        const { res, captured } = createFakeRes()
        await sendRenderOutput(res, { result: null }, { destination: '/x.html' })
        assert.equal(captured.status, 204)
    })

    it('sends a Buffer with application/pdf when destination is .pdf', async () => {
        const pdfBytes = Buffer.from('%PDF-1.4\n...')
        const { res, captured } = createFakeRes()
        await sendRenderOutput(res, { result: pdfBytes }, { destination: '/en/report.pdf' })
        assert.equal(captured.type, 'application/pdf')
        assert.equal(captured.sent, pdfBytes)
    })

    it('sends a string as text/html when destination is .html', async () => {
        const html = '<!doctype html><h1>Hi</h1>'
        const { res, captured } = createFakeRes()
        await sendRenderOutput(res, { result: html }, { destination: '/page.html' })
        assert.match(captured.type, /text\/html/)
        assert.equal(captured.sent, html)
    })

    it('sends a string with no MIME for an unknown destination ext', async () => {
        const text = 'some content'
        const { res, captured } = createFakeRes()
        await sendRenderOutput(res, { result: text }, { destination: '/raw.bizarro' })
        assert.equal(captured.type, null)
        assert.equal(captured.sent, text)
    })

    it('streams a real file when the string output is an existing path', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-rest-'))
        try {
            const file = path.join(dir, 'out.html')
            await writeFile(file, '<p>ok</p>')
            const { res, captured } = createFakeRes()
            await sendRenderOutput(res, { result: file }, { destination: '/x.html' })
            assert.equal(captured.sentFile, file)
            assert.equal(captured.sent, undefined)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('falls back to send() when a path-shaped string does not exist', async () => {
        const phantom = '/this/path/does/not/exist-xyz123.html'
        const { res, captured } = createFakeRes()
        await sendRenderOutput(res, { result: phantom }, { destination: '/x.html' })
        assert.equal(captured.sentFile, null)
        assert.equal(captured.sent, phantom)
    })

    it('sends arbitrary objects as JSON', async () => {
        const obj = { ok: true, n: 1 }
        const { res, captured } = createFakeRes()
        await sendRenderOutput(res, { result: obj }, { destination: '/r.json' })
        assert.deepEqual(captured.sent, obj)
    })
})

describe('api plugin: registration', () => {
    it('loads and registers onLoaded without requiring express up front', () => {
        const h = createHarness()
        assert.doesNotThrow(() => apiPlugin(h.core))
        assert.equal(h.hooks.loaded.length, 1)
    })

    it('mounts on an externally-provided express app', async () => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({ options: { app } })
        apiPlugin(h.core)
        await assert.doesNotReject(() => h.runHook('loaded'))
    })

    it('fails fast with an actionable error if no runtime.options.app is present', async () => {
        const h = createHarness()                       // no `app` on options
        apiPlugin(h.core)
        await assert.rejects(
            () => h.runHook('loaded'),
            /API plugin requires runtime\.options\.app.*--server.*setup/s,
        )
    })
})

// End-to-end: actually start a small HTTP server, POST to /render, verify
// the response shape. Exercises the queue, hook plumbing, MIME selection,
// and the Buffer path through sendRenderOutput in one go.
describe('api plugin: /render endpoint (integration)', () => {
    it('returns a Buffer with application/pdf for a pdf entity', async () => {
        const { default: express } = await import('express')
        const app = express()

        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-rest-pdf',
                outputFolder: '/tmp/mikser-rest-pdf/out',
            },
            config: { api: { endpoints: { default: { operations: ['render'] } } } },
        })

        // The API `/render` handler kicks off `runtime.process()` and waits
        // for a `completed` hook whose entry's entity carries the correlation
        // id. Simulate the lifecycle by overriding process() to find the
        // queued update and immediately fire the completed hook with a fake
        // PDF buffer.
        const pdfBytes = Buffer.from('%PDF-1.4\nfake pdf\n')
        h.runtime.process = async () => {
            const lastUpdate = [...h.journal].reverse().find(e => e.operation === 'update')
            if (!lastUpdate) return
            const entry = {
                entity: { ...lastUpdate.entity, destination: '/en/report.pdf' },
                output: { success: true, result: pdfBytes },
            }
            for (const cb of [...h.runtime.hooks.completed]) await cb(entry)
        }
        // The harness uses `hooks.complete` (no past-tense alias). Make
        // `hooks.completed` point at the same array so the plugin and the
        // fake process() see the same registrations.
        h.runtime.hooks.completed = h.runtime.hooks.complete

        apiPlugin(h.core)
        await h.runHook('loaded')

        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        try {
            const { port } = server.address()
            const response = await fetch(`http://127.0.0.1:${port}/api/default/render`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    id: '/documents/en/report.md',
                    collection: 'documents',
                    type: 'document',
                }),
            })

            assert.equal(response.status, 200)
            assert.match(response.headers.get('content-type') ?? '', /application\/pdf/)
            const body = Buffer.from(await response.arrayBuffer())
            assert.deepEqual(body, pdfBytes)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('coalesces concurrent /render requests into one cycle and resolves each by correlation id', async () => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-rest-batch',
                outputFolder: '/tmp/mikser-rest-batch/out',
            },
            config: { api: { endpoints: { default: { operations: ['render'] } } } },
        })

        // The plugin pipelines requests into the *next* cycle: anything
        // arriving while a cycle is running queues up and is processed
        // together once it finishes. Make process() take some real time so
        // the 5 concurrent fetches stack up while cycle 1 is busy with the
        // first one.
        let cycleInvocations = 0
        h.runtime.process = async () => {
            cycleInvocations++
            await new Promise(r => setTimeout(r, 40))
            const updates = h.journal.filter(e => e.operation === 'update')
            for (const upd of updates) {
                const entry = {
                    entity: { ...upd.entity, destination: '/en/report.pdf' },
                    output: {
                        success: true,
                        result: Buffer.from(`PDF for ${upd.entity.id}`),
                    },
                }
                for (const cb of [...h.runtime.hooks.completed]) await cb(entry)
            }
            h.journal.length = 0
        }
        h.runtime.hooks.completed = h.runtime.hooks.complete

        apiPlugin(h.core)
        await h.runHook('loaded')

        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        try {
            const { port } = server.address()
            const ids = ['/docs/a.md', '/docs/b.md', '/docs/c.md', '/docs/d.md', '/docs/e.md']
            const responses = await Promise.all(
                ids.map(id => fetch(`http://127.0.0.1:${port}/api/default/render`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ id, collection: 'documents', type: 'document' }),
                }))
            )

            const bodies = await Promise.all(responses.map(r => r.arrayBuffer()))
            for (let i = 0; i < ids.length; i++) {
                assert.equal(responses[i].status, 200)
                assert.match(responses[i].headers.get('content-type') ?? '', /application\/pdf/)
                assert.equal(Buffer.from(bodies[i]).toString(), `PDF for ${ids[i]}`)
            }

            // The pipelining invariant: the number of process() invocations
            // is strictly smaller than the number of requests (otherwise
            // we'd just have N parallel cycles, which is what we set out
            // to avoid).
            assert.ok(cycleInvocations < ids.length,
                `expected fewer cycles than requests, got ${cycleInvocations} cycles for ${ids.length} requests`)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('returns 500 "Render timeout" when the cycle hangs past renderTimeout', async () => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-rest-to',
                outputFolder: '/tmp/mikser-rest-to/out',
            },
            config: { api: { renderTimeout: 50, endpoints: { default: { operations: ['render'] } } } },
        })
        // process() never resolves — simulates a hung cycle. Per-request
        // timer fires first and rejects the promise with "Render timeout".
        h.runtime.process = () => new Promise(() => { })
        h.runtime.hooks.completed = h.runtime.hooks.complete

        apiPlugin(h.core)
        await h.runHook('loaded')

        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        try {
            const { port } = server.address()
            const response = await fetch(`http://127.0.0.1:${port}/api/default/render`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: '/docs/x.md' }),
            })
            assert.equal(response.status, 500)
            const body = await response.json()
            assert.match(body.error, /Render timeout/)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('control flags live under body.options; the rest is treated as the entity', async () => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-rest-options',
                outputFolder: '/tmp/mikser-rest-options/out',
            },
            config: { api: { endpoints: { default: { operations: ['render'] } } } },
        })

        // Capture the entity that the renderer was actually asked to
        // process — we want to assert that body.options.save:false ends
        // up as entity.options.save:false (set by useRenderer when
        // explicitly opting out), and that other body.options fields
        // (catalog: false in particular) don't leak onto entity.options
        // as stray engine flags.
        let submitted
        h.runtime.update = async (entity) => { submitted = entity }
        h.runtime.process = async () => {
            for (const cb of [...h.runtime.hooks.completed]) {
                await cb({ entity: submitted, output: { result: 'OK' } })
            }
        }
        h.runtime.hooks.completed = h.runtime.hooks.complete

        apiPlugin(h.core)
        await h.runHook('loaded')

        const server = await new Promise(r => { const s = app.listen(0, () => r(s)) })
        try {
            const { port } = server.address()
            await fetch(`http://127.0.0.1:${port}/api/default/render`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    id: '/docs/x.md',
                    collection: 'documents',
                    options: { save: false, catalog: false },
                }),
            })
            assert.equal(submitted.id, '/docs/x.md')
            assert.equal(submitted.collection, 'documents')
            assert.equal(submitted.options.save, false, 'options.save:false should propagate to entity.options.save')
            assert.equal('catalog' in submitted.options, false, 'options.catalog should not leak onto entity.options (handled via splice, not stamp)')
            assert.ok(submitted.options.correlationId, 'useRenderer should set its own correlationId')
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('returns 500 "did not complete" when the cycle finishes without firing the entity\'s hook', async () => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-rest-nc',
                outputFolder: '/tmp/mikser-rest-nc/out',
            },
            config: { api: { endpoints: { default: { operations: ['render'] } } } },
        })
        // Cycle finishes immediately, but the completed hook is never fired
        // for this entity (e.g. no layout matched, or the renderer failed
        // and the postprocess phase skipped it).
        h.runtime.process = async () => { /* no-op */ }
        h.runtime.hooks.completed = h.runtime.hooks.complete

        apiPlugin(h.core)
        await h.runHook('loaded')

        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        try {
            const { port } = server.address()
            const response = await fetch(`http://127.0.0.1:${port}/api/default/render`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: '/docs/x.md' }),
            })
            assert.equal(response.status, 500)
            const body = await response.json()
            assert.match(body.error, /did not complete/)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })
})

// Verifies the new multi-endpoint shape: per-endpoint token, per-endpoint
// query scope on list, and the operations allowlist with 403 on disallowed
// ops / 401 on missing-or-wrong token.
describe('api plugin: per-endpoint auth + scope', () => {
    async function mount({ endpoints, entities = [] }) {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: { app, workingFolder: '/tmp/mikser-rest-ep', outputFolder: '/tmp/mikser-rest-ep/out' },
            config: { api: { endpoints } },
            entities,
        })
        apiPlugin(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port, h }
    }

    it('public endpoint with query scope filters the list', async () => {
        const { server, port } = await mount({
            endpoints: {
                public: {
                    query: (e) => e.meta?.published === true,
                    operations: ['list'],
                },
            },
            entities: [
                { id: '/a.md', type: 'document', meta: { published: true } },
                { id: '/b.md', type: 'document', meta: { published: false } },
                { id: '/c.md', type: 'document', meta: { published: true } },
            ],
        })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities`)
            assert.equal(res.status, 200)
            const body = await res.json()
            assert.equal(body.total, 2)
            assert.deepEqual(body.items.map((i) => i.id).sort(), ['/a.md', '/c.md'])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('returns 403 when the requested operation is not in the allowlist', async () => {
        const { server, port } = await mount({
            endpoints: {
                readonly: { operations: ['list'] },
            },
        })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/readonly/entities`, {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ collection: 'documents', relativePath: 'x.md' }),
            })
            assert.equal(res.status, 403)
            const body = await res.json()
            assert.match(body.error, /not allowed/i)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('subscribe is opt-in for public endpoints — 403 by default', async () => {
        // Public endpoint with default operations (['list']) — subscribe
        // is NOT included unless explicitly listed. Each open SSE
        // connection holds resources, so the safe default is to require
        // opt-in.
        const { server, port } = await mount({
            endpoints: {
                pub: {}, // public; defaults to ['list'] only
            },
        })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/pub/entities/subscribe`)
            assert.equal(res.status, 403)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('subscribe opens an SSE stream and emits an init event when enabled', async () => {
        const { server, port } = await mount({
            endpoints: {
                live: { operations: ['list', 'subscribe'] },
            },
        })
        try {
            const ac = new AbortController()
            const res = await fetch(`http://127.0.0.1:${port}/api/live/entities/subscribe`, {
                signal: ac.signal,
            })
            assert.equal(res.status, 200)
            assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

            // Read just the first event block (init), then abort.
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let firstBlock = null
            while (firstBlock == null) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                const sep = buffer.indexOf('\n\n')
                if (sep >= 0) firstBlock = buffer.slice(0, sep)
            }
            ac.abort()

            assert.ok(firstBlock, 'received at least one SSE event block')
            assert.match(firstBlock, /event:\s*init/)
            assert.match(firstBlock, /"subscriptionId"\s*:\s*"sub_/)
            assert.match(firstBlock, /"endpoint"\s*:\s*"live"/)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('honors mikser\'s uniform auth rule: valid token passes; wrong token 401s; absent token passes from loopback', async () => {
        // Uniform rule (v7.8.0+): a request is allowed if EITHER it
        // presents a valid token OR it comes from loopback. A wrong
        // token signals intent to authenticate and is rejected even
        // from loopback. The test runs against 127.0.0.1 so loopback
        // bypass applies — that's the canonical local-dev shape.
        const { server, port } = await mount({
            endpoints: {
                admin: { token: 's3cret', operations: ['list'] },
            },
        })
        try {
            // No header from loopback → allowed (trusted-host fallback)
            const noAuth = await fetch(`http://127.0.0.1:${port}/api/admin/entities`)
            assert.equal(noAuth.status, 200, 'absent token from loopback should pass under reading B')

            // Wrong header even from loopback → 401 (intent to authenticate, must validate)
            const wrong = await fetch(`http://127.0.0.1:${port}/api/admin/entities`, {
                headers: { authorization: 'Bearer nope' },
            })
            assert.equal(wrong.status, 401)

            // Valid token → 200 from anywhere
            const ok = await fetch(`http://127.0.0.1:${port}/api/admin/entities`, {
                headers: { authorization: 'Bearer s3cret' },
            })
            assert.equal(ok.status, 200)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })
})

// Verifies the sift-backed query features on /entities and the body-based
// /entities/query route: comparison operators, $in, sort, projection, and
// $and/$or composition. The endpoint's scope still ANDs as the outer filter.
describe('api plugin: rich queries (GET operators + POST /entities/query)', () => {
    async function mountWithEntities(entities, endpoints = { open: {} }) {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: { app, workingFolder: '/tmp/mikser-rest-q', outputFolder: '/tmp/mikser-rest-q/out' },
            config: { api: { endpoints } },
            entities,
        })
        apiPlugin(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port }
    }

    const FIXTURE = [
        { id: '/a.md', type: 'document', meta: { price: 10,  published: true,  date: '2025-01-01', tags: ['x'] } },
        { id: '/b.md', type: 'document', meta: { price: 50,  published: true,  date: '2025-06-01', tags: ['y', 'x'] } },
        { id: '/c.md', type: 'document', meta: { price: 100, published: false, date: '2025-03-01', tags: ['z'] } },
        { id: '/d.md', type: 'document', meta: { price: 25,  published: true,  date: '2024-12-31', tags: [] } },
    ]

    it('GET supports comparison operators ($gt, $lt) with type coercion', async () => {
        const { server, port } = await mountWithEntities(FIXTURE)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?meta.price.$gt=20&meta.price.$lt=80`)
            assert.equal(res.status, 200)
            const body = await res.json()
            assert.equal(body.total, 2)
            assert.deepEqual(body.items.map(i => i.id).sort(), ['/b.md', '/d.md'])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('GET supports sort=-field for descending and ?fields= for projection', async () => {
        const { server, port } = await mountWithEntities(FIXTURE)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?sort=-meta.price&fields=id,meta.price&limit=2`)
            assert.equal(res.status, 200)
            const body = await res.json()
            assert.equal(body.total, 4)
            assert.deepEqual(body.items, [
                { id: '/c.md', meta: { price: 100 } },
                { id: '/b.md', meta: { price: 50 } },
            ])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('POST /entities/query supports $or, $in, and projection in one go', async () => {
        const { server, port } = await mountWithEntities(FIXTURE)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities/query`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    filter: {
                        $or: [
                            { 'meta.tags': { $in: ['z'] } },
                            { 'meta.price': { $gte: 50 } },
                        ],
                    },
                    sort: { 'meta.price': 1 },
                    fields: ['id'],
                }),
            })
            assert.equal(res.status, 200)
            const body = await res.json()
            // b (price 50, OR-match), c (tag z OR price 100), d is excluded
            assert.deepEqual(body.items, [
                { id: '/b.md' },
                { id: '/c.md' },
            ])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('endpoint query scope ANDs with the request filter', async () => {
        const { server, port } = await mountWithEntities(FIXTURE, {
            public: { query: e => e.meta?.published === true, operations: ['list'] },
        })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities?meta.price.$gte=10&sort=meta.price`)
            assert.equal(res.status, 200)
            const body = await res.json()
            assert.deepEqual(body.items.map(i => i.id), ['/a.md', '/d.md', '/b.md'])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })
})

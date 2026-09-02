import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { api, sendRenderOutput } from '../../../src/plugins/api.js'
import { bearer } from '../../../src/auth.js'
import { createHarness } from '../plugin-harness.js'
import realRuntime from '../../../src/runtime.js'

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
        assert.doesNotThrow(() => api()(h.core))
        assert.equal(h.hooks.loaded.length, 1)
    })

    it('mounts on an externally-provided express app', async () => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({ options: { app } })
        api()(h.core)
        await assert.doesNotReject(() => h.runHook('loaded'))
    })

    it('fails fast with an actionable error if no runtime.options.app is present', async () => {
        const h = createHarness()                       // no `app` on options
        api()(h.core)
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

        api({ endpoints: { default: { operations: ['render'] } } })(h.core)
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

        api({ endpoints: { default: { operations: ['render'] } } })(h.core)
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
        })
        // process() never resolves — simulates a hung cycle. Per-request
        // timer fires first and rejects the promise with "Render timeout".
        h.runtime.process = () => new Promise(() => { })
        h.runtime.hooks.completed = h.runtime.hooks.complete

        api({ renderTimeout: 50, endpoints: { default: { operations: ['render'] } } })(h.core)
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

        api({ endpoints: { default: { operations: ['render'] } } })(h.core)
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

    it('returns 422 with an actionable message when a render produces no output (no layout)', async () => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-rest-nc',
                outputFolder: '/tmp/mikser-rest-nc/out',
            },
        })
        // Cycle finishes immediately, but the completed hook is never fired
        // for this entity (e.g. no layout matched). useRenderer rejects with
        // a 422-tagged "did not complete" error.
        h.runtime.process = async () => { /* no-op */ }
        h.runtime.hooks.completed = h.runtime.hooks.complete

        api({ endpoints: { default: { operations: ['render'] } } })(h.core)
        await h.runHook('loaded')

        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        try {
            const { port } = server.address()
            const response = await fetch(`http://127.0.0.1:${port}/api/default/render`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: '/docs/x.md' }),   // no meta.layout
            })
            // Unrenderable entity → client error, not 500.
            assert.equal(response.status, 422)
            const body = await response.json()
            assert.match(body.error, /did not complete/)
            // Message names the actual cause + the fix (no-meta.layout branch).
            assert.match(body.error, /no meta\.layout and matched no layout/)
            assert.match(body.error, /layouts\.match rule/)
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
            entities,
        })
        api({ endpoints })(h.core)
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
            entities,
        })
        api({ endpoints })(h.core)
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

// Verifies the expand parameter (ADR-0007 B1-B7) on /entities (GET +
// POST) and the per-item projection of $-keys into normalized form.
describe('api plugin: expand parameter', () => {
    async function mountWithCatalog(entities) {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: { app, workingFolder: '/tmp/mikser-expand', outputFolder: '/tmp/mikser-expand/out' },
            entities,
        })
        api({ endpoints: { open: {} } })(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port }
    }

    // Reference targets resolve through three lookup keys per ADR-0007
    // A2 (hrefs primary, ids tolerated, stripped extensions accepted).
    // The fixture mixes shapes so each path exercises a different match.
    const CATALOG = [
        // Direct-id matches: ref `/authors/dick` finds this entity.
        { id: '/authors/dick',  type: 'author', meta: { name: 'Dick', $organization: '/orgs/almero' } },
        { id: '/orgs/almero',   type: 'org',    meta: { name: 'Almero Digital' } },
        { id: '/images/hero',   type: 'image',  meta: { alt: 'Hero image' } },
        { id: '/images/feat-a', type: 'image',  meta: { alt: 'Feature A' } },
        // Stripped-extension match: ref `/blog/launch` finds id `/blog/launch.md`.
        {
            id: '/blog/launch.md', type: 'document',
            meta: {
                href:     '/blog/launch',
                title:    'Launch',
                $author:  '/authors/dick',
                $hero:    '/images/hero',
                $related: ['/blog/follow-up', '/blog/missing'],
            },
        },
        { id: '/blog/follow-up.md', type: 'document', meta: { href: '/blog/follow-up', title: 'Follow up' } },
        // Landing-page entity with sections; tests `*` array iteration.
        {
            id: '/landing.md', type: 'document',
            meta: {
                href:  '/landing',
                title: 'Landing',
                sections: [
                    { type: 'hero',     $image: '/images/hero' },
                    { type: 'features', $image: '/images/feat-a' },
                ],
            },
        },
    ]

    it('expands a single one-hop ref via GET ?expand=author', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md&expand=author`)
            assert.equal(res.status, 200)
            const body = await res.json()
            const item = body.items[0]
            // Projection at the API boundary: $author becomes author.
            assert.equal(item.meta.$author, undefined)
            assert.equal(typeof item.meta.author, 'object')
            assert.equal(item.meta.author.meta.name, 'Dick')
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('expands a multi-hop chain (author.organization)', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md&expand=author.organization`)
            assert.equal(res.status, 200)
            const item = (await res.json()).items[0]
            assert.equal(item.meta.author.meta.organization.meta.name, 'Almero Digital')
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('iterates `*` segments through arrays of objects', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/landing.md&expand=sections.*.image`)
            assert.equal(res.status, 200)
            const item = (await res.json()).items[0]
            assert.equal(item.meta.sections[0].image.meta.alt, 'Hero image')
            assert.equal(item.meta.sections[1].image.meta.alt, 'Feature A')
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('expands an array-valued ref ($related)', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md&expand=related`)
            assert.equal(res.status, 200)
            const item = (await res.json()).items[0]
            assert.equal(item.meta.related.length, 2)
            assert.equal(item.meta.related[0].meta.title, 'Follow up')
            // The second entry doesn't resolve — stays as a string per
            // ADR-0007 B6.
            assert.equal(item.meta.related[1], '/blog/missing')
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('accepts both canonical and normalized path forms', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const canonical = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md&expand=$author`)
            const normalized = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md&expand=author`)
            assert.equal(canonical.status, 200)
            assert.equal(normalized.status, 200)
            const a = (await canonical.json()).items[0]
            const b = (await normalized.json()).items[0]
            assert.equal(a.meta.author.meta.name, b.meta.author.meta.name)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('combines multiple expand paths in one query', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md&expand=author,hero`)
            assert.equal(res.status, 200)
            const item = (await res.json()).items[0]
            assert.equal(item.meta.author.meta.name, 'Dick')
            assert.equal(item.meta.hero.meta.alt, 'Hero image')
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('expands via POST /entities/query body', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities/query`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    filter: { id: '/blog/launch.md' },
                    expand: ['author.organization'],
                }),
            })
            assert.equal(res.status, 200)
            const item = (await res.json()).items[0]
            assert.equal(item.meta.author.meta.organization.meta.name, 'Almero Digital')
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('always projects meta to the normalized form, even when expand is absent', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md`)
            assert.equal(res.status, 200)
            const item = (await res.json()).items[0]
            assert.equal(item.meta.$author,  undefined)            // $ stripped
            assert.equal(item.meta.author,   '/authors/dick')      // normalized, ref left as string
            assert.equal(item.meta.$hero,    undefined)
            assert.equal(item.meta.hero,     '/images/hero')
            assert.deepEqual(item.meta.related, ['/blog/follow-up', '/blog/missing'])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('returns 422 when a single expand path exceeds the default maxDepth', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md&expand=a.b.c.d.e.f`)
            assert.equal(res.status, 422)
            const body = await res.json()
            assert.match(body.error, /maxDepth/)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('returns 422 when paths list exceeds default maxPaths', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const paths = Array.from({ length: 21 }, (_, i) => `p${i}`).join(',')
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities?id=/blog/launch.md&expand=${paths}`)
            assert.equal(res.status, 422)
            const body = await res.json()
            assert.match(body.error, /maxPaths/)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('returns 422 via POST when limits are exceeded', async () => {
        const { server, port } = await mountWithCatalog(CATALOG)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/open/entities/query`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    filter: { id: '/blog/launch.md' },
                    expand: ['a.b.c.d.e.f'],
                }),
            })
            assert.equal(res.status, 422)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })
})

// Verifies ADR-0007 B9: when a GET /entities response with `expand` is
// cached, the api plugin registers a runtime.refs.subscribeGraph against
// the same (filter, expand). When that subscription's onAffected fires
// (because something in the expansion graph mutated), the api plugin
// evicts the specific cache file.
describe('api plugin: expand-cache invalidation (ADR-0007 B9)', () => {
    async function mountWithCache(entities, refsMock) {
        const { default: express } = await import('express')
        const { mkdtemp, readdir } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const tmpRoot = await mkdtemp(path.join(tmpdir(), 'mikser-expand-cache-'))

        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: tmpRoot,
                outputFolder:  tmpRoot,
            },
            entities,
        })
        // Inject the refs mock into the harness's runtime so the api
        // plugin's subscribeGraph call uses our recorder.
        h.core.runtime.refs = refsMock

        api({ endpoints: { public: { operations: ['list'], cache: true } } })(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port, tmpRoot, readdir }
    }

    const CATALOG = [
        { id: '/authors/dick',  type: 'author',   meta: { name: 'Dick', $organization: '/orgs/almero' } },
        { id: '/orgs/almero',   type: 'org',      meta: { name: 'Almero' } },
        {
            id: '/blog/launch.md', type: 'document',
            meta: {
                href:    '/blog/launch',
                title:   'Launch',
                $author: '/authors/dick',
            },
        },
    ]

    it('registers a graph subscription with the request filter + expand when the cache write happens', async () => {
        const subscribeArgs = []
        const refsMock = {
            subscribeGraph(opts) {
                subscribeArgs.push(opts)
                return { dispose: () => {} }
            },
        }
        const { server, port } = await mountWithCache(CATALOG, refsMock)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities?id=/blog/launch.md&expand=author.organization`)
            assert.equal(res.status, 200)

            assert.equal(subscribeArgs.length, 1)
            const opts = subscribeArgs[0]
            assert.deepEqual(opts.expand, ['author.organization'])
            // The filter wraps endpoint scope + the request's parsed
            // sift filter. /blog/launch.md should match; /orgs/almero
            // should not (request filtered on id).
            assert.equal(opts.filter({ id: '/blog/launch.md' }), true)
            assert.equal(opts.filter({ id: '/orgs/almero'   }), false)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('does NOT register a subscription when the request has no expand', async () => {
        const subscribeArgs = []
        const refsMock = {
            subscribeGraph(opts) {
                subscribeArgs.push(opts)
                return { dispose: () => {} }
            },
        }
        const { server, port } = await mountWithCache(CATALOG, refsMock)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities?id=/blog/launch.md`)
            assert.equal(res.status, 200)
            assert.equal(subscribeArgs.length, 0)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('the subscription onAffected callback evicts the cache file', async () => {
        let storedOnAffected = null
        let disposed = false
        const refsMock = {
            subscribeGraph(opts) {
                storedOnAffected = opts.onAffected
                return { dispose: () => { disposed = true } }
            },
        }
        const { server, port, tmpRoot, readdir } = await mountWithCache(CATALOG, refsMock)
        try {
            // Query string contains a `/` (in the id filter) — this is
            // exactly the case the old raw-filename scheme couldn't
            // cache. The hash-based scheme handles it without special
            // characters reaching the filesystem.
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities?id=/blog/launch.md&expand=author`)
            assert.equal(res.status, 200)

            // Give the fire-and-forget cache write a tick to land.
            await new Promise(r => setTimeout(r, 30))

            const cacheDir = path.join(tmpRoot, 'api', 'public', 'entities')
            const filesBefore = await readdir(cacheDir).catch(() => [])
            assert.equal(filesBefore.length, 1, `expected exactly one cache file, got: ${JSON.stringify(filesBefore)}`)
            // Filename should be a 16-char hex sha256 prefix + .json,
            // not the raw query string (which would include `/` and
            // `=`/`&`/etc).
            assert.match(filesBefore[0], /^[0-9a-f]{16}\.json$/, `expected hash-shaped filename, got: ${filesBefore[0]}`)

            // Simulate a mutation reaching the subscriber — the graph
            // dispatch in runtime.refs would normally invoke this. We
            // call it directly here so the test stays focused on the
            // api plugin's eviction wiring.
            assert.equal(typeof storedOnAffected, 'function')
            await storedOnAffected({
                root: { id: '/blog/launch.md', meta: { href: '/blog/launch' } },
                mutated: { id: '/authors/dick', meta: { name: 'Updated' } },
            })

            // Self-dispose after evict.
            assert.equal(disposed, true)

            // Cache file removed.
            const filesAfter = await readdir(cacheDir).catch(() => [])
            assert.equal(filesAfter.length, 0, `expected cache cleared, still had: ${JSON.stringify(filesAfter)}`)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('caches the no-query GET as `index.json` for a quick default-snapshot lookup', async () => {
        const refsMock = {
            subscribeGraph() { return { dispose: () => {} } },
        }
        const { server, port, tmpRoot, readdir } = await mountWithCache(CATALOG, refsMock)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities`)
            assert.equal(res.status, 200)
            await new Promise(r => setTimeout(r, 30))

            const cacheDir = path.join(tmpRoot, 'api', 'public', 'entities')
            const files = await readdir(cacheDir)
            assert.deepEqual(files, ['index.json'])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('strips the `cache` param before hashing so client and server agree on the filename', async () => {
        // This is the nginx-fast-path contract (ADR-0007 caching section):
        // the SDK appends `&cache=<hash>` so nginx can do
        // `try_files .../$arg_cache.json @proxy`. The server must
        // ignore that param when computing its own hash, otherwise
        // they could never converge on the same filename.
        const refsMock = {
            subscribeGraph() { return { dispose: () => {} } },
        }
        const { server, port, tmpRoot, readdir } = await mountWithCache(CATALOG, refsMock)
        try {
            // Same actual query; one includes a `cache` hint, one doesn't.
            const a = await fetch(`http://127.0.0.1:${port}/api/public/entities?expand=author`)
            const b = await fetch(`http://127.0.0.1:${port}/api/public/entities?expand=author&cache=deadbeef12345678`)
            assert.equal(a.status, 200)
            assert.equal(b.status, 200)
            await new Promise(r => setTimeout(r, 30))

            const cacheDir = path.join(tmpRoot, 'api', 'public', 'entities')
            const files = await readdir(cacheDir)
            // Exactly one cache file — the two requests share a hash
            // because the `cache` param was stripped before hashing.
            assert.equal(files.length, 1, `expected one cache file, got: ${JSON.stringify(files)}`)
            assert.match(files[0], /^[0-9a-f]{16}\.json$/)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('strips multiple `cache` params (defensive against duplicates in the URL)', async () => {
        const refsMock = {
            subscribeGraph() { return { dispose: () => {} } },
        }
        const { server, port, tmpRoot, readdir } = await mountWithCache(CATALOG, refsMock)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities?expand=author&cache=a&cache=b`)
            assert.equal(res.status, 200)
            await new Promise(r => setTimeout(r, 30))

            const cacheDir = path.join(tmpRoot, 'api', 'public', 'entities')
            const files = await readdir(cacheDir)
            assert.equal(files.length, 1)
            // Same filename as the clean `?expand=author` request would
            // produce. Verified indirectly by the previous test.
            assert.match(files[0], /^[0-9a-f]{16}\.json$/)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('does NOT route the `cache` param into the sift filter (it stays a pure routing hint)', async () => {
        // Regression test: the api plugin previously treated any
        // unrecognised query param as a sift filter. With the
        // SDK auto-appending `cache=<hash>`, this meant every cached
        // request was sift-filtered by `entity.cache === '<hash>'`
        // — which matches nothing on a typical catalog, so cache files
        // ended up containing `items: []`. parseQueryString now skips
        // the `cache` key explicitly. This test asserts a
        // cache-bearing request still returns the entities the query
        // would match without it.
        const refsMock = {
            subscribeGraph() { return { dispose: () => {} } },
        }
        const { server, port } = await mountWithCache(CATALOG, refsMock)
        try {
            // Baseline: same filter, no cache hint — should return
            // /authors/dick (no other catalog entity is type 'author').
            const baseline = await fetch(`http://127.0.0.1:${port}/api/public/entities?type=author`)
            const baselineBody = await baseline.json()
            assert.ok(
                baselineBody.items.some(i => i.id === '/authors/dick'),
                `baseline should include /authors/dick, got: ${JSON.stringify(baselineBody.items.map(i => i.id))}`,
            )

            // With the routing hint added — identical items.
            const withHint = await fetch(`http://127.0.0.1:${port}/api/public/entities?type=author&cache=deadbeef12345678`)
            const withHintBody = await withHint.json()
            assert.equal(withHintBody.items.length, baselineBody.items.length)
            assert.deepEqual(
                withHintBody.items.map(i => i.id).sort(),
                baselineBody.items.map(i => i.id).sort(),
            )
        } finally {
            await new Promise((r) => server.close(r))
        }
    })
})

// Express's own default is 100kb, which is fine for a REST body and wrong for
// `render`: the request carries the entity, so its size is the size of whatever
// the layout needs. On gpoint a mail template handed a customer's recent
// bookings ran 141–423kb and every one of those renders was rejected — 168 of
// them in under two hours, booking confirmations among them.
//
// The failure is invisible from inside mikser. raw-body rejects while READING
// the stream, so no handler runs and nothing is logged as a render error; the
// caller gets an HTML error page back from a JSON API and concludes the thing it
// was rendering for is broken.
describe('api plugin: request body limit', () => {
    // 300kb of JSON — over Express's default, comfortably under the new one, and
    // the size range that actually broke.
    const bigMeta = 'x'.repeat(300 * 1024)

    const serve = async (apiOptions) => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-body-limit',
                outputFolder: '/tmp/mikser-body-limit/out',
            },
        })
        h.runtime.process = async () => {
            const lastUpdate = [...h.journal].reverse().find(e => e.operation === 'update')
            if (!lastUpdate) return
            const entry = {
                entity: { ...lastUpdate.entity, destination: '/en/page.html' },
                output: { success: true, result: 'ok' },
            }
            for (const cb of [...h.runtime.hooks.completed]) await cb(entry)
        }
        h.runtime.hooks.completed = h.runtime.hooks.complete

        api(apiOptions)(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port }
    }

    const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/default/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })

    it('accepts a body larger than the express default', async () => {
        const { server, port } = await serve({ endpoints: { default: { operations: ['render'] } } })
        try {
            const response = await post(port, {
                id: '/documents/en/page.md', collection: 'documents', type: 'document',
                meta: { blob: bigMeta },
            })
            assert.notEqual(response.status, 413)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('still refuses a body over the configured limit', async () => {
        // Not unbounded: a token-gated endpoint is still a body whose size the
        // caller chooses.
        const { server, port } = await serve({
            bodyLimit: '100kb',
            endpoints: { default: { operations: ['render'] } },
        })
        try {
            const response = await post(port, {
                id: '/documents/en/page.md', collection: 'documents', type: 'document',
                meta: { blob: bigMeta },
            })
            assert.equal(response.status, 413)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('lets one endpoint raise the limit without changing the others', async () => {
        const { server, port } = await serve({
            bodyLimit: '100kb',
            endpoints: { default: { operations: ['render'], bodyLimit: '2mb' } },
        })
        try {
            const response = await post(port, {
                id: '/documents/en/page.md', collection: 'documents', type: 'document',
                meta: { blob: bigMeta },
            })
            assert.notEqual(response.status, 413)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })
})

// An endpoint scope may be declared as a sift OBJECT (preferred — it pushes
// down into the WHERE clause) or as a function. `list` reads it as data, but
// two paths hold a single entity in hand and can only test it as a predicate:
// POST /render admission, and the graph-subscription filter. Those called the
// scope directly, which throws `query is not a function` the moment the object
// form is used — a 500 on a route whose only diagnostic is `{error: message}`.
describe('api plugin: object-form endpoint scope on /render', () => {
    const serve = async (apiOptions) => {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-scope-render',
                outputFolder: '/tmp/mikser-scope-render/out',
            },
        })
        h.runtime.process = async () => {
            const lastUpdate = [...h.journal].reverse().find(e => e.operation === 'update')
            if (!lastUpdate) return
            const entry = {
                entity: { ...lastUpdate.entity, destination: '/en/page.html' },
                output: { success: true, result: 'ok' },
            }
            for (const cb of [...h.runtime.hooks.completed]) await cb(entry)
        }
        h.runtime.hooks.completed = h.runtime.hooks.complete

        api(apiOptions)(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port }
    }

    const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/default/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })

    const objectScope = {
        endpoints: {
            default: {
                operations: ['render'],
                query: { 'meta.href': { $regex: '^/(web|system)' } },
            },
        },
    }

    it('renders an in-scope entity instead of throwing on the object form', async () => {
        const { server, port } = await serve(objectScope)
        try {
            const response = await post(port, {
                id: '/documents/en/page.md', collection: 'documents', type: 'document',
                meta: { href: '/web/booking' },
            })
            assert.equal(response.status, 200)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('rejects an out-of-scope entity with 403, not 500', async () => {
        const { server, port } = await serve(objectScope)
        try {
            const response = await post(port, {
                id: '/documents/en/secret.md', collection: 'documents', type: 'document',
                meta: { href: '/admin/secret' },
            })
            assert.equal(response.status, 403)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('still honours the function form', async () => {
        const { server, port } = await serve({
            endpoints: {
                default: {
                    operations: ['render'],
                    query: e => e.meta?.href?.startsWith('/web'),
                },
            },
        })
        try {
            assert.equal((await post(port, {
                id: '/documents/en/page.md', collection: 'documents', type: 'document',
                meta: { href: '/web/booking' },
            })).status, 200)
            assert.equal((await post(port, {
                id: '/documents/en/secret.md', collection: 'documents', type: 'document',
                meta: { href: '/admin/secret' },
            })).status, 403)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })
})

// A render failure used to log only `err.message` and answer only
// `{error: message}`. Renders run through a renderer, a postprocessor chain
// and any template helper those call, so the message is routinely a bare
// TypeError from a frame nobody can name from the outside — leaving version
// bisection as the only way to find out where it came from. The stack and the
// entity id belong in the operator's log.
describe('api plugin: render failure diagnostics', () => {
    async function failingRender(thrown, body = {
        id: '/documents/en/page.md', collection: 'documents', type: 'document',
    }) {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-render-diag',
                outputFolder: '/tmp/mikser-render-diag/out',
            },
        })
        h.runtime.process = async () => { throw thrown }
        h.runtime.hooks.completed = h.runtime.hooks.complete

        api({ endpoints: { default: { operations: ['render'] } } })(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/default/render`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            })
            return { response, logs: h.logs }
        } finally {
            await new Promise((r) => server.close(r))
        }
    }

    it('logs the stack and the entity id when a render throws', async () => {
        const boom = new TypeError("Cannot read properties of undefined (reading 'split')")
        const { response, logs } = await failingRender(boom)

        assert.equal(response.status, 500)
        const errors = logs.filter(l => l.level === 'error')
        assert.equal(errors.length, 1)

        const line = errors[0].args.join(' ')
        // Which entity, what went wrong, and where it came from.
        assert.match(line, /\/documents\/en\/page\.md/)
        assert.match(line, /reading 'split'/)
        assert.match(line, /TypeError.*\n\s+at /s)
    })

    it('says so plainly when the body carried no id at all', async () => {
        // The body failing to parse and the entity being unrenderable are
        // different faults, and a bare `undefined` in the log reads as
        // neither — which is exactly how a `Render requested for undefined`
        // gets mistaken for an engine bug.
        const { logs } = await failingRender(new Error('nope'), { collection: 'documents' })
        const line = logs.filter(l => l.level === 'error')[0].args.join(' ')
        assert.match(line, /\(no id in body\)/)
        assert.doesNotMatch(line, /undefined/)
    })
})

// The server binds at the end of the loaded phase, before process() has
// emitted an entity — so without a gate the endpoint spends the whole first
// build answering against an empty catalog. Renders cannot resolve a layout,
// and reads return whichever subset happens to exist, which is a wrong answer
// wearing a 200.
describe('api plugin: not-ready gate', () => {
    async function mount({ ready, endpoints, entities = [] }) {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: { app, workingFolder: '/tmp/mikser-ready', outputFolder: '/tmp/mikser-ready/out' },
            entities,
        })
        h.runtime.ready = ready
        api({ endpoints })(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port }
    }

    const ENDPOINTS = { public: { operations: ['list', 'render'] } }

    it('answers 503 with Retry-After while the first build is still running', async () => {
        const { server, port } = await mount({
            ready: false, endpoints: ENDPOINTS,
            entities: [{ id: '/a.md', type: 'document', meta: {} }],
        })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities`)
            assert.equal(res.status, 503)
            assert.equal(res.headers.get('retry-after'), '1')
            assert.equal((await res.json()).ready, false)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('gates render too — a build in progress is not a bad request', async () => {
        // The distinction that matters: 503 invites a retry, 422/500 tells the
        // caller its request was wrong and to stop.
        const { server, port } = await mount({ ready: false, endpoints: ENDPOINTS })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/render`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: '/x.md', collection: 'documents', type: 'document' }),
            })
            assert.equal(res.status, 503)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('never answers a partial catalog with a 200', async () => {
        // The failure this exists to prevent: a consumer seeding its routes
        // from a half-built catalog gets a short list and renders blank pages,
        // with nothing in any log to say why.
        const { server, port } = await mount({
            ready: false, endpoints: ENDPOINTS,
            entities: [{ id: '/a.md', type: 'document', meta: {} }],
        })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities`)
            assert.notEqual(res.status, 200)
            assert.equal(res.headers.get('content-type')?.includes('json'), true)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('serves normally once the first build has completed', async () => {
        const { server, port } = await mount({
            ready: true, endpoints: ENDPOINTS,
            entities: [
                { id: '/a.md', type: 'document', meta: {} },
                { id: '/b.md', type: 'document', meta: {} },
            ],
        })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/public/entities`)
            assert.equal(res.status, 200)
            assert.equal((await res.json()).total, 2)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })
})

describe('api plugin: principal-bound scope (ADR-0012)', () => {
    // A credential that carries its OWN row filter, on top of whatever the
    // endpoint declares. `bearer({ scope })` is the engine's shape for it.
    async function mount({ endpoints, entities = [], outputFolder }) {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: { app, workingFolder: '/tmp/mikser-pscope', outputFolder },
            entities,
        })
        api({ endpoints })(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port, h }
    }

    const CATALOG = [
        { id: '/web/a.md',       type: 'document', meta: { href: '/web/a',       published: true } },
        { id: '/web/b.md',       type: 'document', meta: { href: '/web/b',       published: false } },
        { id: '/franchise/c.md', type: 'document', meta: { href: '/franchise/c', published: true } },
        { id: '/private/d.md',   type: 'document', meta: { href: '/private/d',   published: true } },
    ]

    const listAs = async (port, token) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/content/entities`, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
        })
        return { status: res.status, body: await res.json() }
    }

    it('narrows the endpoint scope — never widens it', async () => {
        const { server, port } = await mount({
            endpoints: {
                content: {
                    // Endpoint ceiling: the web + franchise slice.
                    query: { 'meta.href': { $regex: '^/(web|franchise)' } },
                    operations: ['list'],
                    auth: [
                        bearer({ token: 'web-tok', subject: 'gpoint-web',
                                 scope: { 'meta.href': { $regex: '^/web' } } }),
                        // Declares a scope reaching OUTSIDE the endpoint's —
                        // the $and must still keep /private out.
                        bearer({ token: 'greedy-tok', subject: 'greedy',
                                 scope: { 'meta.href': { $regex: '^/(web|private)' } } }),
                        bearer({ token: 'plain-tok', subject: 'plain' }),
                    ],
                },
            },
            entities: CATALOG,
        })
        try {
            const web = await listAs(port, 'web-tok')
            assert.deepEqual(web.body.items.map(i => i.id).sort(), ['/web/a.md', '/web/b.md'])

            // greedy asked for /web + /private; the endpoint allows /web +
            // /franchise; the intersection is /web only.
            const greedy = await listAs(port, 'greedy-tok')
            assert.deepEqual(greedy.body.items.map(i => i.id).sort(), ['/web/a.md', '/web/b.md'])

            // An unscoped credential still sees the endpoint's full slice.
            const plain = await listAs(port, 'plain-tok')
            assert.deepEqual(plain.body.items.map(i => i.id).sort(),
                             ['/franchise/c.md', '/web/a.md', '/web/b.md'])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('applies a principal scope when the endpoint declares none', async () => {
        const { server, port } = await mount({
            endpoints: {
                content: {
                    operations: ['list'],
                    auth: bearer({ token: 'fr-tok', subject: 'franchise',
                                   scope: { 'meta.href': { $regex: '^/franchise' } } }),
                },
            },
            entities: CATALOG,
        })
        try {
            const out = await listAs(port, 'fr-tok')
            assert.deepEqual(out.body.items.map(i => i.id), ['/franchise/c.md'])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('composes with a FUNCTION endpoint scope, keeping both halves', async () => {
        const { server, port } = await mount({
            endpoints: {
                content: {
                    query: (e) => e.meta?.published === true,     // post-fetch
                    operations: ['list'],
                    auth: bearer({ token: 'web-tok',
                                   scope: { 'meta.href': { $regex: '^/web' } } }),  // pushed down
                },
            },
            entities: CATALOG,
        })
        try {
            const out = await listAs(port, 'web-tok')
            // /web/a is published; /web/b is not; everything else is out of
            // the principal's scope.
            assert.deepEqual(out.body.items.map(i => i.id), ['/web/a.md'])
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('refuses a function principal scope — it could not be pushed into the query', async () => {
        const { server, port } = await mount({
            endpoints: {
                content: {
                    operations: ['list'],
                    auth: bearer({ token: 'fn-tok', scope: (e) => e.meta?.published }),
                },
            },
            entities: CATALOG,
        })
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/content/entities`, {
                headers: { authorization: 'Bearer fn-tok' },
            })
            assert.equal(res.status, 500)
        } finally {
            await new Promise((r) => server.close(r))
        }
    })

    it('never writes a principal-scoped response to the shared query cache', async () => {
        // The cache mirrors the request URL into the output folder, where
        // nginx serves it without reaching this process. Caching a scoped
        // response there would hand one caller's rows to everyone.
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-pscope-cache-'))
        const { server, port } = await mount({
            endpoints: {
                content: {
                    operations: ['list'],
                    cache: true,
                    auth: [
                        bearer({ token: 'scoped-tok', subject: 'scoped',
                                 scope: { 'meta.href': { $regex: '^/web' } } }),
                        bearer({ token: 'open-tok', subject: 'open' }),
                    ],
                },
            },
            entities: CATALOG,
            outputFolder: dir,
        })
        try {
            await listAs(port, 'scoped-tok')
            await new Promise(r => setTimeout(r, 60))   // fire-and-forget write
            const afterScoped = await readdir(dir).catch(() => [])
            assert.deepEqual(afterScoped, [], 'a scoped response must leave no cache file')

            await listAs(port, 'open-tok')
            await new Promise(r => setTimeout(r, 60))
            const afterOpen = await readdir(dir).catch(() => [])
            assert.ok(afterOpen.length > 0, 'an unscoped response still caches')
        } finally {
            await new Promise((r) => server.close(r))
            await rm(dir, { recursive: true, force: true })
        }
    })
})

describe('api plugin: diagnostics endpoints', () => {
    // /explain, /report and /audit-output — the three questions --explain, --json
    // and --audit-output answer, for a RUNNING server. Everything built to make the
    // engine legible landed on the CLI first, which meant it needed a shell
    // on the box: CI, a dashboard, or an agent speaking only HTTP could
    // author content and read entities but could not ask why the engine did
    // what it did.
    //
    // Gated on their own `diagnostics` operation, in NEITHER default op set,
    // because these responses carry absolute filesystem paths, layout ids and
    // raw error text. Folding them into `list` would leak engine internals
    // through every endpoint that only meant to publish content.
    async function mount({ endpoints, entities = [], manifest } = {}) {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: { app, workingFolder: '/tmp/mikser-diag', outputFolder: '/tmp/mikser-diag/out' },
            entities,
        })
        // The not-ready gate reads the module SINGLETON, not the harness's
        // runtime object, so setting only the latter leaves every request
        // answering 503 — and a test expecting 503 would pass for the wrong
        // reason, since the singleton is not-ready by default.
        h.runtime.ready = true
        realRuntime.ready = true
        if (manifest) {
            h.runtime.manifest = manifest
            realRuntime.manifest = manifest
        } else {
            delete realRuntime.manifest
        }
        api({ endpoints })(h.core)
        await h.runHook('loaded')
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        return { server, port: server.address().port, harness: h }
    }

    const withServer = async (opts, fn) => {
        const { server, port, harness } = await mount(opts)
        try { return await fn(port, harness) } finally { await new Promise(r => server.close(r)) }
    }

    it('is not reachable from an endpoint that did not ask for it', async () => {
        // The whole point of a separate operation. A token alone must not
        // hand out engine internals.
        await withServer({ endpoints: { admin: { token: 't', operations: ['list', 'update'] } } },
            async (port) => {
                for (const path of ['/explain?reference=/a.md', '/report', '/audit-output']) {
                    const res = await fetch(`http://127.0.0.1:${port}/api/admin${path}`, {
                        headers: { Authorization: 'Bearer t' },
                    })
                    assert.equal(res.status, 403, `${path} should be forbidden without the op`)
                }
            })
    })

    it('is not in the default operation set for a token endpoint', async () => {
        // Defaults are list/update/delete/render/subscribe. Adding diagnostics
        // to that list would turn every existing token endpoint into one that
        // serves absolute paths, silently, on upgrade.
        await withServer({ endpoints: { admin: { token: 't' } } }, async (port) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/admin/audit-output`, {
                headers: { Authorization: 'Bearer t' },
            })
            assert.equal(res.status, 403)
        })
    })

    it('rejects a wrong credential like every other operation', async () => {
        // ADR-0012: presented-and-wrong is 401 and never falls back. An
        // ABSENT credential from loopback is a different case — a plain
        // `token:` endpoint still trusts the local host, which is why this
        // asserts on a bad token rather than on no token at all.
        await withServer({ endpoints: { ops: { token: 'secret', operations: ['diagnostics'] } } },
            async (port) => {
                for (const path of ['/audit-output', '/report', '/explain?reference=/a.md']) {
                    const res = await fetch(`http://127.0.0.1:${port}/api/ops${path}`, {
                        headers: { Authorization: 'Bearer wrong' },
                    })
                    assert.equal(res.status, 401, `${path} accepted a wrong token`)
                }
            })
    })

    it('/audit-output reports the manifest verdict', async () => {
        // The verdict comes from the manifest now, so the route cannot
        // disagree with the CLI about what counts as a failure — the stub
        // returns what a real audit returns.
        const manifest = {
            size: () => 3,
            auditOutput: async () => ({
                verdict: 'FAIL',
                missing: [{ id: '/a.md', destination: '/a.html' }],
                mismatched: [], unverifiable: [], orphaned: [{ path: 'stray.html' }],
                collisions: [],
            }),
        }
        await withServer({ endpoints: { ops: { token: 't', operations: ['diagnostics'] } }, manifest },
            async (port) => {
                const res = await fetch(`http://127.0.0.1:${port}/api/ops/audit-output`, {
                    headers: { Authorization: 'Bearer t' },
                })
                // 200 even for FAIL: the check ran, and this is its answer. A
                // status code would conflate "drift found" with "request
                // failed", and a CI gate reads `verdict`.
                assert.equal(res.status, 200)
                const body = await res.json()
                assert.equal(body.verdict, 'FAIL')
                assert.equal(body.snapshots, 3)
                assert.equal(body.missing.length, 1)
                assert.equal(body.orphaned.length, 1)
            })
    })

    it('/audit-output says so when there is no manifest to check against', async () => {
        await withServer({ endpoints: { ops: { token: 't', operations: ['diagnostics'] } } },
            async (port) => {
                const res = await fetch(`http://127.0.0.1:${port}/api/ops/audit-output`, {
                    headers: { Authorization: 'Bearer t' },
                })
                assert.equal(res.status, 503, 'no manifest is a service state, not a bad request')
            })
    })

    it('/explain requires a reference and 404s an unknown one', async () => {
        await withServer({ endpoints: { ops: { token: 't', operations: ['diagnostics'] } } },
            async (port) => {
                const auth = { headers: { Authorization: 'Bearer t' } }
                const missing = await fetch(`http://127.0.0.1:${port}/api/ops/explain`, auth)
                assert.equal(missing.status, 400)
                assert.match((await missing.json()).error, /reference/)

                const unknown = await fetch(`http://127.0.0.1:${port}/api/ops/explain?reference=/nope`, auth)
                assert.equal(unknown.status, 404, 'found:false is an answer, but a REST caller reads status first')
            })
    })

    it('/report serves the build report', async () => {
        await withServer({ endpoints: { ops: { token: 't', operations: ['diagnostics'] } } },
            async (port) => {
                const res = await fetch(`http://127.0.0.1:${port}/api/ops/report`, {
                    headers: { Authorization: 'Bearer t' },
                })
                assert.equal(res.status, 200)
                const body = await res.json()
                for (const key of ['rendered', 'skipped', 'unchanged', 'errors', 'warnings', 'summary']) {
                    assert.ok(key in body, `report is missing ${key}`)
                }
            })
    })
})

// Reachability is not decoration: registerRoute puts it on runtime.routes,
// where 'loopback' means "a facade must not proxy this route".
//
// The value must come from reachabilityOf(ep), which treats `auth` and
// `token` alike. Deriving it from `token` alone registers an auth-gated
// endpoint as 'loopback' and logs it [loopback-only] while the verifier is
// enforced perfectly — so a generated vhost drops the authenticated API and
// the boot log agrees that it is unreachable. Two sources of truth giving
// the same wrong answer is what makes that one expensive to disbelieve.
//
// reachabilityOf() is unit-tested in auth.test.js and called by webdav and
// mcp; these assert that api calls it too, which is the half that drifts.
describe('api plugin: registered reachability', () => {
    const verifier = {
        name: 'basic',
        verify: async () => ({ ok: true, principal: { capabilities: ['api:list'] } }),
    }

    async function mountOne(ep) {
        const { default: express } = await import('express')
        const app = express()
        const h = createHarness({
            options: {
                app,
                workingFolder: '/tmp/mikser-reach',
                outputFolder: '/tmp/mikser-reach/out',
            },
        })
        realRuntime.routes = []
        const lines = []
        realRuntime.engine = { logger: { info: (...a) => lines.push(a.join(' ')) } }
        api({ endpoints: { one: ep } })(h.core)
        await h.runHook('loaded')
        return {
            route:  realRuntime.routes.find(r => r.path === '/api/one'),
            logged: lines.join('\n'),
        }
    }

    it('an auth-gated endpoint registers as token, not loopback', async () => {
        const { route, logged } = await mountOne({ auth: verifier, operations: ['list'] })
        assert.equal(route.reachability, 'token')
        assert.ok(!logged.includes('loopback-only'), `logged: ${logged}`)
    })

    it('names the verifier in the bracket, as webdav and mcp do', async () => {
        const { logged } = await mountOne({ auth: verifier, operations: ['list'] })
        assert.ok(logged.includes('basic'), `logged: ${logged}`)
    })

    it('a static token still registers as token', async () => {
        const { route } = await mountOne({ token: 'sekrit', operations: ['list'] })
        assert.equal(route.reachability, 'token')
    })

    it('neither auth nor token is loopback', async () => {
        const { route, logged } = await mountOne({ operations: ['list'] })
        assert.equal(route.reachability, 'loopback')
        assert.ok(logged.includes('loopback-only'), `logged: ${logged}`)
    })

    // allowRemote alongside a verifier is NOT an unauthenticated exposure —
    // the verifier gates every request, with no loopback bypass. The old
    // ternary reached the allowRemote branch whenever `token` was unset and
    // shouted REMOTE OPEN about an endpoint nobody could reach unauthenticated.
    it('auth plus allowRemote is token, and does not shout REMOTE OPEN', async () => {
        const { route, logged } = await mountOne({
            auth: verifier, allowRemote: true, operations: ['list'],
        })
        assert.equal(route.reachability, 'token')
        assert.ok(!logged.includes('REMOTE OPEN'), `logged: ${logged}`)
    })
})

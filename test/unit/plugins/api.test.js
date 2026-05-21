import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import apiPlugin, { mimeForEntity, sendRenderOutput } from '../../../src/plugins/api.js'
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

describe('api plugin: mimeForEntity', () => {
    it('returns null for an entity without a destination', () => {
        assert.equal(mimeForEntity({}), null)
        assert.equal(mimeForEntity(null), null)
    })

    it('maps a .pdf destination to application/pdf', () => {
        assert.equal(mimeForEntity({ destination: '/en/report.pdf' }), 'application/pdf')
    })

    it('maps a .html destination to text/html with charset', () => {
        assert.match(mimeForEntity({ destination: '/index.html' }), /text\/html/)
    })

    it('maps common content-types from the extension', () => {
        assert.match(mimeForEntity({ destination: '/feed.xml' }), /application\/xml/)
        assert.match(mimeForEntity({ destination: '/feed.rss' }), /application\/rss\+xml/)
        assert.match(mimeForEntity({ destination: '/api.json' }), /application\/json/)
        assert.equal(mimeForEntity({ destination: '/logo.png' }), 'image/png')
        assert.equal(mimeForEntity({ destination: '/clip.mp4' }), 'video/mp4')
    })

    it('returns null for an unrecognized extension', () => {
        assert.equal(mimeForEntity({ destination: '/strange.bizarro' }), null)
    })

    it('is case-insensitive on the extension', () => {
        assert.equal(mimeForEntity({ destination: '/Report.PDF' }), 'application/pdf')
    })
})

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

        apiPlugin(h.core)
        await h.runHook('loaded')

        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        try {
            const { port } = server.address()
            const response = await fetch(`http://127.0.0.1:${port}/api/render`, {
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

        apiPlugin(h.core)
        await h.runHook('loaded')

        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s))
        })
        try {
            const { port } = server.address()
            const ids = ['/docs/a.md', '/docs/b.md', '/docs/c.md', '/docs/d.md', '/docs/e.md']
            const responses = await Promise.all(
                ids.map(id => fetch(`http://127.0.0.1:${port}/api/render`, {
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
            config: { api: { renderTimeout: 50 } },
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
            const response = await fetch(`http://127.0.0.1:${port}/api/render`, {
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

    it('returns 500 "did not complete" when the cycle finishes without firing the entity\'s hook', async () => {
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
            const response = await fetch(`http://127.0.0.1:${port}/api/render`, {
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

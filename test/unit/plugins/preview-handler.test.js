import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'

import { forwardToHandler } from '../../../src/plugins/preview.js'

// Spin up a one-shot HTTP server that returns the configured response.
// Returns { url, port, close, requests }, where `requests` is an array of
// { method, url, headers, body } captured for each incoming request.
async function spinUpServer(responder) {
    const requests = []
    const srv = createServer(async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk.toString()
        requests.push({
            method:  req.method,
            url:     req.url,
            headers: { ...req.headers },
            body,
        })
        responder(req, res, body)
    })
    await new Promise(resolve => srv.listen(0, resolve))
    const port = srv.address().port
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () => new Promise(resolve => srv.close(resolve)),
    }
}

describe('forwardToHandler', () => {
    it('POSTs the body as JSON with the standard headers + request id', async () => {
        const srv = await spinUpServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, summary: 'received' }))
        })
        try {
            const result = await forwardToHandler(
                { url: srv.url },
                {
                    callId:   'mui_abc',
                    entityId: '/documents/blog/x.md',
                    action:   'approve',
                    payload:  { note: 'lgtm' },
                    layoutId: '/layouts/mcp-ui/post-approval.hbs',
                    mode:     'approval',
                },
            )

            assert.deepEqual(result, { ok: true, summary: 'received' })
            assert.equal(srv.requests.length, 1)

            const req = srv.requests[0]
            assert.equal(req.method, 'POST')
            assert.equal(req.headers['content-type'], 'application/json')
            assert.equal(req.headers['x-mikser-layout-id'], '/layouts/mcp-ui/post-approval.hbs')
            assert.equal(req.headers['x-mikser-mode'], 'approval')
            assert.ok(req.headers['x-mikser-request-id'], 'expected x-mikser-request-id header')

            const sent = JSON.parse(req.body)
            assert.equal(sent.callId,   'mui_abc')
            assert.equal(sent.entityId, '/documents/blog/x.md')
            assert.equal(sent.action,   'approve')
            assert.deepEqual(sent.payload, { note: 'lgtm' })
            // Timestamp is added by forwardToHandler — verify it's ISO-shaped.
            assert.match(sent.timestamp, /^\d{4}-\d{2}-\d{2}T/)
        } finally {
            await srv.close()
        }
    })

    it('signs the body with HMAC-SHA256 when secret is set; verification should succeed', async () => {
        const SECRET = 'super-secret-key'
        const srv = await spinUpServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{}')
        })
        try {
            await forwardToHandler({ url: srv.url, secret: SECRET }, {
                callId: 'x', entityId: '/x', action: 'approve', payload: {},
                layoutId: '/l', mode: 'm',
            })

            const req = srv.requests[0]
            const sigHeader = req.headers['x-mikser-signature']
            assert.ok(sigHeader, 'expected x-mikser-signature header')

            // Verify the signature matches what HMAC would produce.
            const expected = 'sha256=' + createHmac('sha256', SECRET).update(req.body).digest('hex')
            assert.equal(sigHeader, expected, 'HMAC signature should match what a receiver would compute')
        } finally {
            await srv.close()
        }
    })

    it('does NOT include a signature header when secret is unset', async () => {
        const srv = await spinUpServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{}')
        })
        try {
            await forwardToHandler({ url: srv.url }, {
                callId: 'x', entityId: '/x', action: 'approve', payload: {},
                layoutId: '/l', mode: 'm',
            })
            const req = srv.requests[0]
            assert.equal(req.headers['x-mikser-signature'], undefined)
        } finally {
            await srv.close()
        }
    })

    it('throws on non-2xx response, including the status text', async () => {
        const srv = await spinUpServer((_req, res) => {
            res.writeHead(503, { 'content-type': 'text/plain' })
            res.end('database down')
        })
        try {
            await assert.rejects(
                () => forwardToHandler({ url: srv.url }, {
                    callId: 'x', entityId: '/x', action: 'approve', payload: {},
                    layoutId: '/l', mode: 'm',
                }),
                /503|Service Unavailable|database down/,
            )
        } finally {
            await srv.close()
        }
    })

    it('throws an "unreachable" error when the URL refuses connection', async () => {
        // Port 1 is reserved; nothing listens there.
        await assert.rejects(
            () => forwardToHandler(
                { url: 'http://127.0.0.1:1', timeout: 500 },
                { callId: 'x', entityId: '/x', action: 'approve', payload: {}, layoutId: '/l', mode: 'm' },
            ),
            /unreachable|ECONNREFUSED|timeout/i,
        )
    })

    it('throws a "timeout" error when the handler is slow past the timeout', async () => {
        // Server that never responds — just keeps the connection open.
        const srv = await spinUpServer(() => { /* intentionally never write */ })
        try {
            await assert.rejects(
                () => forwardToHandler(
                    { url: srv.url, timeout: 200 },
                    { callId: 'x', entityId: '/x', action: 'approve', payload: {}, layoutId: '/l', mode: 'm' },
                ),
                /timeout/i,
            )
        } finally {
            await srv.close()
        }
    })

    it('wraps a non-JSON 2xx response into { ok: true, handlerResponse }', async () => {
        const srv = await spinUpServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('queued')
        })
        try {
            const result = await forwardToHandler({ url: srv.url }, {
                callId: 'x', entityId: '/x', action: 'approve', payload: {},
                layoutId: '/l', mode: 'm',
            })
            assert.deepEqual(result, { ok: true, handlerResponse: 'queued' })
        } finally {
            await srv.close()
        }
    })

    it('rejects when handler.url is missing', async () => {
        await assert.rejects(
            () => forwardToHandler({}, { action: 'approve', entityId: '/x', payload: {} }),
            /handler\.url is required/i,
        )
    })
})

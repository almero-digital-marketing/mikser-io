// Unit tests for the built-in HTTP/HTTPS content provider.
//
// fetch is stubbed globally per-test. Each test sets globalThis.fetch
// to a fake that returns a Response-like object, exercises
// readEntityContent (which dispatches into the http provider for
// http:// / https:// URIs), and asserts the response shape.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readEntityContent } from '../../src/utils.js'
import runtime from '../../src/runtime.js'
import { __resetHttpCacheForTests } from '../../src/plugins/providers/http.js'

function mockResponse({ status = 200, headers = {}, body = '', binary } = {}) {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
        status,
        ok: status >= 200 && status < 300,
        statusText: status === 200 ? 'OK' : status === 304 ? 'Not Modified' : 'Err',
        headers: {
            get: (k) => h.get(k.toLowerCase()) ?? null,
        },
        text: async () => body,
        arrayBuffer: async () => {
            if (binary instanceof Uint8Array) return binary.buffer
            return new TextEncoder().encode(body).buffer
        },
    }
}

describe('http provider — readEntityContent dispatch', () => {
    let originalFetch
    let originalRuntimeFolder
    let workdir

    beforeEach(async () => {
        originalFetch = globalThis.fetch
        workdir = await mkdtemp(path.join(tmpdir(), 'mikser-http-test-'))
        originalRuntimeFolder = runtime.options?.runtimeFolder
        runtime.options ||= {}
        runtime.options.runtimeFolder = workdir
        __resetHttpCacheForTests()
    })

    afterEach(async () => {
        globalThis.fetch = originalFetch
        if (originalRuntimeFolder !== undefined) {
            runtime.options.runtimeFolder = originalRuntimeFolder
        } else {
            delete runtime.options.runtimeFolder
        }
        if (workdir) await rm(workdir, { recursive: true, force: true })
        __resetHttpCacheForTests()
    })

    it('200 with text/csv → { content }', async () => {
        globalThis.fetch = async () => mockResponse({
            status:  200,
            headers: { 'content-type': 'text/csv', 'etag': '"v1"' },
            body:    'sku,name\nA-1,Widget\n',
        })
        const result = await readEntityContent({
            id: '/x', uri: 'https://example.com/products.csv',
        })
        assert.equal(result.content, 'sku,name\nA-1,Widget\n')
    })

    it('200 with application/json → { content }', async () => {
        globalThis.fetch = async () => mockResponse({
            status:  200,
            headers: { 'content-type': 'application/json' },
            body:    '{"ok":true}',
        })
        const result = await readEntityContent({
            id: '/x', uri: 'https://example.com/data.json',
        })
        assert.equal(result.content, '{"ok":true}')
    })

    it('200 with binary mime → mirrors to runtime/http-cache and returns cachedAt', async () => {
        const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42])
        globalThis.fetch = async () => mockResponse({
            status:  200,
            headers: { 'content-type': 'application/pdf' },
            binary:  bytes,
        })
        const result = await readEntityContent({
            id: '/x', uri: 'https://example.com/file.pdf',
        })
        assert.match(result.contentSkipped ?? '', /http: binary mirrored/)
        assert.ok(result.cachedAt)
        assert.match(result.cachedAt, /http-cache\/[a-f0-9]{16}\.pdf$/)
        const written = await readFile(result.cachedAt)
        assert.deepEqual(new Uint8Array(written), bytes)
    })

    it('forwards entity.meta.httpHeaders to fetch', async () => {
        let seenHeaders
        globalThis.fetch = async (_url, opts) => {
            seenHeaders = opts?.headers ?? {}
            return mockResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' })
        }
        await readEntityContent({
            id: '/x',
            uri: 'https://api.example.com/private',
            meta: { httpHeaders: { Authorization: 'Bearer XYZ', 'X-Custom': 'abc' } },
        })
        assert.equal(seenHeaders.Authorization, 'Bearer XYZ')
        assert.equal(seenHeaders['X-Custom'], 'abc')
    })

    it('second read on same URL sends If-None-Match from the cached ETag', async () => {
        const seen = []
        globalThis.fetch = async (_url, opts) => {
            seen.push(opts?.headers ?? {})
            const isSecond = seen.length === 2
            return mockResponse({
                status:  isSecond ? 304 : 200,
                headers: isSecond ? {} : { 'content-type': 'text/csv', 'etag': '"abc"' },
                body:    isSecond ? '' : 'a,b\n1,2\n',
            })
        }
        const e = { id: '/x', uri: 'https://example.com/csv' }
        const first  = await readEntityContent(e)
        const second = await readEntityContent(e)

        assert.equal(first.content,  'a,b\n1,2\n')
        assert.equal(second.content, 'a,b\n1,2\n')                // served from cache
        assert.equal(seen.length, 2)
        assert.equal(seen[0]['If-None-Match'], undefined)         // first call: no ETag yet
        assert.equal(seen[1]['If-None-Match'], '"abc"')           // second: conditional GET
    })

    it('304 Not Modified after a cache miss → returns last cached payload', async () => {
        let call = 0
        globalThis.fetch = async () => {
            call++
            if (call === 1) return mockResponse({
                status: 200, headers: { 'content-type': 'text/plain', 'etag': '"hello"' }, body: 'hello',
            })
            return mockResponse({ status: 304, headers: {}, body: '' })
        }
        const e = { id: '/x', uri: 'https://example.com/t' }
        const r1 = await readEntityContent(e)
        const r2 = await readEntityContent(e)
        assert.equal(r1.content, 'hello')
        assert.equal(r2.content, 'hello')
    })

    it('4xx → contentError including status', async () => {
        globalThis.fetch = async () => mockResponse({ status: 404 })
        const result = await readEntityContent({
            id: '/x', uri: 'https://example.com/missing',
        })
        assert.match(result.contentError, /404/)
        assert.match(result.contentError, /https:\/\/example\.com\/missing/)
    })

    it('fetch throws → contentError surfaces the message', async () => {
        globalThis.fetch = async () => { throw new Error('ECONNREFUSED 127.0.0.1:9') }
        const result = await readEntityContent({
            id: '/x', uri: 'https://localhost:9/x',
        })
        assert.match(result.contentError, /ECONNREFUSED/)
    })

    it('concurrent reads on the same URL coalesce into a single fetch', async () => {
        let calls = 0
        globalThis.fetch = async () => {
            calls++
            await new Promise(r => setTimeout(r, 10))
            return mockResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'one' })
        }
        const e = { id: '/x', uri: 'https://example.com/coalesce' }
        const [a, b, c] = await Promise.all([
            readEntityContent(e),
            readEntityContent(e),
            readEntityContent(e),
        ])
        assert.equal(calls, 1)
        assert.equal(a.content, 'one')
        assert.equal(b.content, 'one')
        assert.equal(c.content, 'one')
    })

    it('http:// scheme also dispatches (not just https://)', async () => {
        globalThis.fetch = async () => mockResponse({
            status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain',
        })
        const result = await readEntityContent({
            id: '/x', uri: 'http://example.com/x',
        })
        assert.equal(result.content, 'plain')
    })

    it('entity.content fast path skips the dispatch entirely (no fetch call)', async () => {
        let called = false
        globalThis.fetch = async () => { called = true; throw new Error('should not be called') }
        const result = await readEntityContent({
            id: '/x',
            uri: 'https://example.com/whatever',
            content: 'pre-populated',
        })
        assert.equal(result.content, 'pre-populated')
        assert.equal(called, false)
    })
})

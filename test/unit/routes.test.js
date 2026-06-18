// Route registry contract — runtime.routes + registerRoute + routeLocation.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import realRuntime from '../../src/runtime.js'
import { registerRoute, listRoutes, routeLocation } from '../../src/routes.js'

function reset({ url, port } = {}) {
    realRuntime.routes = []
    realRuntime.options = { plugins: [], url, port }
    // Capture logs instead of throwing on the undefined logger path.
    const lines = []
    realRuntime.engine = { logger: { info: (...a) => lines.push(a) } }
    return lines
}

describe('registerRoute', () => {
    beforeEach(() => reset())

    it('records the proxy-relevant descriptor on runtime.routes', () => {
        registerRoute({ path: '/api/public', plugin: 'api', reachability: 'loopback', streaming: true })
        assert.deepEqual(realRuntime.routes, [
            { path: '/api/public', plugin: 'api', reachability: 'loopback', streaming: true },
        ])
    })

    it('defaults reachability to public and streaming to false', () => {
        const d = registerRoute({ path: '/preview', plugin: 'preview' })
        assert.equal(d.reachability, 'public')
        assert.equal(d.streaming, false)
    })

    it('dedups by path — re-register replaces, does not duplicate', () => {
        registerRoute({ path: '/x', plugin: 'a', reachability: 'public' })
        registerRoute({ path: '/x', plugin: 'a', reachability: 'loopback' })
        assert.equal(realRuntime.routes.length, 1)
        assert.equal(realRuntime.routes[0].reachability, 'loopback')
    })

    it('requires path and plugin', () => {
        assert.throws(() => registerRoute({ plugin: 'a' }), /`path` is required/)
        assert.throws(() => registerRoute({ path: '/x' }), /`plugin` is required/)
    })

    it('rejects an unknown reachability', () => {
        assert.throws(
            () => registerRoute({ path: '/x', plugin: 'a', reachability: 'sometimes' }),
            /reachability must be/,
        )
    })

    it('logs the standard mount line with default reachability bracket', () => {
        const lines = reset({ url: 'https://site.example' })
        registerRoute({ path: '/preview', plugin: 'preview', label: 'Preview route', detail: '(cache cap: 100 MB)' })
        // ['%s mounted: %s [%s]%s', label, location, bracket, detail]
        assert.deepEqual(lines[0], [
            '%s mounted: %s [%s]%s',
            'Preview route',
            'https://site.example/preview',
            'public',
            ' (cache cap: 100 MB)',
        ])
    })

    it('honors an authLabel override in the log without changing the stored enum', () => {
        const lines = reset({ port: 3001 })
        registerRoute({ path: '/api/x', plugin: 'api', reachability: 'public', authLabel: 'public, REMOTE OPEN' })
        assert.equal(lines[0][3], 'public, REMOTE OPEN')          // log bracket
        assert.equal(realRuntime.routes[0].reachability, 'public') // stored enum stays clean
    })

    it('uses displayPath for the logged URL but is silent about it in the descriptor', () => {
        const lines = reset({ port: 3001 })
        registerRoute({ path: '/vector', plugin: 'vector', displayPath: '/vector/:storeName' })
        assert.equal(lines[0][2], 'http://localhost:3001/vector/:storeName')
        assert.equal(realRuntime.routes[0].path, '/vector')   // descriptor keeps the real base
    })
})

describe('routeLocation', () => {
    it('prefers runtime.options.url', () => {
        reset({ url: 'https://pub.example', port: 3001 })
        assert.equal(routeLocation('/mcp'), 'https://pub.example/mcp')
    })

    it('falls back to localhost:port', () => {
        reset({ port: 3001 })
        assert.equal(routeLocation('/mcp'), 'http://localhost:3001/mcp')
    })

    it('falls back to the bare path when no origin is known', () => {
        reset({})
        assert.equal(routeLocation('/mcp'), '/mcp')
    })
})

describe('listRoutes', () => {
    it('returns a copy, not the live array', () => {
        reset()
        registerRoute({ path: '/a', plugin: 'p' })
        const snap = listRoutes()
        snap.push({ path: '/b', plugin: 'q' })
        assert.equal(realRuntime.routes.length, 1, 'mutating the snapshot must not touch the registry')
    })
})

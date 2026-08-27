// The favicon fallback, and the ordering it depends on.
//
// The route is registered AFTER express.static(outputFolder) on purpose: a
// project that builds its own favicon.ico into the output folder must be
// served that one, and the engine's mark is what answers when it did not.
// Registering them the other way round still passes every "is there a
// favicon" check while silently overriding every project's own icon — so the
// ORDER is the behaviour worth pinning, not the presence of the route.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import realRuntime from '../../src/runtime.js'
import { setupServer } from '../../src/server.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Records the order routes are registered in, without binding a socket.
function fakeApp(calls) {
    return {
        set() {},
        use(...args) { calls.push({ kind: 'use', arg: args[0] }) },
        get(p) { calls.push({ kind: 'get', arg: p }) },
        listen(_port, cb) { cb?.(); return { on() {}, close() {} } },
    }
}

async function bringUp() {
    const calls = []
    // Run only the hooks setupServer adds, not every hook the imported
    // engine registered at module load — clearing runtime.hooks breaks the
    // lifecycle module that owns it.
    const before = { load: realRuntime.hooks.load.length, loaded: realRuntime.hooks.loaded.length }
    realRuntime.options = {
        ...realRuntime.options,
        app: fakeApp(calls),
        port: 0,
        outputFolder: path.join(ROOT, 'out-does-not-exist'),
    }
    realRuntime.config = { ...realRuntime.config, server: {} }
    realRuntime.engine = { logger: { info() {}, debug() {}, warn() {}, error() {} } }
    setupServer()
    for (const fn of realRuntime.hooks.load.slice(before.load)) await fn()
    for (const fn of realRuntime.hooks.loaded.slice(before.loaded)) await fn()
    return calls
}

describe('server favicon fallback', () => {

    it('ships the icon it intends to serve', () => {
        const file = path.join(ROOT, 'favicon.ico')
        assert.ok(existsSync(file), 'favicon.ico must ship with the package')
        // ICO magic: 00 00 01 00
        const head = readFileSync(file).subarray(0, 4)
        assert.deepEqual([...head], [0, 0, 1, 0])
    })

    it('registers the fallback AFTER the static mount, never before', async () => {
        const calls = await bringUp()
        const staticAt  = calls.findIndex(c => c.kind === 'use' && typeof c.arg === 'function')
        const faviconAt = calls.findIndex(c => c.kind === 'get' && c.arg === '/favicon.ico')
        assert.ok(staticAt >= 0, 'static handler should be mounted')
        assert.ok(faviconAt >= 0, 'favicon route should be registered')
        assert.ok(faviconAt > staticAt,
            `favicon route must come after static (static=${staticAt}, favicon=${faviconAt}) — ` +
            'before it, the engine mark would shadow every project\'s own icon')
    })
})

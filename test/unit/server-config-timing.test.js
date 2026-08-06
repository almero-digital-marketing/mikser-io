// Server settings that come from mikser.config.js must be read after the config is loaded.
//
// Phases run initialize -> initialized -> load -> loaded. setupServer() creates the Express
// app in `initialized`, while config.js populates runtime.config in `load` — so anything read
// from runtime.config during `initialized` sees an empty object and takes its default,
// silently, with the option appearing to work.
//
// These assert the ordering PROPERTY rather than specific settings, because the same trap
// catches the next option added to that block.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = (f) => path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src', f)

describe('server config is read after the config is loaded', () => {
    it('runtime runs initialized BEFORE load, so config is absent during initialized', async () => {
        // The premise the rest of the file rests on. If the phase order changes, these tests
        // need re-reasoning rather than to keep passing.
        const runtime = await readFile(src('runtime.js'), 'utf8')
        const at = (name) => runtime.indexOf(`this.hooks.${name}`)
        assert.ok(at('initialized') > -1 && at('load') > -1, 'both phases are dispatched')
        assert.ok(at('initialized') < at('load'), 'initialized is dispatched before load')
    })

    it('config.js populates runtime.config from a load hook', async () => {
        const config = await readFile(src('config.js'), 'utf8')
        assert.match(config, /onLoad\(/, 'config is loaded in the load phase')
        assert.match(config, /runtime\.config\s*=/, 'and it is what assigns runtime.config')
    })

    it('the onInitialized block does NOT read runtime.config', async () => {
        // Anything read there is read too early.
        const server = await readFile(src('server.js'), 'utf8')
        const start = server.indexOf('onInitialized(')
        assert.ok(start > -1, 'setupServer registers an onInitialized hook')
        // The early block ends where the late-binding onLoad begins.
        const end = server.indexOf('onLoad(', start)
        assert.ok(end > start, 'the late-binding onLoad hook follows it')

        let early = server.slice(start, end)

        // A read inside a PER-REQUEST callback is fine — it runs long after the config is
        // loaded, which is exactly the fix CORS uses. Cut that span out before counting, and
        // let the CORS test below prove it really is per-request.
        const cbStart = early.indexOf('cors((req, callback)')
        if (cbStart > -1) early = early.slice(0, cbStart) + early.slice(early.indexOf('}))', cbStart))

        // Comments may legitimately mention runtime.config to explain the ordering, so strip
        // them before checking for real reads.
        const code = early
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .filter(l => !l.trim().startsWith('//'))
            .join('\n')

        const reads = [...code.matchAll(/runtime\.config[?.[]/g)]
        assert.equal(
            reads.length, 0,
            'runtime.config is read eagerly in the onInitialized block, where it is always ' +
            'empty — read it in the onLoaded hook, or lazily inside a per-request callback',
        )
    })

    it('trust proxy is applied where runtime.config exists', async () => {
        const server = await readFile(src('server.js'), 'utf8')
        const applied = server.indexOf("set('trust proxy'")
        const late = server.lastIndexOf('onLoaded(')
        assert.ok(applied > -1, 'trust proxy is set somewhere')
        assert.ok(applied > late, 'and it is set inside the late onLoaded hook')
    })

    it('CORS decides per request, so its config read is not frozen at startup', async () => {
        // CORS cannot simply move late: the middleware's POSITION matters (ahead of static
        // and every plugin router), so it is registered early and decided per request.
        const server = await readFile(src('server.js'), 'utf8')
        const cb = server.indexOf('app.use(cors((req, callback)')
        assert.ok(cb > -1, 'CORS uses the per-request callback form')
        const body = server.slice(cb, server.indexOf('}))', cb))
        assert.match(
            body, /runtime\.config\.server\?\.cors/,
            'the cors setting is read inside the callback, not captured at registration',
        )
    })
})

// A WebDAV mount answers its own OPTIONS, with the DAV header Windows needs.
//
// The Microsoft WebDAV redirector decides whether a URL is a share AT ALL from
// the `DAV:` header on OPTIONS. It is discovery, not a CORS preflight — and
// the global CORS middleware was answering it: 204, no DAV header, five REST
// verbs. Explorer reported "The network name cannot be found" (0x80070043) and
// never reached the credential prompt, on an endpoint whose PROPFIND returned
// 207 and whose LOCK returned 201.
//
// It stayed invisible because every other DAV client works. Finder, curl,
// Cyberduck and gvfs do not gate on that header, so this read as "WebDAV is
// broken on Windows" with the mount logged happily and a 204 that looks
// exactly like a normal preflight. No log line anywhere said otherwise.
//
// An integration test because the defect lived in middleware ORDER: CORS is
// mounted at onLoad, the mount at onLoaded, and Express runs middleware in
// registration order. Nothing about either piece is wrong on its own — the
// engine logged the mount, nephele computed `DAV: 1, 3, 2` and an Allow list
// with PROPFIND, and the 204 threw it away.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { setupFixture, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml } from 'mikser-io'
import { drive } from 'mikser-io-drive'

export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        // Loopback-only by default, which is what the test reaches it on.
        drive({ endpoints: { content: { folder: 'documents' }, readonly: { folder: 'documents', readOnly: true } } }),
    ],
}
`

async function serve(workdir) {
    const port = 31000 + Math.floor(Math.random() * 9000)
    const proc = spawn('node', ['--no-warnings', path.join(MIKSER_ROOT, 'app.js'),
        '--working-folder', workdir, '--server', String(port)],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
    let log = ''
    proc.stdout.on('data', d => { log += d.toString() })
    proc.stderr.on('data', d => { log += d.toString() })

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !/Server listening/.test(log)) {
        await new Promise(r => setTimeout(r, 100))
    }
    return {
        port, get log() { return log },
        stop: () => new Promise((resolve) => {
            proc.once('exit', resolve)
            proc.kill('SIGTERM')
            setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 5000)
        }),
    }
}

describe('OPTIONS on a WebDAV mount', () => {
    const workdir = freshWorkdir('webdav-options')
    let server
    after(async () => { if (server) await server.stop(); await cleanup(workdir) })

    it('reports the DAV compliance classes and the DAV verbs', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/note.md': '---\ntitle: Note\n---\nbody\n',
        })
        server = await serve(workdir)
        assert.match(server.log, /WebDAV mounted/, server.log)

        const res = await fetch(`http://127.0.0.1:${server.port}/drive/content/`, { method: 'OPTIONS' })

        const dav = res.headers.get('dav')
        assert.ok(dav, 'no DAV header — this is the bug: Windows cannot tell this is a share\n'
            + `status ${res.status}, headers: ${JSON.stringify([...res.headers])}`)
        // Class 1 is baseline, class 2 is locking. LOCK works on this server,
        // so claiming 2 is honest — and Explorer wants it for a writable drive.
        const classes = dav.split(',').map(s => s.trim())
        assert.ok(classes.includes('1'), `DAV: ${dav}`)
        assert.ok(classes.includes('2'), `DAV: ${dav} — locking is supported, so it must be advertised`)

        const allow = res.headers.get('allow') ?? ''
        for (const verb of ['PROPFIND', 'LOCK', 'MKCOL', 'MOVE']) {
            assert.match(allow, new RegExp(verb), `Allow: ${allow}`)
        }
    })

    it('still answers an ordinary CORS preflight for a route that does not own OPTIONS', async () => {
        // The other half. /mcp and /app WANT the 204: their clients are
        // browsers completing a real preflight, which is why the mcp plugin
        // teaches CORS about mcp-session-id. Turning the preflight off
        // globally would have broken them to fix WebDAV.
        const res = await fetch(`http://127.0.0.1:${server.port}/nothing-mounted-here`, {
            method: 'OPTIONS',
            headers: { origin: 'http://example.com', 'access-control-request-method': 'GET' },
        })
        assert.equal(res.status, 204, 'CORS still terminates the preflight where nobody else does')
        assert.equal(res.headers.get('access-control-allow-origin'), '*')
    })

    it('advertises a read-only mount without the write verbs', async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/drive/readonly/`, {
            method: 'OPTIONS',
            headers: { origin: 'http://example.com', 'access-control-request-method': 'PROPFIND' },
        })
        const advertised = res.headers.get('access-control-allow-methods') ?? ''
        assert.match(advertised, /PROPFIND/, `allow-methods: ${advertised}`)
        assert.doesNotMatch(advertised, /\bPUT\b/,
            `a read-only mount must not advertise PUT — allow-methods: ${advertised}`)
    })
})

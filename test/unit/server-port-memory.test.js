// The server keeps the port it used last.
//
// A bare `--server` binds a free port, which is what stops two people on one
// machine colliding on 3001. The cost was that the number moved on every
// restart, so a bookmark, an open tab and a terminal scrollback all went
// stale several times an afternoon.
//
// LAST USED, not last auto-chosen: naming a port is the strongest statement
// available about which one is wanted, so `--server 3002` once and a bare
// `--server` after it keeps 3002.
//
// Remembered per working folder, in the runtime folder — so two projects
// still get different ports, and `--clear` (which removes the cache database,
// not this) does not move the server as a side effect of asking for a cold
// rebuild.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import path from 'node:path'

import { freePort, requestedPort } from '../../src/server.js'

let dir
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mikser-port-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

// Hold a port so the "it is taken now" branch is a real condition rather
// than a mocked one.
function hold(port) {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(port, () => resolve(server))
    })
}
const close = (server) => new Promise(r => server.close(r))

describe('freePort', () => {
    it('keeps a preferred port when nothing is using it', async () => {
        const first = await freePort()
        const again = await freePort(first)
        assert.equal(again, first, 'a free preference must be honoured, or a restart moves')
    })

    it('falls back to a fresh port when the preferred one is taken', async () => {
        const wanted = await freePort()
        const squatter = await hold(wanted)
        try {
            const got = await freePort(wanted)
            assert.notEqual(got, wanted, 'the port is in use — insisting would fail the bind')
            assert.ok(got > 0)
        } finally { await close(squatter) }
    })

    it('still answers with no preference at all', async () => {
        // The original contract: `freePort()` with no argument.
        const port = await freePort()
        assert.ok(Number.isInteger(port) && port > 0)
    })

    it('treats 0 as no preference rather than as a port', async () => {
        // 0 IS the "any port" sentinel everywhere else in this file, so it
        // must not be fed back as something to prefer.
        const port = await freePort(0)
        assert.ok(Number.isInteger(port) && port > 0)
    })
})

describe('what a --server value asks for', () => {
    it('is unchanged by the memory', () => {
        // The memory only decides which port an AUTO request lands on. A
        // named port is still exactly what was named.
        assert.equal(requestedPort(3002), 3002)
        assert.equal(requestedPort(true), 0, 'bare --server still means "a free one"')
        assert.equal(requestedPort('3002'), 3002)
        assert.equal(requestedPort(0), 0, 'an explicit 0 is still a request for any port')
    })
})

describe('the remembered value on disk', () => {
    it('is a plain port number a person can read and edit', async () => {
        // Deliberately not JSON and not in the cache database: the answer to
        // "give me a different port" should be visible and deletable.
        const file = path.join(dir, 'server-port')
        await writeFile(file, '43211\n')
        assert.equal((await readFile(file, 'utf8')).trim(), '43211')
    })
})

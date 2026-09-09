// Which port `--server` asks for, and what 0 means.
//
// 0 means "a port nothing is using", and it is what a bare `--server` asks
// for. The case: two accounts running mikser on one dev box. A fixed default
// is a number they both get, so the second one dies on a collision that has
// nothing to do with either project, and neither can pick another without
// asking the other — while all either of them wanted was "a port".
//
// The trap this file exists for is that 0 is FALSY. The resolution used to be
// `Number(x) || 3001`, so an explicit `--server 0` silently meant 3001 —
// precisely the collision it was asking to avoid — and a 0 left to travel
// further would have been read as "no server at all" by four separate
// truthiness tests across three packages.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'

import { requestedPort, freePort } from '../../src/server.js'

describe('requestedPort', () => {
    it('takes a named port literally', () => {
        assert.equal(requestedPort(3002), 3002)
        assert.equal(requestedPort('3002'), 3002, 'commander hands over strings')
    })

    it('reads a bare --server as 0, meaning a free port', () => {
        // commander gives `true` for an option declared `[port]` with no value.
        assert.equal(requestedPort(true), 0)
    })

    it('keeps an explicit 0 as 0 — the falsy trap', () => {
        // `Number('0') || 3001` is 3001. That is the whole bug.
        assert.equal(requestedPort(0), 0)
        assert.equal(requestedPort('0'), 0)
    })

    it('falls back to a free port for anything unparseable', () => {
        // A bad value should not throw during bring-up, and the fallback is
        // now "ask for a free one" rather than a number someone else may hold.
        for (const value of ['abc', '', NaN, undefined, null, 1.5, -1]) {
            assert.equal(requestedPort(value), 0, JSON.stringify(value))
        }
    })
})

describe('freePort', () => {
    it('returns a port that can then actually be bound', async () => {
        const port = await freePort()
        assert.ok(Number.isInteger(port) && port > 0, `not a port: ${port}`)

        // It must be RELEASED, not held — the probe exists to name a port for
        // someone else to bind, so a probe that kept it would hand over a
        // number guaranteed to fail.
        await new Promise((resolve, reject) => {
            const server = createServer()
            server.once('error', reject)
            server.listen(port, () => server.close(resolve))
        })
    })

    it('does not hand out the same port twice in a row', async () => {
        // Not a guarantee the OS makes in general, but a probe that returned
        // one port forever would defeat the entire point on the machine this
        // is for: two processes asking at the same moment.
        const first = await freePort()
        const holder = createServer()
        await new Promise((resolve, reject) => {
            holder.once('error', reject)
            holder.listen(first, resolve)
        })
        try {
            const second = await freePort()
            assert.notEqual(second, first,
                'the OS handed out a port that is currently held')
        } finally {
            await new Promise(resolve => holder.close(resolve))
        }
    })
})

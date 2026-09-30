// The server keeps the port it used last, across restarts.
//
// A bare `--server` binds a free port, which is what stops two people on one
// machine colliding on 3001. The cost was that the number moved on every
// restart, so a bookmark, an open tab and a terminal scrollback went stale
// several times an afternoon.
//
// Subprocesses, because "across restarts" cannot be tested any other way —
// and the engine's load hooks do not settle under `node --test` regardless.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupFixture } from './_harness.js'

const run = promisify(execFile)
const probe = fileURLToPath(new URL('./fixtures/port-restart-probe.mjs', import.meta.url))
const dirs = []
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

let cached = null
async function restarts() {
    if (cached) return cached          // four real builds; run them once
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-port-'))
    dirs.push(dir)
    await setupFixture(dir, {
        'mikser.config.js': "import { documents } from 'mikser-io'\nexport default { plugins: [documents()] }\n",
        'documents/a.md': '# a\n',
    })
    const { stdout } = await run(process.execPath, ['--no-warnings', probe, dir], { timeout: 240_000 })
    cached = JSON.parse(stdout.trim().split('\n').pop())
    return cached
}

describe('a bare --server across restarts', () => {
    it('binds the same port it used last time', async () => {
        const seen = await restarts()
        assert.ok(seen.first > 0, `no port on the first run: ${JSON.stringify(seen)}`)
        assert.equal(seen.second, seen.first,
            'the port moved between restarts, which is what this exists to stop')
    })

    it('says so, rather than looking like a coincidence', async () => {
        const seen = await restarts()
        assert.match(seen.secondNote, /same one as last time/)
    })

    it('remembers a NAMED port too — "last used", not "last auto-chosen"', async () => {
        // Naming a port is the strongest statement available about which one
        // is wanted. Forgetting it the moment the flag is dropped would make
        // the memory useless exactly where it was most deliberate.
        const seen = await restarts()
        assert.equal(seen.afterNamed, 3457,
            `a bare --server after --server 3457 should keep 3457, got ${seen.afterNamed}`)
        assert.equal(seen.remembered, 3457, 'and the file on disk should say so')
    })
})

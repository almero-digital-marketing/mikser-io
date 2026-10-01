// A source touched from inside a cycle must still be imported.
//
// Reported from production. A plugin keeps derived pages in step with the
// document they come from, and re-derives by touching its sources from
// `onProcess` — the documented way to put a file back through the source
// gate. It touched 47 PDFs, every mtime updated, two cycles completed, and
// not one file was re-imported. The same touch from a shell while idle was
// picked up in two seconds.
//
// Delivered immediately, the sync journals the entity behind a cycle that has
// already passed its source gate and its dispatch. Later phases still walk the
// journal, so the catalog is updated and the change is half-applied — and then
// onFinalized clears the journal, so the next cycle starts with nothing to do
// and the entity never renders. Nothing errors; the build is green twice.
//
// Worse than a missed rebuild, which is why it is a scenario rather than a
// note: the plugin had already stamped the change as handled at the moment it
// touched, so nothing retried — including across restarts, which is the case
// the stamp exists for — and 46 pages served four-day-old prices with nothing
// in the log to say so.
//
// Subprocess, because this needs a real watcher and the engine's load hooks do
// not settle under `node --test`.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const probe = fileURLToPath(new URL('./fixtures/touch-from-cycle-probe.mjs', import.meta.url))
const dirs = []
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

let cached = null
async function touchFromCycle() {
    if (cached) return cached
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-touch-'))
    dirs.push(dir)
    const { stdout } = await run(process.execPath, ['--no-warnings', probe, dir], { timeout: 120_000 })
    cached = JSON.parse(stdout.trim().split('\n').pop())
    return cached
}

describe('a plugin that touches its sources from onProcess', () => {
    it('gets every touched file imported', async () => {
        const seen = await touchFromCycle()
        assert.deepEqual(seen.imported, ['a.pdf', 'b.pdf', 'c.pdf'],
            `only ${seen.importedCount} import(s) — a touch that reports success and '
            + 'imports nothing is the failure this exists to stop`)
    })

    it('runs another cycle to carry them, rather than silently finishing', async () => {
        // The deferred events replay after the cycle, each journalling and
        // scheduling exactly as it would have a moment later.
        const seen = await touchFromCycle()
        assert.ok(seen.cycles >= 2, `expected a second cycle, saw ${seen.cycles}`)
    })
})

// A restarted cycle must not destroy work it never did.
//
// An entity journalled but not yet processed when a cycle restarts was
// silently orphaned: `onCancelled` deleted every pending row, and the
// restarted cycle did not re-journal it — the source gate compares
// checksums, finds the file unchanged and emits nothing. The entity then sat
// in the catalog with empty meta, no output, and no journal entry any future
// cycle would look at, under a green "Mikser completed". Touching the file
// was the only way to get it back.
//
// Reported against a 4 MB PDF uploaded over WebDAV: the upload landed
// mid-cycle, the restart deleted its CREATE entry, and the page was never
// produced. Nothing was specific to the plugin that noticed — any consumer
// doing real work between a journal read and its write-back had the hole.
//
// The asymmetry was the tell: a CRASH leaves these rows and `--resume`
// continues from them; a restart deliberately deleted them.
//
// In a subprocess because the engine's load hooks do not settle under
// `node --test`. The alternative was a test that boots less than a real
// cycle, which is exactly the shape that would have passed while production
// dropped the work.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const probe = fileURLToPath(new URL('./fixtures/restart-probe.mjs', import.meta.url))
const dirs = []

after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

async function restartMidCycle() {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-restart-'))
    dirs.push(dir)
    const { stdout } = await run(process.execPath, ['--no-warnings', probe, dir], { timeout: 60_000 })
    return JSON.parse(stdout.trim().split('\n').pop())
}

describe('a cycle restarted while a consumer is still working', () => {
    it('leaves every unprocessed entity to the restarted cycle', async () => {
        const seen = await restartMidCycle()
        assert.ok(seen.first > 0, 'precondition: the cancelled cycle had picked the work up')
        assert.equal(seen.second, seen.journalled,
            `the restarted cycle saw ${seen.second} of ${seen.journalled} entries — `
            + 'the rest are orphaned: in the catalog, unprocessed, and nothing will look at them again')
    })
})

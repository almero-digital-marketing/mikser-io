// The net under the cleanup fix.
//
// A superseded DELETE left a catalog entity with a layout, a destination,
// an output that had been written and then unlinked, and NO snapshot. That
// last part is why it was permanent: missingOutputIds() walks SNAPSHOTS, so
// an entity that never got one is invisible to it, and the source gate sees
// the file unchanged and never journals it again. Permanently missing page,
// green builds forever, and only --audit-output ever said so.
//
// The cause is fixed (superseded-delete.test.js). This covers the state it
// used to leave behind, so the next bug of that shape is recoverable rather
// than permanent.
//
// The danger in a net like this is that it never stops firing. An entity
// that legitimately cannot render — a layout that produces no destination,
// which `mikser_explain` names as a real case — has no snapshot and never
// will, so a naive version re-dispatches it every cycle for the life of the
// process: slower builds, nothing to point at. Hence one claim per entity,
// and the tests below pin both halves of that.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const probe = fileURLToPath(new URL('./fixtures/superseded-delete-probe.mjs', import.meta.url))
const dirs = []

after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

async function ask(scenario) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-unrendered-'))
    dirs.push(dir)
    const { stdout } = await run(process.execPath, ['--no-warnings', probe, dir, scenario],
        { timeout: 60_000 })
    return JSON.parse(stdout.trim().split('\n').pop())
}

describe('an entity with a layout that never recorded a snapshot', () => {
    it('is dispatched, so a missing page is recoverable rather than permanent', async () => {
        const out = await ask('net-recover')
        assert.equal(out.recovers, true,
            'nothing else looks at an entity with no snapshot — this is the only net')
    })

    it('is dispatched ONCE per process, not once per cycle', async () => {
        // The whole safety of it. An entity whose layout yields no
        // destination will never record a snapshot, so a set that is re-read
        // each cycle hands back the same entity forever.
        const out = await ask('net-recover')
        assert.equal(out.repeats, false,
            'a second ask must not re-offer the same entity, or an un-renderable one churns forever')
    })

    it('leaves a FAILED render alone', async () => {
        // A failed render writes no snapshot on purpose, so the last good
        // bytes survive, and the retry path owns that case. Re-dispatching
        // here would fight the mechanism that exists for it.
        const out = await ask('net-failed')
        assert.equal(out.recovers, false)
    })

    it('says nothing on a cold build, where no snapshot exists yet', async () => {
        // Every entity qualifies before anything has rendered. Without this
        // guard a first build answers `never-recorded` for the whole corpus —
        // true, useless, and it takes the real reason off every page in
        // `--json`.
        const out = await ask('net-cold')
        assert.equal(out.recovers, false)
    })

    it('ignores an entity with no layout', async () => {
        // No layout means nothing was ever going to render, so there is
        // nothing to recover and no reason to look again.
        const out = await ask('net-no-layout')
        assert.equal(out.recovers, false)
    })
})

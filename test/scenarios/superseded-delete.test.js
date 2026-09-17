// A superseded DELETE must not unlink a page that was just written.
//
// An entity rendering for the FIRST time in a cycle that also carries a
// DELETE for its OWN id had its output written and then removed inside that
// cycle: `Rendered: 1`, `Output finished: 1`, a green build, a correct
// catalog row, NO snapshot, and an output directory that exists and is
// empty. The empty directory is the signature — writeOutput does mkdir then
// writeFile, and unlink takes the file and leaves the directory.
//
// The staging and the `claimedByThisCycle` guard were both written for the
// RENAME case, where the DELETE carries the OLD id and the RENDER a NEW one.
// There the new destination is protected. When a file is REPLACED AT THE
// SAME PATH the ids are equal, so the guard skipped the destination just
// written, `stillClaimed` was empty because a first render has no snapshot
// row yet, and the unlink ran.
//
// It needs 11.10.2 to appear: before that a cancelled cycle's entries were
// dropped and the stale DELETE went with them. That fix is right and stays —
// it traded an orphaned ENTITY for an orphaned OUTPUT, and both ends are
// asserted here and in restart-carries-work.test.js so neither returns while
// the other is fixed.
//
// Nothing recovered it: the source gate saw the file unchanged, and
// missingOutputIds() iterates SNAPSHOTS, so an entity that never got one is
// invisible to it. Only --audit-output ever said so.
//
// Driven through a subprocess because the engine's load hooks do not settle
// under `node --test`.

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

async function cleanup(scenario) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-superseded-'))
    dirs.push(dir)
    const { stdout } = await run(process.execPath, ['--no-warnings', probe, dir, scenario],
        { timeout: 60_000 })
    return JSON.parse(stdout.trim().split('\n').pop())
}

describe('manifest cleanup against a journal carrying both', () => {
    it('keeps the output when a later CREATE superseded the DELETE', async () => {
        // The report: create, delete, re-create at the same path while the
        // cycle is held open, then the first render of that id.
        const out = await cleanup('replaced')
        assert.equal(out.exists, true,
            'the page was written this cycle and nothing deleted the entity — the file must stand')
        assert.equal(out.snapshots, 1,
            'and it must have a snapshot, or nothing can ever notice it is missing')
    })

    it('keeps the output when the re-appearance arrives as an UPDATE', async () => {
        // useSource writes through updateEntity when the watch event is a
        // `change` rather than an `add` — which is what a client still
        // writing chunks of the same file produces, and the original report
        // came from a 4 MB upload over WebDAV. An UPDATE supersedes a DELETE
        // exactly as a CREATE does, and a fix that only looked at CREATE
        // would leave the reported case half-broken.
        const out = await cleanup('replaced-by-update')
        assert.equal(out.exists, true)
        assert.equal(out.snapshots, 1)
    })

    it('still unlinks a genuine delete', async () => {
        const out = await cleanup('deleted')
        assert.equal(out.exists, false, 'a deleted entity takes its output with it')
        assert.equal(out.snapshots, 0)
    })

    it('still protects a rename that lands on the same destination', async () => {
        // index.md → index.yml: different ids, shared destination. The case
        // the guard was built for, and the one a supersession fix could
        // plausibly break.
        const out = await cleanup('renamed')
        assert.equal(out.exists, true, "the new entity's freshly written output must survive")
        assert.equal(out.snapshots, 1)
    })

    it('still lets the DELETE win for a catalog-neutral render', async () => {
        // `save: true, catalog: false` journals its own DELETE once the
        // render resolves — after the entity's CREATE — so the DELETE is
        // genuinely later and must win. This is why supersession compares
        // order rather than mere presence of a CREATE.
        const out = await cleanup('neutral')
        assert.equal(out.exists, false, 'a neutral render leaves nothing behind')
        assert.equal(out.snapshots, 0, 'and records no snapshot')
    })

    it('leaves no snapshot claiming a file that is not there', async () => {
        // What --audit-output calls "missing", and the only thing that ever
        // reported this bug. Asserted for every case, because a fix that
        // kept the file but dropped the snapshot — or the reverse — would
        // look fine on the two assertions above and still be wrong.
        for (const scenario of ['replaced', 'replaced-by-update', 'deleted', 'renamed', 'neutral']) {
            const out = await cleanup(scenario)
            assert.equal(out.missing, 0, `${scenario} left ${out.missing} snapshot(s) with no file`)
        }
    })

    it('says nothing alarming in any of them', async () => {
        for (const scenario of ['replaced', 'replaced-by-update', 'deleted', 'renamed', 'neutral']) {
            const out = await cleanup(scenario)
            assert.equal(out.warnings, 0, `${scenario} logged ${out.warnings} warning(s)`)
        }
    })
})

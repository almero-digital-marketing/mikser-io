// A file that moves while it is being watched must not kill the process.
//
// Reported from a live site during a video upload. The tool writes a
// temporary file with a UUID name into the watched folder and renames it
// afterwards — which is what a WebDAV client, Finder and rsync without
// --inplace all do. chokidar announced `add` for a name that was about to
// stop existing, files.js called checksum(), stat threw ENOENT, and the
// rejection reached nobody: the hooks were invoked without await from the
// listener, and there was no unhandledRejection handler. Node printed the
// error and exited 1. Four times in one afternoon, and each time the entire
// signal was "the server is gone".
//
// The quieter half was worse, because nothing stopped. A derivative was built
// from a file read mid-write: its checksum note held
// d41d8cd98f00b204e9800998ecf8427e — the md5 of nothing — where a file that
// size must carry `size:head:tail`. Zero bytes read, derivative published,
// declared current, and the next build agreed. Silently wrong output beats a
// crash for damage every time.
//
// Three defences, and the report was right that any one of them stops the
// crash. All three are here because they fail differently: waiting for the
// write to finish is what stops the corruption, ENOENT tolerance is what
// stops the crash when the wait is not enough, and neither helps the next
// unhandled rejection nobody has found yet.
//
// In a subprocess because the engine's load hooks do not settle under
// `node --test`.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const probe = fileURLToPath(new URL('./fixtures/vanishing-file-probe.mjs', import.meta.url))
const dirs = []

after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

async function upload() {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-vanishing-'))
    dirs.push(dir)
    const { stdout } = await run(process.execPath, ['--no-warnings', probe, dir], { timeout: 90_000 })
    return JSON.parse(stdout.trim().split('\n').pop())
}

describe('an upload that writes a temporary file and renames it', () => {
    it('leaves the process alive', async () => {
        // The whole report in one assertion: this used to exit 1.
        const out = await upload()
        assert.equal(out.alive, true)
    })

    it('never announces the temporary name at all', async () => {
        // The root fix. awaitWriteFinish means the event comes after the size
        // has stopped moving, by which time the rename has happened and there
        // is no vanishing file to read — so the crash and the half-written
        // checksum both stop being reachable, rather than being survived.
        const out = await upload()
        assert.equal(out.temporaryAnnounced, 0,
            'an event for a name that is about to be renamed away is the whole race')
    })

    it('survives an ENOENT that gets through anyway, and says which file', async () => {
        // The second defence, because the first is a race it narrows rather
        // than a race it removes: a slow enough link, a long enough stall, and
        // an event still arrives for a file that has moved. A watcher's event
        // describes a moment that has already passed, so a file that is gone
        // is an ordinary state and belongs in the report, not in an exit code.
        const out = await upload()
        assert.equal(out.raceAnnounced, true, 'precondition: the file was announced')
        assert.equal(out.vanished, 1, 'the disappearance must be reported once, by path')
        assert.equal(out.errors, 0, 'and not escalated to an error')
    })
})

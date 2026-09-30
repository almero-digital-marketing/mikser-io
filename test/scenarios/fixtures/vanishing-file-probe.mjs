// Driven by vanishing-file.test.js, in its own process.
//
// Reproduces the upload race: a file appears in a watched folder under a
// temporary name and is renamed away before anything can read it. That is
// what a WebDAV client, Finder, and rsync without --inplace all do, and it
// used to kill the process — chokidar reported `add`, files.js called
// checksum(), stat threw ENOENT, and the rejection reached nobody.
//
// argv[2] working folder.
import { mkdir, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import '../../../index.js'
import runtime from '../../../src/runtime.js'
import { watch } from '../../../src/manager.js'
import { ACTION } from '../../../src/constants.js'

const dir = process.argv[2]
const media = path.join(dir, 'media')
await mkdir(media, { recursive: true })
await mkdir(path.join(dir, 'runtime'), { recursive: true })

const warnings = []
const errors = []
const quiet = () => {}
runtime.options = { ...runtime.options, workingFolder: dir, watch: true,
    outputFolder: path.join(dir, 'out'), runtimeFolder: path.join(dir, 'runtime') }
runtime.engine = { logger: {
    info: quiet, debug: quiet, trace: quiet, notice: quiet, fatal: quiet,
    warn: (...a) => warnings.push(typeof a[0] === 'object' ? a[0] : { message: String(a[0]) }),
    error: (...a) => errors.push(String(a[0])) } }
runtime.started = true

// The sync hook a source plugin registers: it reads the file, the way
// files.js does through checksum().
//
// For `race.mp4` it deletes the file first, which makes the vanishing
// deterministic instead of a matter of timing — the same ENOENT from the same
// call, arriving through the same watcher path.
const { stat, unlink } = await import('node:fs/promises')
const seen = []
runtime.hooks.sync = [async ({ action, context }) => {
    if (action !== ACTION.CREATE) return false
    seen.push(context.relativePath)
    const file = path.join(media, context.relativePath)
    if (context.relativePath === 'race.mp4') await unlink(file)
    await stat(file)          // ENOENT exactly as checksum() would raise it
    return true
}]

// The real watcher, with the real defaults.
watch('media', media)

// Let it finish its initial scan. `ignoreInitial` is on, so a file created
// before the watcher is ready is part of that scan and never announced —
// which silently made an earlier version of this probe pass whether the fix
// was there or not.
await new Promise(r => setTimeout(r, 800))

// The upload: a temporary name, then a rename, with nothing in between.
const temporary = path.join(media, `${randomUUID()}`)
await writeFile(temporary, Buffer.alloc(64 * 1024, 1))
// Long enough that a watcher with no settle time announces it — an upload
// takes far longer than this — and short enough to be renamed away well
// inside the 500ms the engine waits for the size to stop moving. Without the
// pause the rename lands in the same tick and chokidar coalesces it on its
// own, which makes the test pass whether the fix is there or not.
await new Promise(r => setTimeout(r, 250))
await rename(temporary, path.join(media, 'video.mp4'))

// Long enough for awaitWriteFinish to settle and any event to arrive.
await new Promise(r => setTimeout(r, 2500))

// Second: a file that IS announced and then is not there when the hook reads
// it. The watcher has to survive that and say so.
await writeFile(path.join(media, 'race.mp4'), Buffer.alloc(64 * 1024, 2))
await new Promise(r => setTimeout(r, 2500))

console.log(JSON.stringify({
    alive: true,
    // Events the watcher delivered for the temp name. Zero is the root fix:
    // awaitWriteFinish means the rename happened before anything was said.
    temporaryAnnounced: seen.filter(name => name.includes('-')).length,
    raceAnnounced: seen.includes('race.mp4'),
    vanished: warnings.filter(w => w.code === 'source-vanished').length,
    errors: errors.length,
}))
process.exit(0)

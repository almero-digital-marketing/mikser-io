// Driven by touch-from-cycle.test.js, in its own process.
//
// The reported shape: a plugin keeps derived pages in step with the document
// they come from, and re-derives by TOUCHING its sources from inside
// `onProcess`. The touches land, the cycle finishes, and the files must be
// re-imported by a later cycle.
//
// argv[2] working folder.
import { mkdir, writeFile, utimes } from 'node:fs/promises'
import path from 'node:path'
import '../../../index.js'
import runtime from '../../../src/runtime.js'
import { watch } from '../../../src/manager.js'
import { ACTION } from '../../../src/constants.js'

const dir = process.argv[2]
const media = path.join(dir, 'media')
await mkdir(media, { recursive: true })
await mkdir(path.join(dir, 'runtime'), { recursive: true })
for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
    await writeFile(path.join(media, name), `${name} contents`)
}

const quiet = () => {}
runtime.options = { ...runtime.options, workingFolder: dir, watch: true,
    outputFolder: path.join(dir, 'out'), runtimeFolder: path.join(dir, 'runtime') }
runtime.engine = { logger: { info: quiet, warn: quiet, error: quiet, debug: quiet,
    trace: quiet, notice: quiet, fatal: quiet } }
runtime.started = true

// Stands in for a source plugin: every file event becomes an import.
const imported = []
runtime.hooks.sync = [async ({ action, context }) => {
    if (action !== ACTION.CREATE && action !== ACTION.UPDATE) return false
    imported.push(context.relativePath)
    return true
}]

watch('media', media)
await new Promise(r => setTimeout(r, 800))      // let the initial scan settle

// The plugin: on its first cycle, it touches its own sources.
let cycles = 0
let touched = false
runtime.hooks.process.push(async () => {
    cycles++
    if (touched) return
    touched = true
    const when = new Date()
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) {
        await utimes(path.join(media, name), when, when)
    }
    // The cycle KEEPS RUNNING after the touch, which is the whole condition.
    // A real cycle is doing work — the reported one was deriving readings —
    // so the watcher's events land while it is still in flight. Without this
    // the probe's cycle is over before chokidar says anything, the events
    // arrive at an idle engine, and the test passes whether the fix is there
    // or not. It did, for all three mutations.
    await new Promise(r => setTimeout(r, 2500))
})

await runtime.process()

// Give the watcher time to notice, the deferral time to replay, and the
// cycle it schedules time to run.
await new Promise(r => setTimeout(r, 6000))

console.log(JSON.stringify({
    cycles,
    imported: [...new Set(imported)].sort(),
    importedCount: imported.length,
}))
process.exit(0)

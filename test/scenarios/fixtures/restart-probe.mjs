// Driven by restart-carries-work.test.js, in its own process.
//
// Booting the engine's load hooks inside `node --test` deadlocks — verified,
// and not argv: the hooks simply never settle under the runner. The work
// here is a real cycle against a real journal and database, so it runs where
// that works, and the test reads its verdict.
//
// argv[2] is the working folder.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import '../../../index.js'
import runtime from '../../../src/runtime.js'
import { addEntries, useJournal } from '../../../src/journal.js'
import { OPERATION } from '../../../src/constants.js'

const dir = process.argv[2]
runtime.options.workingFolder = dir
runtime.options.outputFolder = path.join(dir, 'out')
runtime.options.runtimeFolder = path.join(dir, 'runtime')
await mkdir(runtime.options.runtimeFolder, { recursive: true })

const quiet = () => {}
runtime.engine = { logger: { info: quiet, warn: quiet, error: quiet, debug: quiet,
    trace: quiet, notice: quiet, fatal: quiet } }

await runtime.callHooks(runtime.hooks.initialize, undefined, 'initialize')
await runtime.callHooks(runtime.hooks.loaded, undefined, 'loaded')

// The upload lands: entities created and not yet processed by anything.
const ids = ['/sources/report.pdf', '/sources/second.pdf']
await addEntries(ids.map(id => ({
    entity: { id, collection: 'sources', name: path.basename(id), meta: {} },
    operation: OPERATION.CREATE, context: {}, options: {},
})))

// A consumer still awaiting work when the restart happens.
let release
const stalled = new Promise(r => { release = r })
const seen = { first: 0, second: 0 }
let cycle = 0

runtime.hooks.process.push(async (signal) => {
    const mine = ++cycle
    for await (const { entity } of useJournal('probe', [OPERATION.CREATE], signal)) {
        if (!entity) continue
        if (mine === 1) { seen.first++; await stalled }
        else seen.second++
    }
})

const first = runtime.process()
await new Promise(r => setTimeout(r, 50))     // let cycle one reach the await
const second = runtime.process()              // the restart
release()
await Promise.allSettled([first, second])

console.log(JSON.stringify({ journalled: ids.length, ...seen }))
process.exit(0)

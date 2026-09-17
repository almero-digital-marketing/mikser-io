// Driven by superseded-delete.test.js, in its own process, because the
// engine's load hooks do not settle under `node --test`.
//
// Builds the journal the reported cycle carried — CREATE, DELETE, CREATE for
// ONE id, plus that id's first RENDER — runs the manifest's onFinalize, and
// reports whether the freshly written output survived.
//
// argv[2] working folder, argv[3] the case to run.
import { mkdir, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import '../../../index.js'
import runtime from '../../../src/runtime.js'
import { addEntries, updateEntry } from '../../../src/journal.js'
import { OPERATION } from '../../../src/constants.js'
import { useDatabase } from '../../../src/database/index.js'
import { bypassReason, REASON, forgetMissingOutputs } from '../../../src/invalidation.js'

const dir = process.argv[2]
const scenario = process.argv[3] ?? 'replaced'
runtime.options.workingFolder = dir
runtime.options.outputFolder = path.join(dir, 'out')
runtime.options.runtimeFolder = path.join(dir, 'runtime')
await mkdir(runtime.options.runtimeFolder, { recursive: true })
await mkdir(runtime.options.outputFolder, { recursive: true })

const quiet = () => {}
const warnings = []
runtime.engine = { logger: {
    info: quiet, debug: quiet, trace: quiet, notice: quiet, fatal: quiet,
    error: (...a) => warnings.push(String(a[0])),
    warn: (...a) => warnings.push(String(a[0])) } }

await runtime.callHooks(runtime.hooks.initialize, undefined, 'initialize')
await runtime.callHooks(runtime.hooks.loaded, undefined, 'loaded')

const DESTINATION = '/probe/index.html'
const entityFor = (id) => ({
    id, collection: 'documents', name: 'probe', type: 'document',
    destination: DESTINATION, checksum: 'abc', stamp: Date.now(),
})

// The recovery-net scenarios: no journal work at all, just the state a bug of
// this shape leaves behind — a catalog entity with a layout and no snapshot.
if (scenario.startsWith('net-')) {
    const db = useDatabase()
    db.prepare(`INSERT OR REPLACE INTO mikser_entities (id, collection, name, type, meta_layout, data)
                VALUES (?, 'documents', 'probe', 'document', ?, ?)`)
        .run('/documents/probe.md',
             scenario === 'net-no-layout' ? null : 'post',
             JSON.stringify(entityFor('/documents/probe.md')))

    // A previous build recorded SOMETHING, or this is a cold build and there
    // is nothing to recover.
    if (scenario !== 'net-cold') {
        db.prepare(`INSERT OR REPLACE INTO mikser_snapshots (id, destination, inputHash, outputHash, renderedAt)
                    VALUES ('/documents/other.md', '/other/index.html', 'h', 'h', ?)`).run(Date.now())
    }
    // A render that FAILED writes no snapshot on purpose, and the retry path
    // owns that case.
    if (scenario === 'net-failed') {
        db.prepare(`INSERT OR REPLACE INTO mikser_failures
                    (id, destination, error, firstFailedAt, lastFailedAt, attempts)
                    VALUES ('/documents/probe.md', '/probe/index.html', 'boom', ?, ?, 1)`)
            .run(Date.now(), Date.now())
    }
    forgetMissingOutputs()
    const first = bypassReason({ id: '/documents/probe.md' })
    const second = bypassReason({ id: '/documents/probe.md' })
    console.log(JSON.stringify({ scenario,
        recovers: first === REASON.NEVER_RECORDED,
        repeats: second === REASON.NEVER_RECORDED }))
    process.exit(0)
}

// The page this cycle rendered for the first time, already on disk — this is
// the state right after writeOutput: mkdir, then the file.
const filePath = path.join(runtime.options.outputFolder, DESTINATION)
await mkdir(path.dirname(filePath), { recursive: true })
await writeFile(filePath, '<h1>probe</h1>')

// A RENDER entry carries no output when it is added; the renderer attaches
// it afterwards with updateEntry against the row's seq, which is what the
// manifest's Output drain reads. Marked here so the probe can do the same.
const render = (entity) => ({
    entity, operation: OPERATION.RENDER, context: {}, options: {}, _needsOutput: true,
})

const journals = {
    // The report: one file created, deleted, and re-created at the SAME path
    // while the cycle was held open, then rendered for the first time.
    replaced: [
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.CREATE, context: {}, options: {} },
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.DELETE, context: {}, options: {} },
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.CREATE, context: {}, options: {} },
        render(entityFor('/documents/probe.md')),
    ],
    // The same replacement, but the re-appearance arrives as an UPDATE.
    // useSource writes through updateEntity when the watch event is a
    // `change` rather than an `add`, which is what a client still writing
    // chunks of the same file produces — so an UPDATE supersedes a DELETE
    // exactly as a CREATE does.
    'replaced-by-update': [
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.CREATE, context: {}, options: {} },
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.DELETE, context: {}, options: {} },
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.UPDATE, context: {}, options: {} },
        render(entityFor('/documents/probe.md')),
    ],
    // Behaviour 1: a real delete. Nothing re-creates it.
    deleted: [
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.DELETE, context: {}, options: {} },
        render(entityFor('/documents/probe.md')),
    ],
    // Behaviour 2: a rename. DELETE carries the OLD id, RENDER the NEW one,
    // and they share a destination.
    renamed: [
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.DELETE, context: {}, options: {} },
        { entity: entityFor('/documents/probe.yml'), operation: OPERATION.CREATE, context: {}, options: {} },
        render(entityFor('/documents/probe.yml')),
    ],
    // Behaviour 3: `save: true, catalog: false`. The render journals its own
    // DELETE after the entity was created, and the DELETE must win.
    neutral: [
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.CREATE, context: {}, options: {} },
        render(entityFor('/documents/probe.md')),
        { entity: entityFor('/documents/probe.md'), operation: OPERATION.DELETE, context: {}, options: {} },
    ],
}

const batch = journals[scenario]
await addEntries(batch.map(({ _needsOutput, ...entry }) => entry))

// Attach the render output the way the renderer does. Row seq is 1-based and
// follows insertion order within this fresh journal.
for (const [index, entry] of batch.entries()) {
    if (!entry._needsOutput) continue
    await updateEntry({
        id: index + 1,
        output: { success: true, skipped: false, metaReads: [], consumedReads: [] },
    })
}

// The catalog row, as it stands when cleanup runs. For `replaced` and
// `renamed` the surviving entity is present; for `deleted` and `neutral` it
// is not — which is what the catalog-presence test would read.
const db = useDatabase()

const present = { replaced: '/documents/probe.md', 'replaced-by-update': '/documents/probe.md',
    renamed: '/documents/probe.yml' }[scenario]
if (present) {
    db.prepare(`INSERT OR REPLACE INTO mikser_entities (id, collection, name, type, data)
                VALUES (?, 'documents', 'probe', 'document', ?)`)
        .run(present, JSON.stringify(entityFor(present)))
}

process._rawDebug(`[probe] finalize hooks registered: ${runtime.hooks.finalize.length}`)
process._rawDebug(`[probe] manifest open: ${!!runtime.manifest}`)
try {
    await runtime.callHooks(runtime.hooks.finalize, undefined, 'finalize')
} catch (err) {
    process._rawDebug(`[probe] finalize THREW: ${err.message}`)
}

const exists = await access(filePath).then(() => true, () => false)
const snapshots = db.prepare('SELECT COUNT(*) AS n FROM mikser_snapshots WHERE destination = ?')
    .get(DESTINATION).n

// What --audit-output calls "missing": a snapshot claiming a destination
// whose file is not there. That is precisely the state this bug left behind,
// and the only thing that ever reported it.
let missing = 0
for (const row of db.prepare('SELECT destination FROM mikser_snapshots').all()) {
    const claimed = path.join(runtime.options.outputFolder, row.destination)
    if (!await access(claimed).then(() => true, () => false)) missing++
}
// The recovery net: would a later build notice a catalog entity with a
// layout and no snapshot? Asked the way a gate asks, and asked TWICE, because
// the guarantee is one dispatch per entity per process and not one per cycle.
forgetMissingOutputs()
const probeId = present ?? '/documents/probe.md'
const firstAsk = bypassReason({ id: probeId })
const secondAsk = bypassReason({ id: probeId })
const recovers = firstAsk === REASON.NEVER_RECORDED
const repeats = secondAsk === REASON.NEVER_RECORDED

console.log(JSON.stringify({ scenario, exists, snapshots, missing,
    warnings: warnings.length, recovers, repeats }))
process.exit(0)

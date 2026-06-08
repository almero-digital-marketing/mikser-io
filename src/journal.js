import runtime from './runtime.js'
import { onInitialized, onCancelled, onFinalized } from './lifecycle.js'
import knex from 'knex'
import { stopProgress, trackProgress, updateProgress } from './logger.js'
import { AbortError } from './utils.js'

let journal

export async function addEntry({ entity, operation, context, options }) {
    await journal('operations').insert([{ entity, operation, context, options }])
}

export async function addEntries(entries) {
    await journal.batchInsert('operations', entries.map(({ entity, operation, context, options }) => ({
        entity: JSON.stringify(entity),
        operation,
        context: JSON.stringify(context),
        options: JSON.stringify(options)
    })), 10)
}

export async function updateEntry({ id, entity, output }) {
    const data = {}
    if (entity) data.entity = JSON.stringify(entity)
    if (output) data.output = JSON.stringify(output)
    await journal('operations').where({ id }).update(data)
}

export async function* useJournal(name, operations, signal) {
    let query = journal('operations')
    if (operations?.length) {
        query.whereIn('operation', operations)
    }
    let [total] = await query.clone().count()
    total = total['count(*)']
    if (!total) return

    trackProgress(name, total)

    let offset = 0
    const limit = 1000
    let count = 0
    do {
        count = 0
        const entries = await query.clone().orderBy('id').select().offset(offset).limit(limit)
        for (let { id, entity, operation, context, options, output } of entries) {
            if (signal?.aborted) {
                stopProgress()
                throw new AbortError()
            }
            count++

            updateProgress()
            yield {
                id,
                entity: JSON.parse(entity),
                operation,
                context: JSON.parse(context),
                options: JSON.parse(options),
                output: JSON.parse(output)
            }
        }
        offset += limit
    } while (count == limit)
}

export async function clearJournal(aborted) {
    await journal('operations').del()
    if (!aborted) {
        // Tear down the sqlite connection only when this is genuinely a
        // one-shot run that's about to exit. The two ways mikser stays
        // alive across cycles are watch mode (chokidar handles keep the
        // event loop ref'd) and an HTTP server (`runtime.options.app`,
        // set either by --server or by a caller passing setup({ app }));
        // both need the journal to survive subsequent cycles.
        if (runtime.options.watch !== true && !runtime.options.app) {
            journal.destroy()
        }
    }
}

// Initialize the journal in onInitialized rather than onLoaded.
// The engine resolves runtime.options.runtimeFolder in its own
// onInitialized hook; ours runs after (engine.js is imported before
// any plugin loads, so its onInitialized registers first). This way
// every plugin hook from onLoad onwards — including plugin onLoaded
// — can safely call runtime.create / runtime.update without
// depending on the order in which journal.js's module registered
// relative to theirs.
//
// In-memory sqlite: the journal is per-cycle (cleared on onFinalized)
// and nothing outside this module reads journal.db. File-backed mode
// paid for fsyncs we never used. In-memory is roughly an order of
// magnitude faster for write-heavy transient workloads. Watch mode
// still works because the knex connection survives across cycles
// (clearJournal only destroys it in true one-shot mode).
onInitialized(async () => {
    journal = knex({
        client: 'sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
    })

    await journal.schema.createTable('operations', table => {
        table.increments('id')
        table.string('operation').index()
        table.json('entity')
        table.json('context')
        table.json('options')
        table.json('output')
    })
})

onFinalized(async (signal) => {
    await clearJournal(signal.aborted)
})

onCancelled(async () => {
    await clearJournal(true)
})
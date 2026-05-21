import runtime from './runtime.js'
import { onLoaded, onCancelled, onFinalized } from './lifecycle.js'
import { unlink } from 'fs/promises'
import knex from 'knex'
import path from 'path'
import { stopProgress, trackProgress, updateProgress } from './tracking.js'
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
        // one-shot run that's about to exit. Watch mode and any plugin
        // that keeps the process alive (e.g. the API plugin's HTTP server)
        // sets `persistent` so subsequent cycles can still write to the
        // journal — without this, the second /render request would crash
        // with "Unable to acquire a connection".
        if (runtime.options.watch !== true && runtime.options.persistent !== true) {
            journal.destroy()
        }
    }
}

onLoaded(async () => {
    const filename = path.join(runtime.options.runtimeFolder, `journal.db`)
    try {
        await unlink(filename)
    } catch { }

    journal = knex({
        client: 'sqlite3',
        connection: {
            filename
        },
        useNullAsDefault: true
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
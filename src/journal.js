// Per-cycle journal — the producer/consumer queue that all phases use
// to hand work between each other (front-matter → yaml → layouts →
// render → output → postprocess → ...).
//
// Backing store: a plain JS array. The journal is per-cycle (entries
// are appended during the cycle, walked by `useJournal`, then drained
// at onFinalized) and nothing outside this module observes individual
// rows. SQL was over-engineering for a queue that lives for one cycle
// and never gets queried again.
//
// Memory shape per entry: a single object with the fields below. No
// serialization at insert (the previous sqlite-backed version paid
// JSON.stringify on every addEntry/updateEntry and JSON.parse on every
// useJournal yield — gone). Entries are deep-cloned via structuredClone
// at insert / update time so a plugin that mutates the original object
// after passing it to runtime.{create,update,delete} can't retroactively
// rewrite history. Same isolation guarantee the SQL version provided.

import { onInitialized, onCancelled, onFinalized } from './lifecycle.js'
import { stopProgress, trackProgress, updateProgress } from './logger.js'
import { AbortError } from './utils.js'

// Insertion-order array for useJournal's walk + an id-indexed Map for
// O(1) updateEntry. Both point at the same entry objects, so a mutation
// via the Map is visible to walkers. The Map costs ~16 bytes per entry
// at 10k entries — negligible vs the 50M-iteration cost of linear-scan
// updateEntry it replaces.
let entries = []
let byId    = new Map()
let nextId  = 1

function makeEntry({ entity, operation, context, options }) {
    return {
        id:        nextId++,
        operation,
        entity:    entity  != null ? structuredClone(entity)  : entity,
        context:   context != null ? structuredClone(context) : context,
        options:   options != null ? structuredClone(options) : options,
        output:    null,
    }
}

export async function addEntry(entry) {
    const e = makeEntry(entry)
    entries.push(e)
    byId.set(e.id, e)
}

export async function addEntries(batch) {
    for (const entry of batch) {
        const e = makeEntry(entry)
        entries.push(e)
        byId.set(e.id, e)
    }
}

export async function updateEntry({ id, entity, output }) {
    const e = byId.get(id)
    if (!e) return
    if (entity !== undefined) e.entity = structuredClone(entity)
    if (output !== undefined) e.output = structuredClone(output)
}

// Walk the journal yielding entries matching `operations` (or all if
// omitted). The walk is over a SNAPSHOT taken at the call site: entries
// added during iteration are NOT visible to this iterator, which matches
// the old SQL behavior (a SELECT pinned at query time). Plugins that
// want to react to entries they added themselves do it via a fresh
// useJournal in a later phase.
export async function* useJournal(name, operations, signal) {
    const filtered = operations?.length
        ? entries.filter(e => operations.includes(e.operation))
        : entries.slice()
    if (!filtered.length) return

    trackProgress(name, filtered.length)

    for (const entry of filtered) {
        if (signal?.aborted) {
            stopProgress()
            throw new AbortError()
        }
        updateProgress()
        yield entry
    }
}

// Drain. Called by onFinalized / onCancelled. The `aborted` param is
// preserved for API stability but unused — there's no connection to
// tear down anymore.
export async function clearJournal() {
    entries.length = 0
    byId.clear()
    nextId = 1
}

// Bootstrap hook kept so module-level state lives next to its lifecycle
// wiring. Nothing to initialize but the containers (already there).
// Symmetry with catalog.js / refs.js — every engine module declares its
// onInitialized even when there's nothing to do.
onInitialized(async () => {
    entries = []
    byId    = new Map()
    nextId  = 1
})

onFinalized(async () => {
    await clearJournal()
})

onCancelled(async () => {
    await clearJournal()
})

// Per-cycle journal — the producer/consumer queue that every phase
// uses to hand work to the next (front-matter → yaml → layouts →
// render → output → postprocess → ...).
//
// Backed by the `mikser_journal` table in the engine's shared sqlite
// database (ADR-0009). The journal was the last engine subsystem still
// on per-process memory; moving it to sqlite:
//   - bounds memory at any corpus size (rows on disk, iterator streams
//     them through `.iterate()`)
//   - makes the journal crash-survivable — `--resume` continues from
//     a partial run instead of starting fresh
//   - aligns the last holdout with the rest of the substrate
//
// Snapshot semantics on insert: addEntry / updateEntry serialize via
// `JSON.stringify` and store the result. The row is immutable until
// updateEntry runs, so callers can mutate their original objects after
// passing them in without retroactively rewriting history — the same
// isolation guarantee the prior structuredClone gave.
//
// Snapshot semantics on iteration: useJournal returns a `.iterate()`
// over a prepared SELECT. Rows inserted *during* iteration are NOT
// yielded by that walk — sqlite's statement-level snapshot. This
// matches the prior in-memory behavior (which already snapshotted via
// `entries.slice()` at call-time).

import {
    onInitialize,
    onLoaded,
    onCancelled,
    onFinalized,
} from './lifecycle.js'
import { stopProgress, trackProgress, updateProgress } from './logger.js'
import { useLogger } from './engine.js'
import { AbortError } from './utils.js'
import { registerSchema, useDatabase } from './database/index.js'
import runtime from './runtime.js'

const JOURNAL_SCHEMA = `
    CREATE TABLE IF NOT EXISTS mikser_journal (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        operation   TEXT NOT NULL,
        entity      TEXT,
        context     TEXT,
        options     TEXT,
        output      TEXT,
        deps        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mikser_journal_operation ON mikser_journal(operation);
`

// Register at onInitialize, not module-eval. There's a tight circular
// dep — lifecycle.js imports addEntry/addEntries from this file, and
// database/index.js imports lifecycle.js's onLoaded. Calling
// registerSchema at module-eval would hit `schemas` in TDZ inside
// database/index.js's still-evaluating body. By onInitialize all
// module bodies have finished and registerSchema can land in the
// schemas Map safely.
onInitialize(async () => {
    registerSchema('mikser_journal', JOURNAL_SCHEMA)
})

// Prepared statements + handle. Set in onLoaded after the database
// substrate opens; persist across cycles (sqlite stays open for the
// lifetime of the process).
let db = null
let stmtInsert = null
let stmtUpdateEntity = null
let stmtUpdateOutput = null
let stmtUpdateDeps = null
let stmtSelectAll = null
let stmtCount = null
let stmtDelete = null
// Cache prepared SELECTs by operation-tuple so hot paths don't re-prepare.
const selectByOpsCache = new Map()

function stmtSelectByOps(operations) {
    const key = operations.slice().sort().join(',')
    let stmt = selectByOpsCache.get(key)
    if (!stmt) {
        const placeholders = operations.map(() => '?').join(',')
        stmt = db.prepare(`SELECT * FROM mikser_journal WHERE operation IN (${placeholders}) ORDER BY seq`)
        selectByOpsCache.set(key, stmt)
    }
    return stmt
}

function countByOps(operations) {
    const placeholders = operations.map(() => '?').join(',')
    // Cheap query — prepare each time so we don't accumulate statements
    // for ad-hoc operation-tuples we never see again.
    return db.prepare(
        `SELECT COUNT(*) AS n FROM mikser_journal WHERE operation IN (${placeholders})`,
    ).get(...operations).n
}

function rowToEntry(row) {
    return {
        id:        row.seq,
        operation: row.operation,
        entity:    row.entity  ? JSON.parse(row.entity)  : null,
        context:   row.context ? JSON.parse(row.context) : null,
        options:   row.options ? JSON.parse(row.options) : null,
        output:    row.output  ? JSON.parse(row.output)  : null,
        deps:      row.deps    ? JSON.parse(row.deps)    : null,
    }
}

export async function addEntry({ entity, operation, context, options }) {
    stmtInsert.run({
        operation,
        entity:  entity  != null ? JSON.stringify(entity)  : null,
        context: context != null ? JSON.stringify(context) : null,
        options: options != null ? JSON.stringify(options) : null,
    })
}

export async function addEntries(batch) {
    if (!batch.length) return
    // One transaction for the whole batch — better-sqlite3 wraps a
    // single BEGIN/COMMIT around the loop, saving ~5× on per-row write
    // overhead at large cycle sizes. The wrapper invokes the callback
    // with no args, so we close over `batch` directly.
    db.transaction(() => {
        for (const { entity, operation, context, options } of batch) {
            stmtInsert.run({
                operation,
                entity:  entity  != null ? JSON.stringify(entity)  : null,
                context: context != null ? JSON.stringify(context) : null,
                options: options != null ? JSON.stringify(options) : null,
            })
        }
    })
}

export async function updateEntry({ id, entity, output, deps }) {
    if (entity !== undefined) stmtUpdateEntity.run({ seq: id, entity: JSON.stringify(entity) })
    if (output !== undefined) stmtUpdateOutput.run({ seq: id, output: JSON.stringify(output) })
    if (deps   !== undefined) stmtUpdateDeps.run({ seq: id, deps:   JSON.stringify(deps)   })
}

// Walk the journal yielding entries matching `operations` (or all if
// omitted).
//
// Materializes rows via `.all()` rather than streaming via `.iterate()`.
// better-sqlite3 holds an open cursor across `.iterate()` and forbids
// concurrent writes on the same connection — plugins routinely call
// `updateEntry` inside `for await (const e of useJournal(...))` loops,
// which would deadlock under cursor-based iteration. Materializing
// gives us the same memory shape the prior in-memory journal had (it
// also slice-copied the array at call time), and the snapshot semantic
// stays: rows inserted during the walk are not in the materialized set.
//
// True bounded-memory streaming requires a second connection — a
// reader for the iterator and the main connection for writes. Not done
// here; the materialized-rows shape is fine through 100k scale and
// matches the old behavior exactly. At 1M-corpus scale this is the
// next thing to revisit.
export async function* useJournal(name, operations, signal) {
    if (!db?.isOpen) return

    const stmt = operations?.length ? stmtSelectByOps(operations) : stmtSelectAll
    const args = operations?.length ? operations : []
    const rows = stmt.all(...args)
    if (!rows.length) return

    trackProgress(name, rows.length)

    for (const row of rows) {
        if (signal?.aborted) {
            stopProgress()
            throw new AbortError()
        }
        updateProgress()
        yield rowToEntry(row)
    }
}

// Drain. Called by onFinalized / onCancelled. Idempotent — multiple
// calls leave the table empty either way. The autoincrement counter
// doesn't reset on DELETE; that's fine, seq just keeps climbing across
// cycles and means nothing to consumers (they treat it as opaque).
export function clearJournal() {
    if (db?.isOpen) {
        stmtDelete.run()
    }
}

onLoaded(async () => {
    db = useDatabase()
    if (!db?.isOpen) {
        // database/index.js's onLoaded runs first (it's imported before
        // journal.js in index.js). If we got here without an open handle
        // something upstream silently swallowed an open failure.
        throw new Error('Journal requires the database; none was opened.')
    }

    stmtInsert = db.prepare(`
        INSERT INTO mikser_journal (operation, entity, context, options)
        VALUES (@operation, @entity, @context, @options)
    `)
    stmtUpdateEntity = db.prepare(`UPDATE mikser_journal SET entity = @entity WHERE seq = @seq`)
    stmtUpdateOutput = db.prepare(`UPDATE mikser_journal SET output = @output WHERE seq = @seq`)
    stmtUpdateDeps   = db.prepare(`UPDATE mikser_journal SET deps   = @deps   WHERE seq = @seq`)
    stmtSelectAll    = db.prepare(`SELECT * FROM mikser_journal ORDER BY seq`)
    stmtCount        = db.prepare(`SELECT COUNT(*) AS n FROM mikser_journal`)
    stmtDelete       = db.prepare(`DELETE FROM mikser_journal`)

    // Reset the operation-tuple SELECT cache — prepared statements
    // from a prior cycle's handle are no longer valid if the database
    // was reopened (e.g., test harness reusing the module across runs).
    selectByOpsCache.clear()

    // Leftover-journal bootstrap. Successful runs DELETE FROM
    // mikser_journal at onFinalized; a non-empty table at startup means
    // the previous run was interrupted (crash, kill, OOM, deploy).
    //   - default: discard leftover work, warn loudly so the signal isn't
    //     silent
    //   - --resume: keep the rows; subsequent useJournal walks will see
    //     them and feed the lifecycle, picking up from wherever the
    //     prior run died
    const leftover = stmtCount.get().n
    if (leftover > 0) {
        const logger = useLogger()
        if (runtime.options.resume) {
            logger.info('Resuming from %d journal entries left by a previous run', leftover)
        } else {
            logger.warn(
                'Previous run had %d unfinalized journal entries — discarding (use --resume to keep)',
                leftover,
            )
            stmtDelete.run()
        }
    }
})

onFinalized(async () => {
    clearJournal()
})

onCancelled(async () => {
    clearJournal()
})

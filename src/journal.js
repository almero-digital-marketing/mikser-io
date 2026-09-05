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
import { stopProgress, trackProgress, updateProgress } from './logger/index.js'
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

// Chunk size for paged useJournal walks. Bounds peak journal memory
// at chunk_size × row_size regardless of corpus. 500 × ~7KB ≈ 3.5MB —
// small enough that even 1M corpora stay flat on RSS, large enough
// that the per-chunk SELECT overhead is negligible (one prepared
// statement, .all() into a small array, GC the array between chunks).
const CHUNK_SIZE = 500

// Prepared statements + handle. Set in onLoaded after the database
// substrate opens; persist across cycles (sqlite stays open for the
// lifetime of the process).
let db = null
let stmtInsert = null
let stmtUpdateEntity = null
let stmtUpdateOutput = null
let stmtUpdateDeps = null
let stmtMaxSeq = null
let stmtCount = null
let stmtDelete = null
// Cache prepared chunked-SELECTs by operation-tuple so hot paths don't
// re-prepare. Keyed by the sorted operation list; one statement per
// distinct filter shape we see in a process.
const selectChunkCache = new Map()
let stmtChunkAll = null   // chunked select for the "all operations" case

function stmtChunkByOps(operations) {
    const key = operations.slice().sort().join(',')
    let stmt = selectChunkCache.get(key)
    if (!stmt) {
        const placeholders = operations.map(() => '?').join(',')
        // Paged SELECT: rows AFTER the last seen seq, UP TO the
        // call-time snapshot maxSeq, in the requested operation set,
        // ORDER BY seq for deterministic chunking, LIMIT CHUNK_SIZE.
        stmt = db.prepare(`
            SELECT * FROM mikser_journal
            WHERE seq > ? AND seq <= ?
              AND operation IN (${placeholders})
            ORDER BY seq
            LIMIT ?
        `)
        selectChunkCache.set(key, stmt)
    }
    return stmt
}

function countByOps(operations, maxSeq) {
    const placeholders = operations.map(() => '?').join(',')
    // Cheap query — prepare each time so we don't accumulate statements
    // for ad-hoc operation-tuples we never see again. Counted against
    // the snapshot maxSeq so progress bars match what useJournal will
    // actually yield (rows inserted mid-walk don't bump the bar).
    return db.prepare(
        `SELECT COUNT(*) AS n FROM mikser_journal
         WHERE seq <= ? AND operation IN (${placeholders})`,
    ).get(maxSeq, ...operations).n
}

function countAll(maxSeq) {
    return db.prepare('SELECT COUNT(*) AS n FROM mikser_journal WHERE seq <= ?').get(maxSeq).n
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
// Chunked read: pages CHUNK_SIZE rows at a time, closing the SELECT
// cursor between chunks. better-sqlite3 forbids concurrent queries on
// the same connection; an open `.iterate()` cursor would block the
// UPDATEs the auto-persist path below fires after each yield. Chunked
// .all() over LIMIT/seq cursors avoids the lock — writes happen
// freely in the gap between chunks — while keeping peak journal
// memory bounded at CHUNK_SIZE × row_size (~3.5MB regardless of corpus).
//
// Snapshot semantics: maxSeq is captured at call time and used as the
// upper bound on every chunk. Rows inserted during iteration land
// with seq > maxSeq and are not yielded by this walk. Same contract
// the prior in-memory implementation gave (it slice-copied at call
// time). Plugins that want to react to entries they added themselves
// do it via a fresh useJournal in a later phase.
//
// AUTO-PERSIST: between each yield and the next iteration step, the
// yielded entity is JSON.stringify'd and compared to the row's
// original entity JSON. If they differ, the row is UPDATEd before the
// next yield. This restores the value-by-reference mutation semantic
// the in-memory journal had for free — plugins can mutate the
// yielded entity in-place (entity.meta.foo = bar, _.merge(entity,
// patch), etc.) and the change propagates to subsequent phases'
// useJournal walks AND to catalog onPersist, without an explicit
// updateEntry call.
//
// Cost: one JSON.stringify per yield, plus a write for actually-
// mutated rows. At 14k cold × ~6 journal walks ≈ 4s added cold time.
// Warm cycles are unaffected (handful of yields). The bug class this
// closes (plugin author forgets updateEntry; mutation silently drops;
// downstream phases see stale state) is silent and easy to miss —
// the cold-time cost is the right trade for guaranteed correctness.
//
// Plugins that still want to be explicit can call updateEntry({id,
// entity}) themselves; the write hits the same row, auto-persist sees
// no diff afterwards, no double-write.
export async function* useJournal(name, operations, signal) {
    if (!db?.isOpen) return

    const maxSeq = stmtMaxSeq.get().maxSeq ?? 0
    if (maxSeq === 0) return

    const count = operations?.length
        ? countByOps(operations, maxSeq)
        : countAll(maxSeq)
    if (count === 0) return

    trackProgress(name, count)

    let lastSeq = 0
    while (true) {
        const rows = operations?.length
            ? stmtChunkByOps(operations).all(lastSeq, maxSeq, ...operations, CHUNK_SIZE)
            : stmtChunkAll.all(lastSeq, maxSeq, CHUNK_SIZE)
        if (!rows.length) return

        for (const row of rows) {
            if (signal?.aborted) {
                stopProgress()
                throw new AbortError()
            }
            const entry = rowToEntry(row)
            updateProgress(entry.entity?.id)
            const originalEntity = row.entity   // already a JSON string

            yield entry

            // Yield returned — caller's for-body completed for this
            // iteration. Diff and write back if mutated.
            if (entry.entity != null) {
                const currentEntity = JSON.stringify(entry.entity)
                if (currentEntity !== originalEntity) {
                    stmtUpdateEntity.run({ seq: row.seq, entity: currentEntity })
                }
            }
        }

        lastSeq = rows[rows.length - 1].seq
        if (rows.length < CHUNK_SIZE) return // last chunk
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
    stmtMaxSeq       = db.prepare(`SELECT MAX(seq) AS maxSeq FROM mikser_journal`)
    stmtCount        = db.prepare(`SELECT COUNT(*) AS n FROM mikser_journal`)
    stmtDelete       = db.prepare(`DELETE FROM mikser_journal`)
    stmtChunkAll     = db.prepare(`
        SELECT * FROM mikser_journal
        WHERE seq > ? AND seq <= ?
        ORDER BY seq
        LIMIT ?
    `)

    // Reset the operation-tuple SELECT cache — prepared statements
    // from a prior cycle's handle are no longer valid if the database
    // was reopened (e.g., test harness reusing the module across runs).
    selectChunkCache.clear()

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

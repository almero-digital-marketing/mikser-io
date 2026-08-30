// Which writes belong together, and who asked for them.
//
// The engine deliberately does not care who wrote a file — files are the
// source of truth and a write is a write. That holds right up until something
// wants to UNDO one request without touching everything else that happened
// around it, and then "a write is a write" is exactly the wrong resolution:
// an agent's three edits and a document created through the API in the same
// second are indistinguishable, so removing one removes the other.
//
// A change set is the missing grain. The caller names it, the writes
// accumulate under it, and a consumer can act on exactly those paths.
//
// The engine records the grouping and takes no position on what is done with
// it. Versioning the paths together is one use — mikser-io-git's — but a
// snapshot, an audit trail, a draft-then-publish gate or a filesystem-level
// rollback all want the same fact, and none of them is a commit.
//
// Deliberately NOT a transaction. Nothing is held back, nothing rolls back on
// failure, and a half-finished set is a real set containing what actually
// landed. It is a label on work that already happened, which is what makes it
// safe to add to a write path that must never block on it.
//
// Unclaimed writes stay unclaimed. A consumer is expected to handle them —
// they still happened, and losing them would be worse than not being able to
// attribute them.

import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import runtime from './runtime.js'
import { registerSchema } from './database/index.js'

// The log is DURABLE. It records which writes belonged to which request, and
// nothing can reconstruct that: not the files, which show the result and not
// the grouping, and not a consumer's own history, which may not exist yet or
// at all. Losing it turns every id already handed to an agent into a dangling
// handle.
registerSchema('change_sets', `
    CREATE TABLE IF NOT EXISTS mikser_change_sets (
        id          TEXT PRIMARY KEY,
        summary     TEXT,
        principal   TEXT,
        undo_of     TEXT,
        created_at  INTEGER NOT NULL,
        -- Set when the writer said it was finished. A set that closed is
        -- committable now; one still open is waiting to see whether more
        -- writes join it.
        closed_at   INTEGER,
        -- When the set last grew. A set is one request, and a request is
        -- finished when it stops writing — which is the only signal available,
        -- since a caller grouping several tool calls under one id has not said
        -- which call is the last.
        updated_at  INTEGER,
        -- Set when a consumer has durably recorded the set somewhere of its
        -- own — a commit, a snapshot. Until then the set is real and listable
        -- but there is nothing to revert FROM, which is a different answer
        -- from "no such change set".
        recorded_at INTEGER,
        recorded_as TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mikser_change_sets_created
        ON mikser_change_sets (created_at DESC);

    CREATE TABLE IF NOT EXISTS mikser_change_set_paths (
        change_set TEXT NOT NULL,
        path       TEXT NOT NULL,
        operation  TEXT NOT NULL,
        entity_id  TEXT,
        PRIMARY KEY (change_set, path)
    );
`, { durable: true })

// How many sets to keep. An undo log is only useful while the change is
// recent enough to be worth taking back, and unbounded growth in a durable
// table is a leak nothing cleans up.
const KEEP_SETS = 200

// The change set in effect for the current call.
//
// Threading an id through every write is fine for one API and hopeless across
// a plugin ecosystem: mikser-io-drive writes with fs.writeFile, forms writes
// its own entities, and each new mutating tool would have to remember. An
// ambient context means a caller declares the set ONCE and everything written
// underneath is attributed, including by code that has never heard of change
// sets.
const changeSetContext = new AsyncLocalStorage()

// Run `fn` with a change set in effect. Writes inside it are attributed to
// that set unless they name a different one explicitly.
//
// `closeOnReturn` says this call IS the whole request — which is true whenever
// the id was minted for it rather than supplied by the caller. That is a
// precise signal, not a heuristic: a set nobody else can name cannot grow
// after the call that owns it returns, so it is committable immediately.
//
// A caller-supplied id is the opposite: it exists so several calls can join
// one set, and nothing in this call knows whether another is coming. Those
// close on going quiet instead.
export function withChangeSet(set, fn) {
    if (!set?.changeSet) return fn()
    const context = {
        changeSet: set.changeSet,
        summary: set.summary ?? null,
        principal: set.principal ?? null,
        undoOf: set.undoOf ?? null,
    }
    if (!set.closeOnReturn) return changeSetContext.run(context, fn)
    return changeSetContext.run(context, async () => {
        try {
            return await fn()
        } finally {
            // In `finally`: a request that failed part way still wrote what it
            // wrote, and leaving that set open forever would hold real work
            // out of the log's committable half.
            closeChangeSet(set.changeSet)
        }
    })
}

// Mark a set finished. Idempotent, and silent for an id nothing recorded —
// a request that wrote nothing has no set to close.
export function closeChangeSet(id) {
    if (!id) return
    const at = Date.now()
    const set = memory.get(id)
    if (set) set.closedAt = at
    const handle = db()
    if (!handle) return
    try {
        handle.prepare('UPDATE mikser_change_sets SET closed_at = COALESCE(closed_at, ?) WHERE id = ?').run(at, id)
    } catch { /* memory still holds it */ }
}

export function currentChangeSet() {
    return changeSetContext.getStore() ?? null
}

// The database when there is one, memory when there is not.
//
// A write can happen before the engine opens its database — a plugin acting at
// load time, a unit test — and losing the attribution then would be worse than
// keeping it somewhere weaker. Both back ends answer the same questions, so no
// caller has to know which is in play.
const memory = new Map()

function db() {
    // Read off the runtime rather than calling useDatabase(): this module is
    // reached from utils.js, which loads before the database module can be
    // imported without closing a cycle.
    const handle = runtime.database?.handle
    return handle?.prepare ? handle : null
}

function persist(handle, set, rel, operation, entityId) {
    handle.prepare(`
        INSERT INTO mikser_change_sets (id, summary, principal, undo_of, created_at, updated_at)
        VALUES (@id, @summary, @principal, @undoOf, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
            summary    = COALESCE(mikser_change_sets.summary, excluded.summary),
            principal  = COALESCE(mikser_change_sets.principal, excluded.principal),
            undo_of    = COALESCE(mikser_change_sets.undo_of, excluded.undo_of),
            updated_at = excluded.updated_at
    `).run({
        id: set.id, summary: set.summary, principal: set.principal,
        undoOf: set.undoOf, createdAt: set.startedAt, updatedAt: set.updatedAt,
    })
    handle.prepare(`
        INSERT INTO mikser_change_set_paths (change_set, path, operation, entity_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(change_set, path) DO UPDATE SET operation = excluded.operation
    `).run(set.id, rel, operation, entityId ?? null)
    prune(handle)
}

function prune(handle) {
    handle.prepare(`
        DELETE FROM mikser_change_set_paths WHERE change_set IN (
            SELECT id FROM mikser_change_sets
            ORDER BY created_at DESC LIMIT -1 OFFSET ?
        )
    `).run(KEEP_SETS)
    handle.prepare(`
        DELETE FROM mikser_change_sets WHERE id IN (
            SELECT id FROM mikser_change_sets ORDER BY created_at DESC LIMIT -1 OFFSET ?
        )
    `).run(KEEP_SETS)
}

// Said once per process, not once per write: a broken log is one condition,
// and repeating it per write buries the builds that follow it.
let failureReported = false
function reportChangeSetFailure(err) {
    if (failureReported) return
    failureReported = true
    const message = 'The change-set log could not be written (%s). Writes still land on disk, but they cannot be '
        + 'listed or undone until this is fixed.'
    try {
        runtime.engine?.logger?.error(message, err.message)
    } catch { /* no logger yet — the console is what is left */ }
    if (!runtime.engine?.logger) console.error(message.replace('%s', err.message))
}

function rowsToSets(handle, rows) {
    const stmt = handle.prepare(
        'SELECT path, operation FROM mikser_change_set_paths WHERE change_set = ? ORDER BY path')
    return rows.map(row => {
        const paths = stmt.all(row.id)
        return {
            id: row.id,
            summary: row.summary,
            principal: row.principal,
            undoOf: row.undo_of,
            startedAt: row.created_at,
            updatedAt: row.updated_at ?? row.created_at,
            closed: row.closed_at != null,
            recordedAt: row.recorded_at ?? null,
            recordedAs: row.recorded_as ?? null,
            paths: paths.map(p => p.path),
            deletions: paths.filter(p => p.operation === 'delete').map(p => p.path),
        }
    })
}

function memorySets(filter = () => true) {
    return [...memory.values()].filter(set => set.paths.size).filter(filter).map(set => ({
        id: set.id,
        summary: set.summary,
        principal: set.principal,
        undoOf: set.undoOf,
        startedAt: set.startedAt,
        updatedAt: set.updatedAt ?? set.startedAt,
        closed: Boolean(set.closedAt),
        recordedAt: set.recordedAt ?? null,
        recordedAs: set.recordedAs ?? null,
        paths: [...set.paths.keys()],
        deletions: [...set.paths.entries()].filter(([, op]) => op === 'delete').map(([p]) => p),
    }))
}

// Relative to the working folder, POSIX-separated.
//
// The working folder is the root every consumer already reasons in, and
// forward slashes are the separator entity ids use — so a path here matches
// the vocabulary of the rest of the engine rather than the host's.
function relativeToWorkingFolder(uri) {
    const root = runtime.options?.workingFolder
    if (!root || !uri) return null
    const rel = path.relative(root, uri)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join('/')
}

// Attach one write to a change set.
//
// `summary` is the caller's own description of what it is doing, kept because
// nothing downstream will ever know it as well — a reader choosing what to
// undo needs "changed the hero text on the devices page", not a file count.
// First one wins: later writes in the same set are the same request.
export function recordChangeSetWrite({
    changeSet, summary, principal, uri, operation = 'write', undoOf, entityId,
} = {}) {
    // An explicit id always wins; otherwise take whatever set is in effect.
    // A write with neither stays unclaimed, which is the correct outcome for
    // an API or human write that no request owns.
    const ambient = currentChangeSet()
    changeSet ??= ambient?.changeSet
    summary ??= ambient?.summary
    principal ??= ambient?.principal
    undoOf ??= ambient?.undoOf
    if (!changeSet || !uri) return null
    const rel = relativeToWorkingFolder(uri)
    // Outside the working folder there is nothing a consumer scoped to the
    // project can do with the path, and silently keeping an absolute one would
    // produce a selector that quietly matches nothing.
    if (!rel) return null

    let set = memory.get(changeSet)
    if (!set) {
        set = {
            id: changeSet,
            summary: summary ?? null,
            principal: principal ?? null,
            // Set when this change set exists to take another one back, so an
            // undo is itself an ordinary, undoable change rather than a
            // privileged operation that rewrites the record.
            undoOf: undoOf ?? null,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            paths: new Map(),
        }
        memory.set(changeSet, set)
    }
    if (!set.summary && summary) set.summary = summary
    if (!set.principal && principal) set.principal = principal
    if (!set.undoOf && undoOf) set.undoOf = undoOf
    set.updatedAt = Date.now()
    set.paths.set(rel, operation)

    const handle = db()
    if (handle) {
        try {
            persist(handle, set, rel, operation, entityId)
        } catch (err) {
            // Loud. A swallowed failure here is invisible in exactly the way
            // that matters: the write succeeds, an id comes back, and the log
            // it points at silently never gains a row — which is how a stale
            // column shape turned the whole feature into a no-op that looked
            // like it was working.
            reportChangeSetFailure(err)
        }
    }
    return set.id
}

// Sets a consumer has not yet durably recorded, oldest first — the order the
// work actually happened in, which is the order it should be recorded in.
export function pendingChangeSets() {
    const handle = db()
    if (handle) {
        try {
            const rows = handle.prepare(`
                SELECT * FROM mikser_change_sets WHERE recorded_at IS NULL ORDER BY created_at ASC
            `).all()
            return rowsToSets(handle, rows).filter(set => set.paths.length)
        } catch (err) {
            reportChangeSetFailure(err)
        }
    }
    return memorySets(set => !set.recordedAt).sort((a, b) => a.startedAt - b.startedAt)
}

// The log an agent reads: every set, newest first, whether or not a consumer
// has recorded it anywhere.
export function listChangeSets({ limit = 20 } = {}) {
    const handle = db()
    if (handle) {
        try {
            const rows = handle.prepare(`
                SELECT * FROM mikser_change_sets ORDER BY created_at DESC LIMIT ?
            `).all(Math.max(1, Math.min(limit, 200)))
            return rowsToSets(handle, rows)
        } catch (err) {
            reportChangeSetFailure(err)
        }
    }
    return memorySets().sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
}

export function findChangeSet(id) {
    if (!id) return null
    const handle = db()
    if (handle) {
        try {
            const row = handle.prepare('SELECT * FROM mikser_change_sets WHERE id = ?').get(id)
            return row ? rowsToSets(handle, [row])[0] : null
        } catch { /* fall through to memory */ }
    }
    return memorySets(set => set.id === id)[0] ?? null
}

// Mark sets a consumer has durably recorded, and say what it recorded them AS
// — a commit sha, a snapshot id. That reference is what an undo reverts from,
// and its absence is why "recorded but not yet committed" is a different
// answer from "no such change set".
export function markChangeSetsRecorded(ids = [], recordedAs = null) {
    const at = Date.now()
    for (const id of ids) {
        const set = memory.get(id)
        if (set) { set.recordedAt = at; set.recordedAs = recordedAs }
    }
    const handle = db()
    if (!handle) return
    try {
        const stmt = handle.prepare(
            'UPDATE mikser_change_sets SET recorded_at = ?, recorded_as = ? WHERE id = ?')
        for (const id of ids) stmt.run(at, recordedAs, id)
    } catch { /* memory still holds it */ }
}

// Kept as the name consumers already call. Marking recorded is what "done
// with it" means now — the set stays in the log so it can still be undone.
export function clearChangeSets(ids = [], recordedAs = null) {
    markChangeSetsRecorded(ids, recordedAs)
}

export function forgetAllChangeSets() {
    memory.clear()
    const handle = db()
    if (!handle) return
    try {
        handle.exec('DELETE FROM mikser_change_set_paths; DELETE FROM mikser_change_sets;')
    } catch { /* nothing to clear */ }
}

// Published on the runtime so the write primitives in utils.js can record
// without importing this module. utils.js loads early — before the database
// module can be imported here without closing a cycle — and an import purely
// to reach one function is what would close it.
runtime.recordChangeSetWrite = recordChangeSetWrite

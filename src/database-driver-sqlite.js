// Sqlite database driver using better-sqlite3. The default driver for
// mikser's engine-level database substrate. Phase 1 of the
// engine/database migration — exposes prepare / exec / transaction
// primitives; subsystem migrations land in later phases.
//
// PRAGMA setup at open():
//   - WAL: concurrent reads during writes; checkpoint at commit
//   - synchronous=NORMAL: small durability window, big write throughput
//     win. Acceptable because the catalog is a derived cache; on crash
//     we rebuild from source.
//   - foreign_keys=ON: opt-in to the FK enforcement we'll lean on for
//     the catalog_refs / catalog_entities cascade in Phase 4.
//
// Schema discipline: each subsystem registers an idempotent CREATE
// script via the engine-level `registerSchema(name, sql)` API. The
// driver applies every registered script at open(). `meta.schema_
// version` catches incompatibility — if the recorded version doesn't
// match this engine version, open() throws with a clear "run mikser
// --clear" message.

import path from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'

const DEFAULT_FILENAME = 'mikser.sqlite'

export function createSqliteDriver({
    runtimeFolder, version, logger, config = {}, schemas,
}) {
    // Resolve the on-disk path. Honor an absolute `config.filename`,
    // otherwise resolve relative to the runtime folder. `:memory:`
    // works for tests — better-sqlite3 treats it as ephemeral.
    const dbPath = config.filename === ':memory:'
        ? ':memory:'
        : config.filename
            ? (path.isAbsolute(config.filename)
                ? config.filename
                : path.join(runtimeFolder, config.filename))
            : path.join(runtimeFolder, DEFAULT_FILENAME)

    let db = null

    function open() {
        if (db) return  // idempotent — caller may invoke twice across cycles

        if (dbPath !== ':memory:') {
            mkdirSync(path.dirname(dbPath), { recursive: true })
        }

        db = new Database(dbPath)

        db.exec('PRAGMA journal_mode = WAL')
        db.exec('PRAGMA synchronous = NORMAL')
        db.exec('PRAGMA foreign_keys = ON')

        // meta table always exists — holds the schema_version stamp
        // and any future engine-wide key/value state.
        db.exec(`
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `)

        const recorded = db.prepare('SELECT value FROM meta WHERE key = ?')
            .get('schema_version')?.value
        if (recorded && recorded !== version) {
            db.close()
            db = null
            throw new Error(
                `Database schema is ${recorded}; this mikser-io expects ${version}. ` +
                `Run \`mikser --clear\` to rebuild from sources.`,
            )
        }
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
            .run('schema_version', version)

        // Apply each subsystem's registered schema script. Idempotent
        // CREATE statements mean replay-safe across opens.
        for (const [name, sqlScript] of schemas) {
            try {
                db.exec(sqlScript)
                logger?.debug('Database schema applied: %s', name)
            } catch (err) {
                db.close()
                db = null
                throw new Error(`Schema "${name}" failed to apply: ${err.message}`)
            }
        }
    }

    function close() {
        if (db) {
            db.close()
            db = null
        }
    }

    // Wrap better-sqlite3's transaction primitive. Returns the
    // result of fn(). Sync-only — better-sqlite3 doesn't support
    // async functions inside its transaction wrapper. For async
    // work, callers manage BEGIN / COMMIT / ROLLBACK explicitly via
    // exec().
    function transaction(fn) {
        if (!db) throw new Error('Database not open')
        return db.transaction(fn)()
    }

    return {
        kind: 'sqlite',
        path: dbPath,
        open,
        close,
        get isOpen() { return db !== null },
        // Pass-through primitives for subsystems. They prepare their
        // own statements at the driver's underlying handle.
        prepare(sql) {
            if (!db) throw new Error('Database not open')
            return db.prepare(sql)
        },
        exec(sql) {
            if (!db) throw new Error('Database not open')
            return db.exec(sql)
        },
        transaction,
        // Underlying handle — escape hatch for driver-specific work
        // (PRAGMA tweaks, backup API, etc.). Subsystems should prefer
        // prepare/exec/transaction.
        get handle() { return db },
    }
}

// Engine-level database. One sqlite connection per mikser process,
// shared across subsystems (catalog, refs, manifest) and available to
// plugins via `useDatabase()`. Sqlite via better-sqlite3 — sync API,
// WAL mode, prepared statements. One database, one shape.
//
// (We considered a pluggable driver abstraction with sqlite + postgres
// implementations. Postgres made the worker-side hot path break — pg
// is async, templates are sync, and the only way to bridge them was an
// in-memory sitemap mirror that defeated the whole reason to use
// postgres. Dropped before adding the complexity.)
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
// script via `registerSchema(name, sql)`. The database applies every
// registered script at open(). `meta.schema_version` catches
// incompatibility — if the recorded version doesn't match this engine
// version, open() throws with a clear "run mikser --clear" message.

import path from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import runtime from '../runtime.js'
import { useLogger } from '../engine.js'
import { onLoaded } from '../lifecycle.js'
import packageInfo from '../../package.json' with { type: 'json' }

const DEFAULT_FILENAME = 'mikser.sqlite'

// Schemas registered by subsystems and plugins. Map<name, sqlScript>.
// Idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
// scripts applied at db.open(). Naming convention:
//   - `catalog_*`   — engine-owned (catalog tables)
//   - `manifest_*`  — engine-owned (manifest tables, Phase 5)
//   - `<plugin>_*`  — plugin-owned (e.g. vector_<store>)
const schemas = new Map()

// Active database handle. Set during the first onLoaded; persists across
// cycles (sqlite stays open for the lifetime of the process). Public API
// readers see null only before the first onLoaded fires.
let db = null

// Register an idempotent schema script. Subsystems call this at module-
// import time (top-level side effect) or during onInitialize. The
// database applies all registered scripts at open().
//
// `name` is the schema's identifier — used in debug logs and for
// duplicate detection. Same name twice = the later registration wins
// (with a warning). Convention: `<owner>` matching the table prefix
// (`catalog`, `manifest`, `vector`, etc.).
export function registerSchema(name, sqlScript) {
    if (typeof name !== 'string' || !name.length) {
        throw new Error('registerSchema: name must be a non-empty string')
    }
    if (typeof sqlScript !== 'string' || !sqlScript.length) {
        throw new Error('registerSchema: sqlScript must be a non-empty string')
    }
    if (schemas.has(name)) {
        // Late registration overrides — useful for tests that swap
        // schemas; loud so accidental collisions are visible.
        try {
            useLogger().warn('registerSchema: "%s" already registered, overwriting', name)
        } catch { /* logger may not exist yet at module-import time */ }
    }
    schemas.set(name, sqlScript)
}

// Return the active database handle. Hot-path callers (catalog, refs,
// manifest) should cache the reference once at onLoaded rather than
// calling per-operation.
//
// Returns null before the first onLoaded fires (e.g., during plugin
// onInitialize). Plugins that need persistence should defer their DB
// work until onLoaded.
export function useDatabase() {
    return db
}

// Build a sqlite-backed database handle. Exported so tests can exercise
// the lifecycle and transaction semantics in isolation (without driving
// the full onLoaded chain). The runtime path uses this internally from
// onLoaded below.
export function createSqliteDatabase({
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

    let handle = null

    function open() {
        if (handle) return  // idempotent — caller may invoke twice across cycles

        if (dbPath !== ':memory:') {
            mkdirSync(path.dirname(dbPath), { recursive: true })
        }

        handle = new Database(dbPath)

        handle.exec('PRAGMA journal_mode = WAL')
        handle.exec('PRAGMA synchronous = NORMAL')
        handle.exec('PRAGMA foreign_keys = ON')

        // meta table always exists — holds the schema_version stamp
        // and any future engine-wide key/value state.
        handle.exec(`
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        `)

        const recorded = handle.prepare('SELECT value FROM meta WHERE key = ?')
            .get('schema_version')?.value
        if (recorded && recorded !== version) {
            handle.close()
            handle = null
            throw new Error(
                `Database schema is ${recorded}; this mikser-io expects ${version}. ` +
                `Run \`mikser --clear\` to rebuild from sources.`,
            )
        }
        handle.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
            .run('schema_version', version)

        // Apply each subsystem's registered schema script. Idempotent
        // CREATE statements mean replay-safe across opens.
        for (const [name, sqlScript] of schemas) {
            try {
                handle.exec(sqlScript)
                logger?.debug('Database schema applied: %s', name)
            } catch (err) {
                handle.close()
                handle = null
                throw new Error(`Schema "${name}" failed to apply: ${err.message}`)
            }
        }
    }

    function close() {
        if (handle) {
            handle.close()
            handle = null
        }
    }

    // Wrap better-sqlite3's transaction primitive. Returns the
    // result of fn(). Sync-only — better-sqlite3 doesn't support
    // async functions inside its transaction wrapper. For async
    // work, callers manage BEGIN / COMMIT / ROLLBACK explicitly via
    // exec().
    function transaction(fn) {
        if (!handle) throw new Error('Database not open')
        return handle.transaction(fn)()
    }

    return {
        path: dbPath,
        open,
        close,
        get isOpen() { return handle !== null },
        // Pass-through primitives for subsystems. They prepare their
        // own statements at the underlying better-sqlite3 handle.
        prepare(sql) {
            if (!handle) throw new Error('Database not open')
            return handle.prepare(sql)
        },
        exec(sql) {
            if (!handle) throw new Error('Database not open')
            return handle.exec(sql)
        },
        transaction,
        // Underlying better-sqlite3 handle — escape hatch for
        // PRAGMA tweaks, custom functions, backup API. Subsystems
        // should prefer prepare/exec/transaction.
        get handle() { return handle },
    }
}

onLoaded(async () => {
    if (db?.isOpen) return  // multi-cycle watch mode — keep the open connection

    const logger = useLogger()
    const config = runtime.config?.database ?? {}

    db = createSqliteDatabase({
        runtimeFolder: runtime.options.runtimeFolder,
        version: packageInfo.version,
        logger,
        config,
        schemas,
    })

    db.open()

    // Expose on the runtime singleton so plugins can read it as a
    // property (mirrors runtime.catalog / runtime.refs pattern). Same
    // value as useDatabase() — both kept for ergonomics.
    runtime.database = db

    logger.info(
        'Database ready: %s (schemas: %s)',
        db.path,
        schemas.size ? [...schemas.keys()].join(', ') : 'none',
    )
})

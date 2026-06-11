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
//   - foreign_keys=ON: the mikser_refs → mikser_entities cascade
//     relies on FK enforcement to drop refs when their source entity
//     is deleted.
//
// Schema discipline: each subsystem registers an idempotent CREATE
// script via `registerSchema(name, sql)`. The database applies every
// registered script at open(). `meta.schema_version` catches
// incompatibility — if the recorded version doesn't match this engine
// version, open() throws with a clear "run mikser --clear" message.

import path from 'node:path'
import { mkdirSync, unlinkSync } from 'node:fs'
import Database from 'better-sqlite3'
import runtime from '../runtime.js'
import { onLoaded } from '../lifecycle.js'
import packageInfo from '../../package.json' with { type: 'json' }

// Local logger resolver — same one-liner engine.js exports as
// `useLogger`. Inlined here so database/ doesn't import engine.js
// (which would close a journal → database → engine → journal cycle
// at module-eval time).
function useLogger() {
    return runtime.engine?.logger
}

const DEFAULT_FILENAME = 'mikser.sqlite'

// Schemas registered by subsystems and plugins. Map<name, sqlScript>.
// Idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
// scripts applied at db.open(). Naming convention: `mikser_*` for
// engine-owned tables (mikser_entities, mikser_refs, mikser_snapshots,
// mikser_meta); `<plugin>_*` for plugin-owned tables (e.g.
// vector_documents in mikser-io-vector).
const schemas = new Map()

// Extension loaders registered by plugins. Functions of (handle) that
// load a sqlite runtime extension (e.g. sqlite-vec's vec0 virtual table
// module) into the connection. Called between db creation and schema
// apply on every open — so the schema validator can resolve any
// virtual-table references and so per-cycle prepared statements don't
// fail with "no such module: <ext>" after the first open.
//
// Plugins register these at module-eval time the same way they
// registerSchema. Order doesn't matter as long as the loader runs
// before any prepare against tables that use the extension.
const extensions = []

// Active database handle. Set during the first onLoaded; persists across
// cycles (sqlite stays open for the lifetime of the process). Public API
// readers see null only before the first onLoaded fires.
let db = null

// Register an idempotent schema script. Two timings, same call shape:
//
//  - Early (module-import / onInitialize / onLoad): script lands in the
//    `schemas` Map and is applied when the database opens at engine
//    onLoaded. This is the path catalog / refs / manifest use.
//  - Late (after the database is already open): script is applied
//    immediately on the live handle, AND recorded in the `schemas` Map
//    so the next open replays it idempotently. This is the path plugins
//    use when they need to initialize something on the shared connection
//    first — e.g. mikser-io-vector loads sqlite-vec and then registers
//    its `mikser_vector_*` virtual tables; the vec0 module wouldn't
//    exist if registration happened before the load.
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

    // Lazy-apply: if the database is already open, run the script
    // against the live handle. Idempotent CREATE statements make this
    // safe to re-execute on the next open() too.
    if (db?.isOpen) {
        try {
            db.exec(sqlScript)
            try {
                useLogger()?.debug('Database schema applied (lazy): %s', name)
            } catch { /* logger optional */ }
        } catch (err) {
            throw new Error(`Schema "${name}" failed to apply: ${err.message}`)
        }
    }
}

// Register a sqlite runtime-extension loader. `loader(handle)` runs on
// every open(), between the raw `new Database(dbPath)` and the schema
// apply pass. This is the only safe spot for a plugin to install
// virtual-table modules (sqlite-vec's vec0, sqlite-spellfix, etc.) —
// after this point, schema validation can resolve any references and
// every subsequent prepare against tables that use the extension works.
//
// Plugins register at module-eval time, the same shape registerSchema
// uses. Lazy-applies immediately if the database is already open
// (matches registerSchema's late-registration semantics).
//
// Example (mikser-io-vector):
//   import * as sqliteVec from 'sqlite-vec'
//   import { loadExtension, registerSchema } from 'mikser-io'
//
//   loadExtension(handle => sqliteVec.load(handle))
//   registerSchema('mikser_vector_essays', '... USING vec0(...) ...')
export function loadExtension(loader) {
    if (typeof loader !== 'function') {
        throw new Error('loadExtension: loader must be a function (handle) => void')
    }
    extensions.push(loader)
    if (db?.isOpen) {
        loader(db.handle)
    }
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

        const setupConnection = () => {
            handle.exec('PRAGMA journal_mode = WAL')
            handle.exec('PRAGMA synchronous = NORMAL')
            handle.exec('PRAGMA foreign_keys = ON')
            handle.exec(`
                CREATE TABLE IF NOT EXISTS mikser_meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `)
            // Load registered runtime extensions (sqlite-vec etc.)
            // before anything else touches the schema. Without this,
            // a connection that opens a file containing virtual tables
            // whose backing module isn't loaded fails the schema
            // validator on the first prepare against ANY table —
            // including unrelated ones like mikser_entities.
            for (const loader of extensions) {
                try {
                    loader(handle)
                } catch (err) {
                    throw new Error(`Database extension loader failed: ${err.message}`)
                }
            }
        }

        handle = new Database(dbPath)
        setupConnection()

        const recorded = handle.prepare('SELECT value FROM mikser_meta WHERE key = ?')
            .get('schema_version')?.value
        if (recorded && recorded !== version) {
            // Schema mismatch on upgrade or downgrade. Per ADR-0002 the
            // files on disk are the source of truth and this database
            // is a derived cache, so the right behavior is to wipe the
            // cache and let the next cycle rebuild it from source —
            // not to halt the build with an error.
            //
            // Loud warning so operators can see it happened and know to
            // expect a cold-start rebuild on this run. No data loss
            // beyond the cache itself; everything in mikser.sqlite is
            // recoverable from the working folder.
            logger?.warn(
                'Database schema mismatch: stored=%s, current=%s. Wiping the cache and rebuilding from sources (files are the source of truth — no source data is affected).',
                recorded, version,
            )
            handle.close()
            handle = null

            if (dbPath !== ':memory:') {
                // sqlite WAL leaves -wal and -shm sidecar files. Remove
                // them along with the main file so the next open starts
                // from a guaranteed-clean slate.
                for (const suffix of ['', '-wal', '-shm']) {
                    try { unlinkSync(dbPath + suffix) } catch { /* file may not exist */ }
                }
            }

            handle = new Database(dbPath)
            setupConnection()
        }
        handle.prepare('INSERT OR REPLACE INTO mikser_meta (key, value) VALUES (?, ?)')
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

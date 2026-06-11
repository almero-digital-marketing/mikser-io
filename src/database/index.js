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
import { mkdirSync, unlinkSync, existsSync } from 'node:fs'
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

// Provisioning callbacks registered by plugins. Run on every open(),
// between the raw `new Database(dbPath)` (with PRAGMAs + meta bootstrap)
// and the schema apply pass. Each callback receives a context object:
//
//   {
//     firstRun:        boolean — db file didn't exist before this open
//                                (or :memory:, or was wiped by --clear /
//                                schema mismatch)
//     upgraded:        boolean — stored schema_version differed from
//                                current (db was just wiped + recreated)
//     previousVersion: string | null — the version stamp we found before
//                                       this open, null if firstRun
//     currentVersion:  string — what this mikser binary expects
//     handle:          Database — the raw better-sqlite3 handle, for
//                                 loadExtension / collations / custom
//                                 functions / one-time data seeding
//     logger:          pino|null — for surfacing user-visible setup events
//   }
//
// Use cases:
//   - Load runtime extensions before they're referenced by schemas
//     (sqlite-vec's vec0 module is the canonical example)
//   - Register custom collations, application_id, etc.
//   - First-run data seeding (use `if (ctx.firstRun)` to gate)
//   - Upgrade-time data migrations (gate on `ctx.upgraded` and check
//     `ctx.previousVersion`)
//
// Plugins register at module-eval time, same shape as registerSchema.
// Order doesn't matter unless callbacks depend on each other; if you
// have such a dep, both should be in the same plugin.
const provisioners = []

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

// Register a database-provisioning callback. Fires once per open(),
// AFTER PRAGMAs and the mikser_meta bootstrap (so version detection
// and the schema-mismatch wipe have already happened) and BEFORE
// schema apply (so callbacks can install virtual-table modules,
// register collations, etc. that the schemas about to apply may
// reference).
//
// Callback receives a context object with everything needed to act
// situationally:
//
//   onProvision(({ firstRun, upgraded, previousVersion, currentVersion, handle, logger }) => {
//       // Install runtime extensions on every open:
//       sqliteVec.load(handle)
//
//       // Seed default data on first run only:
//       if (firstRun) {
//           handle.exec("INSERT INTO mikser_meta (key, value) VALUES ('site_id', '...')")
//       }
//
//       // Migrate after a specific upgrade:
//       if (upgraded && previousVersion?.startsWith('8.2')) {
//           handle.exec("UPDATE my_plugin_table SET ...")
//       }
//   })
//
// Plugins register at module-eval time, same shape as registerSchema.
// Lazy-applies on the live handle if the database is already open
// (matches registerSchema's late-registration semantics) — the
// callback fires with firstRun=false, upgraded=false (since the open
// already happened cleanly), and the live handle.
export function onProvision(callback) {
    if (typeof callback !== 'function') {
        throw new Error('onProvision: callback must be a function (ctx) => void')
    }
    provisioners.push(callback)
    if (db?.isOpen) {
        callback({
            firstRun: false,
            upgraded: false,
            previousVersion: db.provisioning?.currentVersion ?? null,
            currentVersion: db.provisioning?.currentVersion ?? null,
            handle: db.handle,
            logger: runtime.engine?.logger ?? null,
        })
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
    runtimeFolder, version, logger, config = {}, schemas, provisioners: provisionersArg,
}) {
    // Tests inject their own provisioners; the runtime path falls
    // through to the module-level `provisioners` array that plugins
    // populate via onProvision() at module-eval.
    const provisionersToRun = provisionersArg ?? provisioners
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
    // Provisioning context exposed on the returned wrapper so any code
    // with a handle (catalog onLoaded, plugin onLoaded, etc.) can ask
    // "was this open a fresh db / a version upgrade / a normal cycle?"
    // without subscribing to onProvision.
    let provisioningCtx = null

    function open() {
        if (handle) return  // idempotent — caller may invoke twice across cycles

        if (dbPath !== ':memory:') {
            mkdirSync(path.dirname(dbPath), { recursive: true })
        }

        // Detect firstRun BEFORE we touch the filesystem. :memory:
        // always counts as firstRun (no persistence across opens).
        const fileExistedBeforeOpen = dbPath !== ':memory:' && existsSync(dbPath)

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
        }

        handle = new Database(dbPath)
        setupConnection()

        const recorded = handle.prepare('SELECT value FROM mikser_meta WHERE key = ?')
            .get('schema_version')?.value
        let upgradedFromVersion = null
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

            upgradedFromVersion = recorded
            handle = new Database(dbPath)
            setupConnection()
        }
        handle.prepare('INSERT OR REPLACE INTO mikser_meta (key, value) VALUES (?, ?)')
            .run('schema_version', version)

        // Build provisioning context. firstRun is true when the file
        // didn't exist before this open OR when the schema mismatch
        // wiped it (and the previous open's stamp is gone) — both shapes
        // present an empty-state database to provisioners.
        provisioningCtx = {
            firstRun: !fileExistedBeforeOpen || upgradedFromVersion !== null,
            upgraded: upgradedFromVersion !== null,
            previousVersion: upgradedFromVersion,
            currentVersion: version,
            handle,
            logger: logger ?? null,
        }

        // Fire provisioning callbacks before schema apply, so they can
        // load runtime extensions (sqlite-vec's vec0, etc.) that the
        // schemas about to apply might reference, register custom
        // collations, or do first-run / upgrade work that needs to
        // happen before the engine tables exist.
        for (const provision of provisionersToRun) {
            try {
                provision(provisioningCtx)
            } catch (err) {
                handle.close()
                handle = null
                provisioningCtx = null
                throw new Error(`onProvision callback failed: ${err.message}`)
            }
        }

        // Apply each subsystem's registered schema script. Idempotent
        // CREATE statements mean replay-safe across opens.
        for (const [name, sqlScript] of schemas) {
            try {
                handle.exec(sqlScript)
                logger?.debug('Database schema applied: %s', name)
            } catch (err) {
                handle.close()
                handle = null
                provisioningCtx = null
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
        // Provisioning context from the most recent open. Plugins'
        // onLoaded handlers can read this without subscribing to
        // onProvision — useful when the work needs the catalog or
        // refs schemas to exist first (which onProvision callbacks
        // can't assume because they fire before schema apply).
        get provisioning() { return provisioningCtx },
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

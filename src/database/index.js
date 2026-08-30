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
//
// THE CACHE, and only the cache. Everything in this file is DERIVED: the
// catalog, the refs graph, the render manifest, the journal. Per ADR-0002 the
// files in the working folder are the source of truth, so this database can be
// deleted at any moment and the cost is a rebuild.
//
// That is what makes the wipe below safe, and it is only true because the data
// that is NOT derived — sign-ins, the change-set log — lives somewhere else
// entirely: see `durable.js`, which is a separate engine behind knex precisely
// because none of this file's constraints apply to it.
//
// They used to share one file, with a `durable: true` flag exempting some
// tables from the wipe. That needed a LIST of which tables were which, and the
// list is where the bugs were: a config that never loaded the owning plugin
// saw no durable tables and unlinked them; `--clear` had to be routed through
// the wipe rather than removing the file; the names had to be parsed back out
// of DDL, which created real columns called `and`, `a` and `which` on a live
// deployment. None of that machinery exists any more. A wipe is `unlink`.

import path from 'node:path'
import { mkdirSync, unlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import runtime from '../runtime.js'
import { isReportOnlyRun } from '../tools.js'
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

// The non-derived half. Named as data rather than as a cache because that is
// the distinction an operator has to be able to make at a glance in a folder
// listing, and it is the one they cannot make today.

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
// A registered schema is either { sql } or, from an external caller of
// createSqliteDatabase, the bare SQL string that shape replaced. Both are
// supported: the argument is public API.
function schemaEntry(value) {
    return typeof value === 'string' ? { sql: value } : value
}

export function registerSchema(name, sqlScript, { durable = false } = {}) {
    // Loud, not ignored. A plugin that still passes this would have its tables
    // created in the cache and deleted by the next wipe, and the first sign of
    // it would be an operator being asked to sign in again after a deploy.
    if (durable) {
        throw new Error(
            `registerSchema("${name}"): the durable flag is gone. Durable tables live in their own database `
            + 'now and are built by registerMigrations(owner, [{ name, up }]) — an idempotent CREATE cannot '
            + 'add a column to a table that already exists, which is the permanent condition of a durable one.')
    }
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
    schemas.set(name, { sql: sqlScript })

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
    // Clear the cache on this open even though nothing changed — what
    // `--clear` asks for. Removes the file; nothing durable is in it.
    forceWipe = false,
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

        const stmtMeta = handle.prepare('SELECT value FROM mikser_meta WHERE key = ?')
        const recorded = stmtMeta.get('schema_version')?.value

        // A config change invalidates the cache for the same reason a version
        // change does: the derived state was computed under different rules.
        //
        // Before this, editing mikser.config.js invalidated nothing — flipping
        // an option that changes every page's destination reported "36
        // unchanged" and left the previous output in place. The config was
        // read; it simply took part in no invalidation, so the only symptom
        // was output that did not match the config and nothing saying so.
        //
        // Treated exactly like a version mismatch rather than something
        // narrower: a config edit can change how sources are PARSED (a mapper
        // transform, documents() options) as well as how they are rendered,
        // so invalidating only the render manifest would still leave stale
        // entities. Per ADR-0002 the files are the source of truth, so
        // rebuilding is always safe — just slower.
        const recordedConfig = stmtMeta.get('config_checksum')?.value
        const currentConfig = runtime.options.configChecksum ?? null
        const configChanged = Boolean(recordedConfig && currentConfig && recordedConfig !== currentConfig)

        // Report-and-exit invocations never rebuild, so wiping for them
        // destroys the very state they were asked to describe — and then they
        // answer from the empty cache as though that were the answer. Measured:
        // one `--tool mikser_query_entities` after a config edit dropped 521
        // entities and replied `total: 0`, which reads as "there are none".
        //
        // The staleness is real and still worth saying out loud; what is wrong
        // is doing something irreversible about it on a read.
        const reportOnly = isReportOnlyRun()

        let upgradedFromVersion = null
        if (reportOnly && !forceWipe && ((recorded && recorded !== version) || configChanged)) {
            logger?.warn(
                'The cache is stale (%s changed since it was written) and this is a read-only run, '
                + 'so it was NOT wiped — the answer below describes the last build, which may not '
                + 'match your sources. Run a build to refresh it.',
                configChanged ? 'config' : 'schema version')
        } else if (configChanged && !(recorded && recorded !== version)) {
            logger?.warn(
                'Config changed since the last run. Wiping the cache and rebuilding from sources ' +
                '(files are the source of truth — no source data is affected). Note this tracks the ' +
                'bytes of %s only: a change in a module it imports is not seen.',
                runtime.options.config,
            )
        }
        if (!reportOnly && (forceWipe || (recorded && recorded !== version) || configChanged)) {
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
            if (recorded && recorded !== version) {
                logger?.warn(
                    'Database schema mismatch: stored=%s, current=%s. Wiping the cache and rebuilding from sources (files are the source of truth — no source data is affected).',
                    recorded, version,
                )
            } else if (forceWipe) {
                logger?.info('Clearing the cache and rebuilding from sources.')
            }
            // Unlink, rather than dropping table by table.
            //
            // The wipe used to have to know which tables to keep, because
            // everything shared one file. It does not any more: what must
            // survive is in a different file that this does not touch. The
            // list that encoded the distinction is gone, and with it every way
            // of getting the list wrong.
            handle.close()
            handle = null

            if (dbPath !== ':memory:') {
                // sqlite WAL leaves -wal and -shm sidecar files. Remove them
                // along with the main file so the next open starts from a
                // guaranteed-clean slate.
                for (const suffix of ['', '-wal', '-shm']) {
                    try { unlinkSync(dbPath + suffix) } catch { /* file may not exist */ }
                }
            }

            // Non-null marks the provisioning context as firstRun/upgraded,
            // which is the right shape for a config change too: what the
            // provisioners see is an empty-state database either way.
            upgradedFromVersion = recorded ?? 'config'
            handle = new Database(dbPath)
            setupConnection()
        }
        const stmtStamp = handle.prepare('INSERT OR REPLACE INTO mikser_meta (key, value) VALUES (?, ?)')
        stmtStamp.run('schema_version', version)
        if (currentConfig) stmtStamp.run('config_checksum', currentConfig)

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

        // Published so plugins can tell an everything-was-evaluated cycle
        // from an incremental one without reaching into the db handle. Read
        // through `isFullCycle()` in utils.js rather than directly.
        runtime.options.firstRun = provisioningCtx.firstRun

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
        for (const [name, value] of schemas) {
            const { sql: sqlScript } = schemaEntry(value)
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
        // `--clear` asks for the cache to go, and the cache is all this is.
        forceWipe: Boolean(runtime.options.clear),
    })

    db.open()

    // Expose on the runtime singleton so plugins can read it as a
    // property (mirrors runtime.catalog / runtime.refs pattern). Same
    // value as useDatabase() — both kept for ergonomics.
    runtime.database = db

    logger.info(
        'Cache ready: %s (schemas: %s)',
        db.path,
        schemas.size ? [...schemas.keys()].join(', ') : 'none',
    )
})

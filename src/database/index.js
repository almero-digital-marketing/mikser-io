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
// TWO FILES, one connection. `runtime/mikser.sqlite` is the derived cache:
// ADR-0002 says the files on disk are the source of truth, so this one can be
// deleted at any moment and costs a rebuild. `mikser.data.sqlite` at the
// working-folder root is everything that is NOT derived — an OAuth client
// registration, a refresh token, the change-set log — which no file can
// reproduce and deleting is data loss.
//
// They were one file, with a `durable: true` flag exempting tables from the
// wipe. That needed a LIST of which tables were which, and the list is where
// the bugs lived: a config that did not load the owning plugin saw no durable
// tables and unlinked them; `--clear` had to be routed through the wipe
// instead of removing the file; the table names had to be parsed back out of
// DDL. Two files delete the list. A wipe is `unlink` again, and the state that
// must survive it is not in the file being unlinked.
//
// The durable file lives OUTSIDE runtime/ on purpose. That folder exists to be
// deleted — it is gitignored and `rm -rf runtime` is a line in real deploy
// scripts — so non-derived state kept inside it was a standing accident.
//
// `registerSchema(name, sql, { durable: true })` is the whole plugin-facing
// change, and the SQL is written exactly as it always was. A durable schema is
// applied on a short-lived connection whose OWN main is the durable file, so
// its unqualified `CREATE TABLE` lands there; the engine's connection then
// ATTACHes that file as `durable` for everything afterwards.
//
// Requiring the plugin to write `durable.` in its DDL was the other option and
// is worse: the decision would then be expressed twice, in the flag and in the
// SQL, and two expressions of one decision can disagree. A plugin that set the
// flag and forgot the prefix would put its data in the file that gets deleted,
// and nothing would say so.
//
// Queries need no qualifier either way. sqlite resolves an unqualified name
// against main first and then each attached database, so every existing
// `SELECT ... FROM mikser_change_sets` keeps working unchanged.

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
const DEFAULT_DURABLE_FILENAME = 'mikser.data.sqlite'

// The sqlite schema name the durable file is attached under. Durable DDL
// qualifies with it; queries do not have to.
const DURABLE = 'durable'

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
// Comments removed, so nothing downstream ever parses prose as DDL.
//
// Done to the WHOLE script before anything splits or counts, because both
// operations are wrong on a comment: a comma inside one ends a clause, and a
// bracket inside one unbalances the walk that finds a table body. Stripping
// per-clause after the split cannot work — by then the damage is done, and the
// fragment after the comma no longer starts with `--` so it never gets
// stripped at all. That produced real columns named `and`, `a` and `which` on
// a live deployment, from the prose of the schema's own comments, while the
// columns that comment described were silently omitted.
function stripSqlComments(sqlScript) {
    return String(sqlScript ?? '')
        // Block comments first: one may span the `--` of a line comment.
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        // To end of line, while the newlines are still there to end at.
        .replace(/--[^\n]*/g, '')
}

// Column names a CREATE TABLE body declares, in order.
//
// Only the leading identifier of each top-level comma-separated clause, and
// only when it is not a table constraint. Good enough for the schemas this
// engine registers, and deliberately not a SQL parser.
function columnsFrom(sqlScript, table) {
    const clean = stripSqlComments(sqlScript)
    // The qualifier is optional because durable schemas write
    // `CREATE TABLE ... durable.mikser_auth_clients` while cache schemas do
    // not, and this has to answer for both.
    const re = new RegExp(
        `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:[\\w$]+\\s*\\.\\s*)?[\`"'\\[]?${table}[\`"'\\]]?\\s*\\(`, 'i')
    const m = re.exec(clean)
    if (!m) return []
    // Walk to the matching close paren so nested types and CHECK(...) do not
    // end the body early.
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    for (; i < clean.length && depth > 0; i++) {
        if (clean[i] === '(') depth++
        else if (clean[i] === ')') depth--
    }
    const body = clean.slice(start, i - 1)

    const clauses = []
    let current = ''
    depth = 0
    for (const ch of body) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
        if (ch === ',' && depth === 0) { clauses.push(current); current = '' } else current += ch
    }
    clauses.push(current)

    const CONSTRAINTS = new Set(['primary', 'unique', 'foreign', 'check', 'constraint'])
    return clauses
        .map(clause => clause.trim())
        .filter(Boolean)
        .map(clause => clause.split(/\s+/)[0].replace(/["\`\[\]]/g, ''))
        .filter(name => name && !CONSTRAINTS.has(name.toLowerCase()))
}

// Add columns a DURABLE table has grown since it was created.
//
// `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
// re-applying a schema never adds a column. For a cache table that is
// invisible: the version bump wipes and recreates it. A durable table is
// exactly the one that is never recreated, so it is the only kind that can go
// stale — and it goes stale silently, with every insert naming the new column
// failing against a table that still has the old shape.
//
// Which tables to check comes from sqlite rather than from parsing the DDL.
// The previous version read table names back out of the schema text, and that
// parser created real columns named `and`, `a` and `which` on a live
// deployment from the prose of a comment. The database can simply be asked
// what is in it.
//
// Runs on the durable connection, where these tables are plain `main` — so no
// qualifier here either.
function migrateDurableColumns(handle, entries, logger) {
    let tables
    try {
        tables = handle
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all().map(row => row.name)
    } catch {
        return
    }

    const durableScripts = entries.map(entry => entry.sql)

    for (const table of tables) {
        // The schema that declares this table is the one whose text contains
        // its CREATE. A table nothing declares belongs to a plugin this config
        // does not load, and is left exactly as it is.
        const declared = durableScripts.map(sql => columnsFrom(sql, table)).find(cols => cols.length)
        if (!declared) continue

        let existing
        try {
            existing = new Set(handle.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name))
        } catch { continue }
        if (!existing.size) continue

        for (const column of declared) {
            if (existing.has(column)) continue
            // Only ever ADD. Dropping or retyping a column here would discard
            // data the second database exists to keep.
            try {
                handle.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}"`)
                logger?.info('Durable table %s gained column %s', table, column)
            } catch (err) {
                logger?.error({ code: 'durable-migration' },
                    'Could not add column %s to %s: %s', column, table, err.message)
            }
        }

        // Verify, rather than assume the loop above was enough.
        //
        // Silence was the dangerous half of the last bug here: the migration
        // logged what it ADDED and never what it failed to find, so a parser
        // that quietly omitted a column produced a clean-looking upgrade and a
        // write that failed days later on a deployment. A declared column
        // still missing after this runs is a fault in the migration itself.
        const after = new Set(handle.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name))
        const missing = declared.filter(column => !after.has(column))
        if (missing.length) {
            logger?.error({ code: 'durable-migration' },
                'Durable table %s is missing declared column(s): %s. Writes naming them will fail — this is a '
                + 'fault in the schema migration, not in the caller.',
                table, missing.join(', '))
        }
    }
}

// A registered schema is either { sql, durable } or, from an external
// caller of createSqliteDatabase, the bare SQL string that shape replaced.
// Both are supported: the argument is public API and a plugin or test
// passing a Map of strings predates the durability flag.
function schemaEntry(value) {
    return typeof value === 'string' ? { sql: value, durable: false } : value
}

// Apply every durable schema to the durable file, reconcile columns, and
// carry across anything a pre-split mikser left in the cache.
//
// On a connection of its own, whose `main` IS that file — which is what lets a
// plugin write `CREATE TABLE IF NOT EXISTS mikser_auth_clients` with no
// qualifier and have it land in the right place. Opened, used and closed here
// so nothing else in the process holds two handles on one file.
//
// Failures are reported rather than thrown. A durable schema that cannot be
// applied is a broken plugin, not a reason the site cannot build — and the
// fault says so where an agent will see it, instead of the tables quietly not
// existing.
function applyDurableSchemas(durablePath, cachePath, schemas, logger) {
    const entries = [...(schemas?.values?.() ?? [])].map(schemaEntry).filter(entry => entry.durable)
    if (!entries.length) return

    let durable = null
    try {
        durable = new Database(durablePath)
        durable.exec('PRAGMA journal_mode = WAL')
        // synchronous=FULL, unlike the cache. The cache trades a small
        // durability window for write throughput because a crash costs a
        // rebuild; here a crash costs a sign-in nobody can reproduce.
        durable.exec('PRAGMA synchronous = FULL')
        durable.exec('PRAGMA foreign_keys = ON')

        for (const { sql } of entries) {
            try {
                durable.exec(sql)
            } catch (err) {
                logger?.error({ code: 'durable-schema' },
                    'A durable schema could not be applied to %s: %s. The tables it declares do not exist, so '
                    + 'whatever owns them cannot store anything.', durablePath, err.message)
            }
        }
        migrateDurableColumns(durable, entries, logger)
        adoptFromCache(durable, cachePath, logger)
    } catch (err) {
        logger?.error({ code: 'durable-schema' },
            'Could not open the durable database at %s: %s. Anything that is not derived from your files — '
            + 'sign-ins, the change-set log — has nowhere to go.', durablePath, err.message)
    } finally {
        try { durable?.close() } catch { /* already closed */ }
    }
}

// Carry a durable table out of a cache file written before the split.
//
// Which tables those are is not guessed. The previous design recorded the
// names in `mikser_meta.durable_tables` — it had to, so that a config which
// never loaded the owning plugin would not unlink them — and that record is
// exactly the upgrade instruction needed here. Matching on names alone would
// be worse than useless: a cache table that happens to share a name with some
// plugin's durable table would be moved and dropped, which is destroying data
// on the strength of a coincidence.
//
// Runs on the DURABLE connection with the cache attached, rather than the
// other way round, so a table the schemas did not create can be rebuilt by
// replaying the CREATE sqlite itself stored — unqualified, landing in durable
// because that is this connection's main. The alternative was rewriting the
// stored DDL to insert a schema prefix, and parsing DDL is what produced
// columns named `and`, `a` and `which` on a live deployment.
//
// The record is cleared once the move succeeds, so this is a one-way door
// that runs once per working folder.
function adoptFromCache(durable, cachePath, logger) {
    if (!cachePath || cachePath === ':memory:' || !existsSync(cachePath)) return

    let recorded = []
    try {
        durable.exec(`ATTACH DATABASE '${cachePath.replace(/'/g, "''")}' AS cache`)
        const row = durable.prepare('SELECT value FROM cache.mikser_meta WHERE key = ?').get('durable_tables')
        const parsed = row?.value ? JSON.parse(row.value) : []
        recorded = Array.isArray(parsed) ? parsed.filter(name => typeof name === 'string') : []
    } catch {
        try { durable.exec('DETACH DATABASE cache') } catch { /* never attached */ }
        return  // no cache, or one that predates the record — nothing to carry
    }

    try {
        const present = new Set(durable.prepare(
            "SELECT name FROM cache.sqlite_master WHERE type='table'").all().map(r => r.name))
        const mine = new Set(durable.prepare(
            "SELECT name FROM main.sqlite_master WHERE type='table'").all().map(r => r.name))

        for (const table of recorded) {
            if (table === 'mikser_meta' || !present.has(table)) continue
            try {
                // A table no loaded plugin declares still has to come across —
                // that is the case the record exists for. Rebuilt from the
                // DDL sqlite kept, so no schema has to be reconstructed.
                if (!mine.has(table)) {
                    const { sql } = durable.prepare(
                        "SELECT sql FROM cache.sqlite_master WHERE type='table' AND name = ?").get(table) ?? {}
                    if (!sql) continue
                    durable.exec(sql)
                }

                const columnsOf = (schema) =>
                    durable.prepare(`PRAGMA ${schema}.table_info("${table}")`).all().map(c => c.name)
                // Intersected rather than trusting `SELECT *`: the shape in
                // the cache is by definition the OLD one, and lining the two
                // up wrong would put values in the wrong columns.
                const source = new Set(columnsOf('cache'))
                const shared = columnsOf('main').filter(c => source.has(c))
                const list = shared.map(c => `"${c}"`).join(', ')

                const moved = durable.transaction(() => {
                    const { n } = durable.prepare(`SELECT COUNT(*) AS n FROM cache."${table}"`).get()
                    if (n && shared.length) {
                        durable.exec(
                            `INSERT OR IGNORE INTO main."${table}" (${list}) SELECT ${list} FROM cache."${table}"`)
                    }
                    durable.exec(`DROP TABLE cache."${table}"`)
                    return n
                })()

                logger?.notice('Moved %s out of the cache and into %s (%d row%s)',
                    table, DEFAULT_DURABLE_FILENAME, moved, moved === 1 ? '' : 's')
            } catch (err) {
                // Loud, and specifically not fatal: the rows are still in the
                // cache, which means the next wipe takes them. That is a
                // warning an operator can act on; silence is not.
                logger?.error({ code: 'durable-adopt' },
                    'Could not move %s into the durable database: %s. Its rows are still in the cache, so the '
                    + 'next wipe will delete them.', table, err.message)
            }
        }

        // Cleared last, and only here. While it is present this runs again,
        // which is what makes a partial move recoverable on the next start.
        durable.prepare('DELETE FROM cache.mikser_meta WHERE key = ?').run('durable_tables')
    } catch (err) {
        logger?.error({ code: 'durable-adopt' },
            'Could not read the durable-table record out of the cache: %s', err.message)
    } finally {
        try { durable.exec('DETACH DATABASE cache') } catch { /* already detached */ }
    }
}

// Keep the durable database out of the repository.
//
// It sits at the working-folder root — deliberately outside runtime/, which
// exists to be deleted — and a working folder is very often a git repo that
// something runs `git add -A` over. mikser-io-git does exactly that, by
// design, "relying on .gitignore". A refresh token pushed to a remote is not
// a mistake an operator can take back, so the ignore line is written here
// rather than left to a README.
//
// Appends one line, only when nothing already covers the name, and only where
// there is a repository for it to matter to.
function ensureIgnored(folder, filename, logger) {
    const ignorePath = path.join(folder, '.gitignore')
    const hasIgnoreFile = existsSync(ignorePath)
    if (!hasIgnoreFile && !existsSync(path.join(folder, '.git'))) return

    const line = `${filename}*`
    try {
        const current = hasIgnoreFile ? readFileSync(ignorePath, 'utf8') : ''
        const covered = current.split(/\r?\n/)
            .map(l => l.trim())
            .some(l => l && !l.startsWith('#') && (l === filename || l === line))
        if (covered) return

        const prefix = current.length && !current.endsWith('\n') ? '\n' : ''
        writeFileSync(ignorePath, `${current}${prefix}${line}\n`)
        logger?.notice('Added %s to .gitignore — it holds credentials and must not be committed', line)
    } catch (err) {
        logger?.error({ code: 'durable-gitignore' },
            'Could not add %s to .gitignore (%s). Add it by hand: this file holds OAuth clients and refresh '
            + 'tokens, and a `git add -A` over the working folder would commit them.', line, err.message)
    }
}

export function registerSchema(name, sqlScript, { durable = false } = {}) {
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
    schemas.set(name, { sql: sqlScript, durable })

    // Lazy-apply: if the database is already open, run the script
    // against the live handle. Idempotent CREATE statements make this
    // safe to re-execute on the next open() too.
    if (db?.isOpen) {
        try {
            // Same routing as the open-time pass: a durable script goes to the
            // durable file, on its own connection, so its unqualified CREATE
            // lands there rather than in the cache.
            if (durable && db.durablePath && db.durablePath !== ':memory:') {
                applyDurableSchemas(db.durablePath, db.path, new Map([[name, { sql: sqlScript, durable }]]), useLogger())
            } else {
                db.exec(sqlScript)
            }
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
    // Where the durable database goes. Separate from runtimeFolder on
    // purpose — see the note at the top of this file.
    workingFolder = runtime.options?.workingFolder,
    // Clear the cache on this open even though nothing changed — what
    // `--clear` asks for. Removes the cache file; the durable database is a
    // different file and is not part of what `--clear` means.
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

    // The durable file follows the main one into memory for tests, and
    // otherwise sits at the working-folder root. `config.database.durable`
    // overrides it, absolute or relative to the working folder.
    const durablePath = dbPath === ':memory:'
        ? ':memory:'
        : config.durable
            ? (path.isAbsolute(config.durable)
                ? config.durable
                : path.join(workingFolder ?? runtimeFolder, config.durable))
            : path.join(workingFolder ?? runtimeFolder, DEFAULT_DURABLE_FILENAME)

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
            mkdirSync(path.dirname(durablePath), { recursive: true })
            // Before the file is created, so the ignore line is in place the
            // first time anything could stage it.
            ensureIgnored(path.dirname(durablePath), path.basename(durablePath), logger)
        }

        // Detect firstRun BEFORE we touch the filesystem. :memory:
        // always counts as firstRun (no persistence across opens).
        const fileExistedBeforeOpen = dbPath !== ':memory:' && existsSync(dbPath)

        const setupConnection = () => {
            handle.exec('PRAGMA journal_mode = WAL')
            handle.exec('PRAGMA synchronous = NORMAL')
            handle.exec('PRAGMA foreign_keys = ON')
            // Attached rather than left to a second connection, so queries,
            // transactions and joins reach both files through one handle and
            // no caller has to know which file its table is in.
            //
            // Part of setupConnection because the wipe reopens the handle, and
            // a reopen that lost the attachment would leave every durable
            // table unreachable for the rest of the process.
            //
            // Skipped in memory: two `:memory:` connections are two unrelated
            // databases, so there is nothing to share. Durable schemas are
            // applied to main there instead, which is the only shape that can
            // work and costs nothing — nothing survives the process anyway.
            if (durablePath !== ':memory:') {
                handle.exec(`ATTACH DATABASE '${durablePath.replace(/'/g, "''")}' AS ${DURABLE}`)
                handle.exec(`PRAGMA ${DURABLE}.synchronous = FULL`)
            }
            handle.exec(`
                CREATE TABLE IF NOT EXISTS mikser_meta (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            `)
        }

        // Durable schemas go to the durable file, on a connection whose own
        // `main` is that file — see the note at the top. Before the engine's
        // connection opens, so the tables exist by the time it attaches.
        if (durablePath !== ':memory:') applyDurableSchemas(durablePath, dbPath, schemas, logger)

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
                logger?.info('Clearing the cache and rebuilding from sources (%s is a separate file and is kept).',
                    DEFAULT_DURABLE_FILENAME)
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
            const { sql: sqlScript, durable } = schemaEntry(value)
            // Durable ones were applied to the durable file above. Running
            // them here would recreate the same tables in the cache, where
            // they would shadow the real ones until the next wipe.
            //
            // In memory there is no second file to apply them to, and nothing
            // survives the process anyway, so they belong here.
            if (durable && durablePath !== ':memory:') continue
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
        // Where the non-derived state is. Named on the wrapper so an operator
        // asking "what do I lose if I delete this" has somewhere to read the
        // answer, which is the question the single-file layout could not
        // answer at all.
        durablePath,
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
        workingFolder: runtime.options.workingFolder,
        version: packageInfo.version,
        logger,
        config,
        schemas,
        // `--clear` asks for the CACHE to go. The durable database is a
        // different file and is not part of what that means.
        forceWipe: Boolean(runtime.options.clear),
    })

    db.open()

    // Expose on the runtime singleton so plugins can read it as a
    // property (mirrors runtime.catalog / runtime.refs pattern). Same
    // value as useDatabase() — both kept for ergonomics.
    runtime.database = db

    // Both files named, because which one is which is the whole point and an
    // operator should not have to read source to find out what is safe to
    // delete.
    logger.info(
        'Database ready: %s (cache) + %s (durable) (schemas: %s)',
        db.path,
        db.durablePath,
        schemas.size ? [...schemas.keys()].join(', ') : 'none',
    )
})

// The durable store: everything that is NOT derived from your files.
//
// Auth grants, the change-set log, form submissions — data no file can
// reproduce, which is the whole distinction. The cache next door holds the
// catalog, the refs graph and the render manifest, all of it rebuildable from
// the working folder at the cost of a rebuild (ADR-0002).
//
// A DIFFERENT ENGINE from the cache, deliberately, and this is the reason the
// two are separate modules rather than two files behind one API:
//
//   The cache is locked to sqlite and to a SYNCHRONOUS driver. Render workers
//   open their own read-only handle so template helpers like `lookupHref` can
//   resolve a reference inline, and a promise cannot be awaited inside a
//   Handlebars helper. That constraint killed an earlier attempt at a
//   pluggable driver — see the note in ADR-0009.
//
//   None of it applies here. The durable store is read and written on the
//   main thread only, by HTTP handlers and lifecycle hooks that are already
//   async. So it can sit behind knex, and knex can point at Postgres instead
//   of a local file — which is what several mikser processes sharing one
//   sign-in and one change-set log would need.
//
// MIGRATIONS, not idempotent CREATEs. `CREATE TABLE IF NOT EXISTS` does
// nothing to a table that already exists, so a schema replayed at every boot
// can never add a column, rename one, or backfill a value. That is invisible
// for a cache table — the next version bump recreates it — and it is the
// permanent condition of a durable one. Every table here is built by an
// ordered list of migrations instead, applied once and recorded.

import path from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import knexFactory from 'knex'

import runtime from '../runtime.js'
import { onLoaded } from '../lifecycle.js'

function useLogger() {
    return runtime.engine?.logger
}

export const DEFAULT_DURABLE_FILENAME = 'mikser.data.sqlite'

// Where migrations are recorded. Engine-owned, and identical on every backend.
const LEDGER = 'mikser_migrations'

// Migrations by owner. `Map<owner, [{ name, up }]>`.
//
// PER OWNER, which is the whole reason this is not knex's own directory-based
// migrator. Every off-the-shelf runner assumes one application with one linear
// history; here the tables belong to independently versioned npm packages, and
// installing a plugin next month must not reorder or invalidate migrations
// that ran last year. Each owner gets its own sequence, and the ledger's
// primary key is (owner, name).
const registry = new Map()

let db = null

// Declare the ordered migrations for one owner.
//
//   registerMigrations('auth', [
//       { name: '001-grants', up: async (knex) => {
//           await knex.schema.createTable('mikser_auth_clients', (t) => { ... })
//       } },
//       { name: '002-last-used', up: async (knex) => {
//           await knex.schema.alterTable('mikser_auth_clients', (t) => {
//               t.bigInteger('last_used_at')
//           })
//       } },
//   ])
//
// Names are recorded, so they are permanent: renaming one makes it run again
// against a database that already has its effect. Append, never edit.
//
// `up` receives a knex transaction. There is no `down`. A durable store's
// rollback is a restore from backup — an automated one would be a second way
// to lose data no file can reproduce, offered at exactly the moment someone
// is panicking.
export function registerMigrations(owner, migrations) {
    if (typeof owner !== 'string' || !owner.length) {
        throw new Error('registerMigrations: owner must be a non-empty string')
    }
    if (!Array.isArray(migrations) || !migrations.length) {
        throw new Error(`registerMigrations("${owner}"): migrations must be a non-empty array`)
    }
    for (const migration of migrations) {
        if (typeof migration?.name !== 'string' || !migration.name.length) {
            throw new Error(`registerMigrations("${owner}"): every migration needs a name`)
        }
        if (typeof migration?.up !== 'function') {
            throw new Error(`registerMigrations("${owner}"): migration "${migration.name}" needs an up(knex)`)
        }
    }
    const seen = new Set()
    for (const { name } of migrations) {
        if (seen.has(name)) throw new Error(`registerMigrations("${owner}"): duplicate migration name "${name}"`)
        seen.add(name)
    }
    registry.set(owner, migrations)
}

// The knex instance for the durable store, or null before onLoaded has run.
//
// Plugins query through this. It is knex rather than a repository or an entity
// mapper on purpose: the store holds a handful of flat tables that are read by
// primary key, and an object layer over that would be indirection with nothing
// on the other side of it.
export function useDurableDatabase() {
    // Read through the runtime, matching runtime.database. That is what makes
    // it injectable — a test, or an embedder, can supply its own knex without
    // driving the whole onLoaded chain.
    return runtime.durable ?? db
}

// Which backend is in play. `sqlite` or whatever knex client was configured —
// read by the one piece of code that is allowed to care, the upgrade path
// below, which uses sqlite's ATTACH and cannot run against anything else.
export function durableClient() {
    return db?.client?.config?.client ?? null
}

// Resolve the configured target into a knex config.
//
// A string that looks like a URL is a connection string for whatever engine it
// names; anything else is a path to a sqlite file, absolute or relative to the
// working folder. An object is passed through, for the cases neither covers.
export function durableConfig({ target, workingFolder } = {}) {
    if (target && typeof target === 'object') return target
    if (typeof target === 'string' && /^[a-z][\w+.-]*:\/\//i.test(target)) {
        const client = target.startsWith('postgres') || target.startsWith('pg') ? 'pg' : target.split(':')[0]
        return { client, connection: target, pool: { min: 0, max: 4 } }
    }
    const filename = typeof target === 'string' && target.length ? target : DEFAULT_DURABLE_FILENAME
    return {
        client: 'better-sqlite3',
        connection: {
            filename: path.isAbsolute(filename) ? filename : path.join(workingFolder ?? '.', filename),
        },
        // sqlite has no native boolean and knex refuses to guess about
        // defaults without it.
        useNullAsDefault: true,
    }
}

// Apply every registered migration that has not run yet.
//
// Sequential within an owner because a migration may depend on the one before
// it, and sequential ACROSS owners only because the ledger is one table —
// there is no ordering relationship between two plugins' migrations and none
// is implied.
//
// Each runs inside a transaction with its own ledger row, so a migration that
// throws leaves neither its effect nor its record behind, and the next start
// tries it again rather than skipping it as done.
export async function runMigrations(knex, logger = useLogger()) {
    if (!(await knex.schema.hasTable(LEDGER))) {
        await knex.schema.createTable(LEDGER, (table) => {
            table.string('owner').notNullable()
            table.string('name').notNullable()
            table.bigInteger('applied_at').notNullable()
            table.primary(['owner', 'name'])
        })
    }

    let applied = 0
    for (const [owner, migrations] of registry) {
        const done = new Set(
            (await knex(LEDGER).where({ owner }).select('name')).map(row => row.name))

        for (const { name, up } of migrations) {
            if (done.has(name)) continue
            try {
                await knex.transaction(async (trx) => {
                    await up(trx)
                    await trx(LEDGER).insert({ owner, name, applied_at: Date.now() })
                })
                logger?.notice('Durable migration applied: %s/%s', owner, name)
                applied++
            } catch (err) {
                // A fault, not a throw. The site can still build and serve;
                // what is broken is one plugin's storage, and saying so where
                // an agent reads it beats halting a deploy over it.
                logger?.error({ code: 'durable-migration' },
                    'Durable migration %s/%s failed: %s. Whatever it was going to create does not exist, so the '
                    + 'plugin that owns it cannot store anything.', owner, name, err.message)
                break  // later migrations in this owner assume this one ran
            }
        }
    }
    return applied
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
export function ensureIgnored(folder, filename, logger) {
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

onLoaded(async () => {
    if (db) return  // watch mode keeps the connection across cycles
    if (!registry.size) return  // nothing durable is registered; open nothing

    const logger = useLogger()
    const config = durableConfig({
        target: runtime.config?.database?.durable,
        workingFolder: runtime.options.workingFolder,
    })
    const filename = config.connection?.filename ?? null

    // Before the file is created, so the ignore line is in place the first
    // time anything could stage it.
    if (filename) ensureIgnored(path.dirname(filename), path.basename(filename), logger)

    try {
        db = knexFactory(config)
        await runMigrations(db, logger)
    } catch (err) {
        logger?.error({ code: 'durable-open' },
            'The durable database could not be opened (%s). Anything that is not derived from your files — '
            + 'sign-ins, the change-set log — has nowhere to go.', err.message)
        db = null
        return
    }

    runtime.durable = db
    logger?.info('Durable store ready: %s (%s)', filename ?? 'remote', config.client)
})

// Let a one-shot run end.
//
// knex keeps a pool reaper timer alive, so `mikser` would build the site and
// then hang forever with nothing left to do. better-sqlite3 never had this
// problem, which is why nothing closed the cache either — and why the engine
// had no shutdown step to hang this on.
//
// beforeExit was the obvious hook and does not work: it fires only when the
// loop is EMPTY, and the reaper timer is exactly what stops it being empty.
//
// Published on the runtime rather than imported by it, for the same reason
// recordChangeSetWrite is: runtime.js loads before this module can be imported
// without closing a cycle. runtime.start() calls it once every hook from every
// plugin has run, which is the only point at which nothing can still need the
// connection.
export async function closeDurableDatabase() {
    const open = db
    if (!open) return
    db = null
    runtime.durable = null
    try { await open.destroy() } catch { /* the process is ending either way */ }
}

runtime.closeDurable = closeDurableDatabase

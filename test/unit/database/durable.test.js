// The durable store: migrations, and what a cache wipe cannot reach.
//
// The old shape was `registerSchema(sql, { durable: true })` — an idempotent
// CREATE replayed at every boot, exempted from the wipe by a list. It could
// never add a column to a table that already existed, which is the permanent
// condition of a durable table, and the list is what a config that never
// loaded the owning plugin got wrong.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import knexFactory from 'knex'

import {
    registerMigrations, runMigrations, durableConfig, adoptFromCache, ensureIgnored,
} from '../../../src/database/durable.js'
import { registerSchema, createSqliteDatabase } from '../../../src/database/index.js'

let dir, db
const quiet = { notice: () => {}, info: () => {}, error: () => {} }
const loud = () => { const seen = []; return { notice: () => {}, info: () => {}, error: (o, ...a) => seen.push({ ...o, a }), seen } }

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-durable-'))
    db = knexFactory(durableConfig({ target: path.join(dir, 'mikser.data.sqlite') }))
})
afterEach(async () => {
    await db.destroy()
    await rm(dir, { recursive: true, force: true })
})

describe('migrations', () => {
    it('applies once and records what it applied', async () => {
        registerMigrations('t-once', [
            { name: '001', up: (k) => k.schema.createTable('t_once', (t) => t.string('id').primary()) },
        ])
        assert.ok(await runMigrations(db, quiet) >= 1)
        assert.ok(await db.schema.hasTable('t_once'))

        const ledger = await db('mikser_migrations').where({ owner: 't-once' }).select('name')
        assert.deepEqual(ledger.map(r => r.name), ['001'])

        // The second run must be a no-op — a re-applied CREATE would throw.
        const applied = await runMigrations(db, quiet)
        assert.equal(applied, 0)
    })

    it('adds a column an existing table has grown — the thing a CREATE cannot do', async () => {
        registerMigrations('t-grow', [
            { name: '001', up: (k) => k.schema.createTable('t_grow', (t) => t.string('id').primary()) },
        ])
        await runMigrations(db, quiet)
        await db('t_grow').insert({ id: 'a' })

        registerMigrations('t-grow', [
            { name: '001', up: (k) => k.schema.createTable('t_grow', (t) => t.string('id').primary()) },
            { name: '002', up: (k) => k.schema.alterTable('t_grow', (t) => t.text('outcome')) },
        ])
        await runMigrations(db, quiet)

        // The write that used to fail against a stale shape.
        await db('t_grow').where({ id: 'a' }).update({ outcome: 'empty' })
        assert.equal((await db('t_grow').first()).outcome, 'empty')
    })

    it('keeps each owner on its own history', async () => {
        // Two independently versioned packages. Installing one later must not
        // reorder or invalidate the other's migrations.
        registerMigrations('t-a', [{ name: '001', up: (k) => k.schema.createTable('t_a', (t) => t.string('id')) }])
        await runMigrations(db, quiet)
        registerMigrations('t-b', [{ name: '001', up: (k) => k.schema.createTable('t_b', (t) => t.string('id')) }])
        await runMigrations(db, quiet)

        assert.ok(await db.schema.hasTable('t_a'))
        assert.ok(await db.schema.hasTable('t_b'))
        const owners = (await db('mikser_migrations').distinct('owner')).map(r => r.owner)
        assert.ok(owners.includes('t-a') && owners.includes('t-b'))
    })

    it('does not record a migration that threw, and says so', async () => {
        // Recording it would skip it forever, leaving the table missing and
        // every write to it failing against a database that claims to be up
        // to date.
        const logger = loud()
        registerMigrations('t-broken', [
            { name: '001', up: async () => { throw new Error('nope') } },
        ])
        await runMigrations(db, logger)

        assert.equal((await db('mikser_migrations').where({ owner: 't-broken' })).length, 0)
        assert.ok(logger.seen.some(e => e.code === 'durable-migration'),
            'a failed migration must be a fault, not a silent skip')
    })

    it('stops an owner at its first failure', async () => {
        // 002 may depend on 001. Running it anyway would fail confusingly, or
        // worse, succeed against the wrong shape.
        registerMigrations('t-halt', [
            { name: '001', up: async () => { throw new Error('nope') } },
            { name: '002', up: (k) => k.schema.createTable('t_halt', (t) => t.string('id')) },
        ])
        await runMigrations(db, quiet)
        assert.equal(await db.schema.hasTable('t_halt'), false)
    })
})

describe('the durable flag is gone', () => {
    it('refuses registerSchema({ durable: true }) instead of quietly caching it', async () => {
        // Accepting it would put the table in the file that gets deleted, and
        // the first sign would be an operator asked to sign in again.
        assert.throws(
            () => registerSchema('legacy', 'CREATE TABLE IF NOT EXISTS x (id TEXT)', { durable: true }),
            /registerMigrations/)
    })
})

describe('a cache wipe cannot reach the durable store', () => {
    it('unlinks the cache on a version change and leaves the other file alone', async () => {
        registerMigrations('t-keep', [
            { name: '001', up: (k) => k.schema.createTable('t_keep', (t) => t.string('id').primary()) },
        ])
        await runMigrations(db, quiet)
        await db('t_keep').insert({ id: 'client-42' })

        const open = (version) => {
            const cache = createSqliteDatabase({
                runtimeFolder: dir, version, config: { filename: 'cache.sqlite' },
                schemas: new Map([['c', 'CREATE TABLE IF NOT EXISTS cache_rows (id TEXT PRIMARY KEY)']]),
            })
            cache.open()
            return cache
        }
        let cache = open('1.0.0')
        cache.handle.exec("INSERT INTO cache_rows (id) VALUES ('derived')")
        cache.close()

        cache = open('2.0.0')   // schema mismatch → wipe
        assert.equal(cache.handle.prepare('SELECT count(*) c FROM cache_rows').get().c, 0,
            'the derived cache must still be cleared')
        cache.close()

        assert.equal((await db('t_keep').first()).id, 'client-42',
            'the registration is in a different file and the wipe never touched it')
    })
})

describe('carrying a pre-split database across', () => {
    it('moves the tables the old design recorded, and clears the record', async () => {
        const cachePath = path.join(dir, 'old-cache.sqlite')
        const cache = new Database(cachePath)
        cache.exec(`
            CREATE TABLE mikser_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE mikser_auth_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE cache_rows (id TEXT PRIMARY KEY);`)
        cache.prepare('INSERT INTO mikser_auth_clients VALUES (?,?)').run('client-42', 'Claude')
        cache.prepare('INSERT INTO cache_rows VALUES (?)').run('derived')
        cache.prepare('INSERT INTO mikser_meta (key,value) VALUES (?,?)')
            .run('durable_tables', JSON.stringify(['mikser_auth_clients']))
        cache.close()

        // No migration declares mikser_auth_clients here — the case of a
        // config that does not load the owning plugin. It still has to come
        // across, rebuilt from the DDL sqlite itself kept.
        const handle = new Database(path.join(dir, 'mikser.data.sqlite'))
        adoptFromCache(handle, cachePath, quiet)
        assert.equal(handle.prepare('SELECT name FROM mikser_auth_clients').get()?.name, 'Claude')
        handle.close()

        const after = new Database(cachePath, { readonly: true })
        assert.equal(after.prepare(
            "SELECT count(*) c FROM sqlite_master WHERE name='mikser_auth_clients'").get().c, 0,
            'the shadow copy must be dropped, or an unqualified query keeps finding the stale one')
        assert.equal(after.prepare("SELECT count(*) c FROM cache_rows").get().c, 1,
            'a table the record does not name is not touched')
        assert.ok(!after.prepare('SELECT value FROM mikser_meta WHERE key=?').get('durable_tables'),
            'the record is cleared, so this never runs twice')
        after.close()
    })

    it('does nothing to a database that was never pre-split', async () => {
        const cachePath = path.join(dir, 'fresh.sqlite')
        const cache = new Database(cachePath)
        cache.exec('CREATE TABLE mikser_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);'
            + 'CREATE TABLE cache_rows (id TEXT PRIMARY KEY);')
        cache.prepare('INSERT INTO cache_rows VALUES (?)').run('derived')
        cache.close()

        const handle = new Database(path.join(dir, 'mikser.data.sqlite'))
        adoptFromCache(handle, cachePath, quiet)
        handle.close()

        const after = new Database(cachePath, { readonly: true })
        assert.equal(after.prepare('SELECT count(*) c FROM cache_rows').get().c, 1)
        after.close()
        assert.ok(existsSync(cachePath))
    })
})

describe('keeping credentials out of the repository', () => {
    // The durable file sits at the working-folder root, which is usually a git
    // repo that mikser-io-git runs `git add -A` over. A refresh token pushed
    // to a remote is not a mistake anyone can take back.
    const ignore = () => path.join(dir, '.gitignore')

    it('adds the file to .gitignore in a repo that has none', async () => {
        mkdirSync(path.join(dir, '.git'), { recursive: true })
        ensureIgnored(dir, 'mikser.data.sqlite', quiet)
        // The glob, so the -wal and -shm sidecars are covered too.
        assert.equal(readFileSync(ignore(), 'utf8').trim(), 'mikser.data.sqlite*')
    })

    it('appends without disturbing what is already there', async () => {
        mkdirSync(path.join(dir, '.git'), { recursive: true })
        writeFileSync(ignore(), 'runtime/\nout/')   // no trailing newline
        ensureIgnored(dir, 'mikser.data.sqlite', quiet)
        assert.deepEqual(readFileSync(ignore(), 'utf8').trim().split('\n'),
            ['runtime/', 'out/', 'mikser.data.sqlite*'])
    })

    it('does not add a second line on the next start', async () => {
        mkdirSync(path.join(dir, '.git'), { recursive: true })
        ensureIgnored(dir, 'mikser.data.sqlite', quiet)
        ensureIgnored(dir, 'mikser.data.sqlite', quiet)
        assert.equal(readFileSync(ignore(), 'utf8').trim().split('\n').length, 1)
    })

    it('writes nothing where there is no repository to leak to', async () => {
        ensureIgnored(dir, 'mikser.data.sqlite', quiet)
        assert.equal(existsSync(ignore()), false)
    })
})

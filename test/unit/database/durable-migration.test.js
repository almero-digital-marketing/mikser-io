// A durable table cannot be migrated by re-applying its CREATE.
//
// `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists.
// For a cache table that is invisible — the version bump wipes and recreates
// it — so only a DURABLE table can go stale, and it goes stale silently: every
// insert naming a column added since fails against a table still holding the
// old shape, while reads succeed and return nothing.
//
// That is what turned the change-set log into a no-op that looked healthy.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSqliteDatabase } from '../../../src/database/index.js'

let dir
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mikser-migrate-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

const V1 = `CREATE TABLE IF NOT EXISTS grant_rows (
    id TEXT PRIMARY KEY, subject TEXT, created_at INTEGER NOT NULL);`
const V2 = `CREATE TABLE IF NOT EXISTS grant_rows (
    id TEXT PRIMARY KEY, subject TEXT, created_at INTEGER NOT NULL,
    -- added after the table already existed
    closed_at INTEGER, updated_at INTEGER);`

const open = (version, sql, { durable = true, filename = 'm.sqlite' } = {}) => {
    const db = createSqliteDatabase({
        runtimeFolder: dir, version, config: { filename },
        schemas: new Map([['grants', { sql, durable }]]),
    })
    db.open()
    return db
}
const columns = (db) =>
    db.handle.prepare('PRAGMA table_info(grant_rows)').all().map(c => c.name)

describe('durable tables gain columns the schema has grown', () => {
    it('adds the missing columns on the next open', () => {
        let db = open('1.0.0', V1)
        db.handle.prepare('INSERT INTO grant_rows (id, subject, created_at) VALUES (?,?,?)').run('a', 'dick', 1)
        assert.ok(!columns(db).includes('updated_at'))
        db.close()

        db = open('2.0.0', V2)
        assert.ok(columns(db).includes('updated_at'), 'the column the schema grew must exist')
        assert.ok(columns(db).includes('closed_at'))
        db.close()
    })

    it('lets a write naming the new column succeed', () => {
        // The actual symptom: the insert failed, the read succeeded against an
        // empty table, and nothing said so.
        const db = open('2.0.0', V2)
        db.handle.prepare('INSERT INTO grant_rows (id, subject, created_at, updated_at) VALUES (?,?,?,?)')
            .run('b', 'dick', 2, 2)
        assert.equal(db.handle.prepare('SELECT COUNT(*) n FROM grant_rows').get().n, 2,
            'and the row written before the upgrade is still there')
        db.close()
    })

    it('keeps the data that was already in the durable table', () => {
        const db = open('2.0.0', V2)
        assert.equal(db.handle.prepare('SELECT subject FROM grant_rows WHERE id = ?').get('a')?.subject, 'dick')
        db.close()
    })

    it('never removes a column the schema dropped', () => {
        // Additive only. Dropping one from a durable table would discard data
        // the flag exists to keep.
        const shrunk = 'CREATE TABLE IF NOT EXISTS grant_rows (id TEXT PRIMARY KEY);'
        const db = open('3.0.0', shrunk)
        assert.ok(columns(db).includes('subject'), 'a column no longer declared must survive')
        db.close()
    })

    it('leaves non-durable tables alone — the wipe already recreates them', () => {
        // At the SAME version, so no wipe runs. That is the only way to tell
        // migration from recreation: bump the version and the table comes back
        // with the new columns whether or not anything migrated it, which is
        // why the first version of this test passed with the restriction
        // removed and proved nothing.
        let db = open('1.0.0', V1, { durable: false, filename: 'cache.sqlite' })
        db.close()
        db = open('1.0.0', V2, { durable: false, filename: 'cache.sqlite' })
        assert.ok(!columns(db).includes('updated_at'),
            'a cache table is not migrated — the next version change recreates it')
        db.close()
    })

    it('migrates a durable table at the same version too', () => {
        // The counterpart: no wipe here either, and the durable table must
        // still gain the column, because nothing else will ever give it one.
        let db = open('1.0.0', V1, { filename: 'same-version.sqlite' })
        db.close()
        db = open('1.0.0', V2, { filename: 'same-version.sqlite' })
        assert.ok(columns(db).includes('updated_at'))
        db.close()
    })
})

// The parser must read DDL, never prose.
//
// It split the CREATE TABLE body on commas and stripped `--` comments
// afterwards, per clause. A comma inside a comment therefore ended a clause,
// and the fragment after it no longer began with `--` so nothing stripped it:
// its first word became a column name. A live deployment ended up with real
// columns called `and`, `a` and `which`, taken from the prose of the schema's
// own comments — while the columns those comments described were omitted, and
// the first write naming one failed with "no such column".
describe('comments are not DDL', () => {
    const COMMENTED = `
        CREATE TABLE IF NOT EXISTS commented_rows (
            id TEXT PRIMARY KEY,
            -- A set is one request, and a request is finished when it stops.
            updated_at INTEGER,
            /* Somewhere of its own — a commit, a snapshot. Until then, this
               is null, which is a different answer from absent. */
            outcome TEXT,
            recorded_at INTEGER
        );`

    it('reads every declared column and invents none', () => {
        let db = createSqliteDatabase({
            runtimeFolder: dir, version: '1.0.0', config: { filename: 'commented.sqlite' },
            schemas: new Map([['c', { sql: COMMENTED, durable: true }]]),
        })
        db.open()
        const columns = db.handle.prepare('PRAGMA table_info(commented_rows)').all().map(c => c.name)
        db.close()

        assert.deepEqual(columns, ['id', 'updated_at', 'outcome', 'recorded_at'])
        for (const invented of ['and', 'a', 'which', 'is']) {
            assert.ok(!columns.includes(invented), `prose must not become a column (${invented})`)
        }
    })

    it('adds a column declared after a comma-bearing comment', () => {
        // The shipped failure exactly: `outcome` sits after a comment
        // containing a comma, so the migration never saw it and could never
        // add it — on the one kind of table nothing else can bring up to date.
        const WITHOUT = `CREATE TABLE IF NOT EXISTS grown_rows (
            id TEXT PRIMARY KEY, created_at INTEGER);`
        const WITH = `CREATE TABLE IF NOT EXISTS grown_rows (
            id TEXT PRIMARY KEY, created_at INTEGER,
            -- How it finished: committed, empty, or failed.
            outcome TEXT);`

        let db = createSqliteDatabase({
            runtimeFolder: dir, version: '1.0.0', config: { filename: 'grown.sqlite' },
            schemas: new Map([['g', { sql: WITHOUT, durable: true }]]),
        })
        db.open()
        db.handle.prepare('INSERT INTO grown_rows (id, created_at) VALUES (?,?)').run('a', 1)
        db.close()

        db = createSqliteDatabase({
            runtimeFolder: dir, version: '1.0.0', config: { filename: 'grown.sqlite' },
            schemas: new Map([['g', { sql: WITH, durable: true }]]),
        })
        db.open()
        // The write that failed in production.
        db.handle.prepare('UPDATE grown_rows SET outcome = ? WHERE id = ?').run('empty', 'a')
        assert.equal(db.handle.prepare('SELECT outcome FROM grown_rows WHERE id = ?').get('a').outcome, 'empty')
        db.close()
    })

    it('does not read a table name out of a comment', () => {
        const sql = `
            -- Superseded: CREATE TABLE old_rows was dropped in 2.0.
            CREATE TABLE IF NOT EXISTS real_rows (id TEXT PRIMARY KEY);`
        const db = createSqliteDatabase({
            runtimeFolder: dir, version: '1.0.0', config: { filename: 'named.sqlite' },
            schemas: new Map([['n', { sql, durable: true }]]),
        })
        db.open()
        // In the DURABLE file — that is what `durable: true` now means, and
        // an unqualified sqlite_master would list the cache instead.
        const tables = db.handle
            .prepare("SELECT name FROM durable.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all().map(t => t.name)
        db.close()
        assert.ok(tables.includes('real_rows'))
        assert.ok(!tables.includes('old_rows'), 'a comment must not register a table')
    })
})

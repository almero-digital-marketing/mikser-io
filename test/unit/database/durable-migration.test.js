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

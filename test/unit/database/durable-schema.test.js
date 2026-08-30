// A cache wipe must not take an OAuth client registration with it.
//
// The wipe exists because the database is DERIVED (ADR-0002): the files are
// the source of truth, so discarding it costs a rebuild and nothing else.
// That reasoning does not reach a table holding something no file can
// reproduce — a registered client, a refresh token, a form submission.
// Deleting the database file takes those too, and the first sign an operator
// gets is being asked to authorize again after a deploy.
//
// Two triggers reach this code in normal operation, both routine: a version
// change on every mikser upgrade, and a config-checksum change on every
// deploy that edits mikser.config.js.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSqliteDatabase } from '../../../src/database/index.js'

const CACHE_SCHEMA   = 'CREATE TABLE IF NOT EXISTS cache_rows (id TEXT PRIMARY KEY)'
const DURABLE_SCHEMA = 'CREATE TABLE IF NOT EXISTS grant_rows (id TEXT PRIMARY KEY)'

let dir
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mikser-durable-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

function open(version, { durable }) {
    const db = createSqliteDatabase({
        runtimeFolder: dir,
        version,
        config: { filename: 'durable.sqlite' },
        schemas: new Map([
            ['cache', CACHE_SCHEMA],
            ['grants', durable ? { sql: DURABLE_SCHEMA, durable: true } : DURABLE_SCHEMA],
        ]),
    })
    db.open()
    return db
}

function seed(db) {
    db.handle.exec("INSERT OR REPLACE INTO cache_rows (id) VALUES ('derived')")
    db.handle.exec("INSERT OR REPLACE INTO grant_rows (id) VALUES ('client-42')")
}

const count = (db, table) => db.handle.prepare(`SELECT count(*) c FROM ${table}`).get().c

describe('cache wipe with a durable schema', () => {
    it('keeps durable rows across a version change and still clears the cache', () => {
        let db = open('1.0.0', { durable: true })
        seed(db)
        assert.equal(count(db, 'grant_rows'), 1)
        db.close()

        db = open('2.0.0', { durable: true })   // schema mismatch → wipe
        assert.equal(count(db, 'grant_rows'), 1, 'the registration must survive an upgrade')
        assert.equal(count(db, 'cache_rows'), 0, 'the derived cache must still be cleared')
        db.close()
    })

    // The default has to stay destructive: everything that has ever
    // registered a schema is cache unless it says otherwise, and silently
    // preserving it would leave stale derived rows behind on an upgrade.
    it('still deletes a non-durable table on a version change', () => {
        let db = open('3.0.0', { durable: false })
        seed(db)
        db.close()

        db = open('4.0.0', { durable: false })
        assert.equal(count(db, 'grant_rows'), 0, 'without the flag the table is cache like any other')
        assert.equal(count(db, 'cache_rows'), 0)
        db.close()
    })
})

// Two ways durable data was destroyed anyway, both reached without any
// version change at all.
describe('durability is a property of the database, not of what is loaded', () => {
    let dir2
    before(async () => { dir2 = await mkdtemp(path.join(tmpdir(), 'mikser-durable2-')) })
    after(async () => { await rm(dir2, { recursive: true, force: true }) })

    const CACHE = 'CREATE TABLE IF NOT EXISTS derived_rows (id TEXT PRIMARY KEY)'
    const GRANTS = 'CREATE TABLE IF NOT EXISTS grant_rows (id TEXT PRIMARY KEY)'

    const open = (version, { withGrants, forceWipe = false } = {}) => {
        const schemas = new Map([['cache', CACHE]])
        if (withGrants) schemas.set('grants', { sql: GRANTS, durable: true })
        const db = createSqliteDatabase({
            runtimeFolder: dir2, version, config: { filename: 'durable2.sqlite' }, schemas, forceWipe,
        })
        db.open()
        return db
    }
    const count = (db, t) => { try { return db.handle.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n } catch { return 'GONE' } }

    it('survives a run whose config never loaded the owning plugin', () => {
        // The real shape: a prod config mounts auth, a dev config does not,
        // and both open the same working folder. The wipe used to ask only
        // the schemas THIS process registered, find none durable, and unlink
        // the file — signing every connected agent out from a run that never
        // mentioned auth.
        let db = open('1.0.0', { withGrants: true })
        db.handle.prepare('INSERT INTO grant_rows (id) VALUES (?)').run('refresh-token')
        db.close()

        db = open('2.0.0', { withGrants: false })   // the dev run
        db.close()

        db = open('2.0.0', { withGrants: true })    // back to prod
        assert.equal(count(db, 'grant_rows'), 1, 'a config that never heard of the plugin must not destroy its data')
        db.close()
    })

    it('--clear empties the cache and keeps the credentials', () => {
        // --clear removed the whole runtime folder, which took the database
        // and every durable table with it. It promises a rebuild; a sign-out
        // is not a rebuild.
        let db = open('2.0.0', { withGrants: true })
        db.handle.prepare('INSERT INTO grant_rows (id) VALUES (?)').run('client-registration')
        db.handle.prepare('INSERT INTO derived_rows (id) VALUES (?)').run('cached')
        db.close()

        db = open('2.0.0', { withGrants: true, forceWipe: true })
        assert.equal(count(db, 'derived_rows'), 0, 'the cache really is cleared')
        // By id, not by count: the previous test shares this database and
        // left a row in it, so a count asserts the fixture rather than the
        // behaviour.
        const kept = db.handle.prepare('SELECT id FROM grant_rows WHERE id = ?').get('client-registration')
        assert.equal(kept?.id, 'client-registration', 'the credentials really do survive')
        db.close()
    })
})

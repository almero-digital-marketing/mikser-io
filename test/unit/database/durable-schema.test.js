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

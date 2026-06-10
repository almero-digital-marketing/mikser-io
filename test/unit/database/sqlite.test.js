// Unit tests for the engine-level database.
//
// Exercises the `createSqliteDatabase` factory directly (without
// driving the lifecycle) so we can assert on each behavior in
// isolation. Schema integration with the lifecycle (registerSchema
// → onLoaded → db.open() applies it) is exercised by the smoke
// test, which runs a real cycle end-to-end.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSqliteDatabase } from '../../../src/database/sqlite.js'

function tmpdirFor(label) {
    return mkdtempSync(path.join(tmpdir(), `mikser-db-${label}-`))
}

describe('createSqliteDatabase — schema and lifecycle', () => {
    let runtimeFolder

    beforeEach(() => {
        runtimeFolder = tmpdirFor('schema')
    })

    it('opens at the default path under runtimeFolder', () => {
        const db = createSqliteDatabase({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
        })
        db.open()
        assert.equal(db.path, path.join(runtimeFolder, 'mikser.sqlite'))
        assert.equal(db.isOpen, true)
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('open() is idempotent — second call is a no-op', () => {
        const db = createSqliteDatabase({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
        })
        db.open()
        const handleA = db.handle
        db.open()
        const handleB = db.handle
        assert.equal(handleA, handleB, 'reopening should not swap the handle')
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('honors absolute config.filename', () => {
        const customPath = path.join(runtimeFolder, 'custom.sqlite')
        const db = createSqliteDatabase({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
            config: { filename: customPath },
        })
        db.open()
        assert.equal(db.path, customPath)
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('honors relative config.filename (resolved against runtimeFolder)', () => {
        const db = createSqliteDatabase({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
            config: { filename: 'shared.sqlite' },
        })
        db.open()
        assert.equal(db.path, path.join(runtimeFolder, 'shared.sqlite'))
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('supports :memory: filename for in-process / test use', () => {
        const db = createSqliteDatabase({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
            config: { filename: ':memory:' },
        })
        db.open()
        assert.equal(db.path, ':memory:')
        assert.equal(db.isOpen, true)
        db.close()
    })

    it('writes meta.schema_version on first open', () => {
        const db = createSqliteDatabase({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
        })
        db.open()
        const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
        assert.equal(stored.value, '8.2.0')
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('throws on schema_version mismatch with "run mikser --clear" hint', () => {
        const db1 = createSqliteDatabase({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
        })
        db1.open()
        db1.close()

        const db2 = createSqliteDatabase({
            runtimeFolder,
            version: '9.0.0',
            schemas: new Map(),
        })
        assert.throws(
            () => db2.open(),
            /Database schema is 8\.2\.0; this mikser-io expects 9\.0\.0.*mikser --clear/,
        )
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('applies registered schemas at open()', () => {
        const schemas = new Map([
            ['catalog', `
                CREATE TABLE IF NOT EXISTS catalog_entities (
                    id   TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                ) WITHOUT ROWID;
                CREATE INDEX IF NOT EXISTS idx_dummy ON catalog_entities(id);
            `],
        ])
        const db = createSqliteDatabase({
            runtimeFolder,
            version: '8.2.0',
            schemas,
        })
        db.open()

        // Schema applied — we can insert and query
        db.prepare('INSERT INTO catalog_entities (id, data) VALUES (?, ?)').run('a', '{}')
        const row = db.prepare('SELECT id, data FROM catalog_entities WHERE id = ?').get('a')
        assert.deepEqual(row, { id: 'a', data: '{}' })
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('schema apply is idempotent across re-opens', () => {
        const schemas = new Map([
            ['catalog', `
                CREATE TABLE IF NOT EXISTS catalog_entities (
                    id   TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                ) WITHOUT ROWID;
            `],
        ])
        const db1 = createSqliteDatabase({
            runtimeFolder, version: '8.2.0', schemas,
        })
        db1.open()
        db1.prepare('INSERT INTO catalog_entities (id, data) VALUES (?, ?)').run('a', '{}')
        db1.close()

        // Second open with the same schema — script reruns idempotently,
        // existing data survives
        const db2 = createSqliteDatabase({
            runtimeFolder, version: '8.2.0', schemas,
        })
        db2.open()
        const row = db2.prepare('SELECT id FROM catalog_entities WHERE id = ?').get('a')
        assert.equal(row.id, 'a')
        db2.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('throws with a useful message on malformed schema script', () => {
        const schemas = new Map([
            ['catalog', 'CREATE TABLE this is not valid sql;'],
        ])
        const db = createSqliteDatabase({
            runtimeFolder, version: '8.2.0', schemas,
        })
        assert.throws(
            () => db.open(),
            /Schema "catalog" failed to apply/,
        )
        rmSync(runtimeFolder, { recursive: true, force: true })
    })
})

describe('createSqliteDatabase — transactions', () => {
    let runtimeFolder

    beforeEach(() => {
        runtimeFolder = tmpdirFor('tx')
    })

    function makeDb() {
        const schemas = new Map([
            ['catalog', `
                CREATE TABLE IF NOT EXISTS catalog_entities (
                    id   TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                ) WITHOUT ROWID;
            `],
        ])
        const db = createSqliteDatabase({
            runtimeFolder, version: '8.2.0', schemas,
        })
        db.open()
        return db
    }

    it('transaction(fn) commits on normal return', () => {
        const db = makeDb()
        const insert = db.prepare('INSERT INTO catalog_entities (id, data) VALUES (?, ?)')
        db.transaction(() => {
            insert.run('a', '{}')
            insert.run('b', '{}')
        })
        const count = db.prepare('SELECT COUNT(*) AS c FROM catalog_entities').get().c
        assert.equal(count, 2)
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('transaction(fn) rolls back on throw', () => {
        const db = makeDb()
        const insert = db.prepare('INSERT INTO catalog_entities (id, data) VALUES (?, ?)')
        assert.throws(() => {
            db.transaction(() => {
                insert.run('a', '{}')
                throw new Error('boom')
            })
        }, /boom/)
        const count = db.prepare('SELECT COUNT(*) AS c FROM catalog_entities').get().c
        assert.equal(count, 0, 'failed transaction should leave no rows')
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('returns the value from fn()', () => {
        const db = makeDb()
        const out = db.transaction(() => 42)
        assert.equal(out, 42)
        db.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })
})

describe('registerSchema validation', () => {
    it('rejects empty/non-string name', async () => {
        const { registerSchema } = await import('../../../src/database/index.js')
        assert.throws(() => registerSchema('', 'CREATE TABLE x;'), /non-empty string/)
        assert.throws(() => registerSchema(null, 'CREATE TABLE x;'), /non-empty string/)
        assert.throws(() => registerSchema(123, 'CREATE TABLE x;'), /non-empty string/)
    })

    it('rejects empty/non-string sqlScript', async () => {
        const { registerSchema } = await import('../../../src/database/index.js')
        assert.throws(() => registerSchema('myplugin', ''), /non-empty string/)
        assert.throws(() => registerSchema('myplugin', null), /non-empty string/)
        assert.throws(() => registerSchema('myplugin', 42), /non-empty string/)
    })

    it('accepts a valid (name, sqlScript) pair', async () => {
        const { registerSchema } = await import('../../../src/database/index.js')
        assert.doesNotThrow(() => registerSchema('test_unit_db', `
            CREATE TABLE IF NOT EXISTS test_unit_db_data (id TEXT PRIMARY KEY);
        `))
    })
})

// Unit tests for the engine-level database substrate (Phase 1 of the
// engine/database migration).
//
// The substrate exposes registerSchema() + useDatabase() + sqlite
// driver. These tests exercise the driver directly (without driving
// the lifecycle) so we can assert on each behavior in isolation.
//
// Schema integration with the lifecycle (registerSchema → onLoaded →
// driver.open() applies it) is exercised by the smoke test, which
// runs a real cycle end-to-end.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSqliteDriver } from '../../../src/database/sqlite.js'

function tmpdirFor(label) {
    return mkdtempSync(path.join(tmpdir(), `mikser-db-${label}-`))
}

describe('createSqliteDriver — schema and lifecycle', () => {
    let runtimeFolder

    beforeEach(() => {
        runtimeFolder = tmpdirFor('schema')
    })

    it('opens at the default path under runtimeFolder', () => {
        const driver = createSqliteDriver({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
        })
        driver.open()
        assert.equal(driver.kind, 'sqlite')
        assert.equal(driver.path, path.join(runtimeFolder, 'mikser.sqlite'))
        assert.equal(driver.isOpen, true)
        driver.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('open() is idempotent — second call is a no-op', () => {
        const driver = createSqliteDriver({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
        })
        driver.open()
        const handleA = driver.handle
        driver.open()
        const handleB = driver.handle
        assert.equal(handleA, handleB, 'reopening should not swap the handle')
        driver.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('honors absolute config.filename', () => {
        const customPath = path.join(runtimeFolder, 'custom.sqlite')
        const driver = createSqliteDriver({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
            config: { filename: customPath },
        })
        driver.open()
        assert.equal(driver.path, customPath)
        driver.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('honors relative config.filename (resolved against runtimeFolder)', () => {
        const driver = createSqliteDriver({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
            config: { filename: 'shared.sqlite' },
        })
        driver.open()
        assert.equal(driver.path, path.join(runtimeFolder, 'shared.sqlite'))
        driver.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('supports :memory: filename for in-process / test use', () => {
        const driver = createSqliteDriver({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
            config: { filename: ':memory:' },
        })
        driver.open()
        assert.equal(driver.path, ':memory:')
        assert.equal(driver.isOpen, true)
        driver.close()
    })

    it('writes meta.schema_version on first open', () => {
        const driver = createSqliteDriver({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
        })
        driver.open()
        const stored = driver.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
        assert.equal(stored.value, '8.2.0')
        driver.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('throws on schema_version mismatch with "run mikser --clear" hint', () => {
        const driver1 = createSqliteDriver({
            runtimeFolder,
            version: '8.2.0',
            schemas: new Map(),
        })
        driver1.open()
        driver1.close()

        const driver2 = createSqliteDriver({
            runtimeFolder,
            version: '9.0.0',
            schemas: new Map(),
        })
        assert.throws(
            () => driver2.open(),
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
        const driver = createSqliteDriver({
            runtimeFolder,
            version: '8.2.0',
            schemas,
        })
        driver.open()

        // Schema applied — we can insert and query
        driver.prepare('INSERT INTO catalog_entities (id, data) VALUES (?, ?)').run('a', '{}')
        const row = driver.prepare('SELECT id, data FROM catalog_entities WHERE id = ?').get('a')
        assert.deepEqual(row, { id: 'a', data: '{}' })
        driver.close()
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
        const driver1 = createSqliteDriver({
            runtimeFolder, version: '8.2.0', schemas,
        })
        driver1.open()
        driver1.prepare('INSERT INTO catalog_entities (id, data) VALUES (?, ?)').run('a', '{}')
        driver1.close()

        // Second open with the same schema — script reruns idempotently,
        // existing data survives
        const driver2 = createSqliteDriver({
            runtimeFolder, version: '8.2.0', schemas,
        })
        driver2.open()
        const row = driver2.prepare('SELECT id FROM catalog_entities WHERE id = ?').get('a')
        assert.equal(row.id, 'a')
        driver2.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('throws with a useful message on malformed schema script', () => {
        const schemas = new Map([
            ['catalog', 'CREATE TABLE this is not valid sql;'],
        ])
        const driver = createSqliteDriver({
            runtimeFolder, version: '8.2.0', schemas,
        })
        assert.throws(
            () => driver.open(),
            /Schema "catalog" failed to apply/,
        )
        rmSync(runtimeFolder, { recursive: true, force: true })
    })
})

describe('createSqliteDriver — transactions', () => {
    let runtimeFolder

    beforeEach(() => {
        runtimeFolder = tmpdirFor('tx')
    })

    function makeDriver() {
        const schemas = new Map([
            ['catalog', `
                CREATE TABLE IF NOT EXISTS catalog_entities (
                    id   TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                ) WITHOUT ROWID;
            `],
        ])
        const driver = createSqliteDriver({
            runtimeFolder, version: '8.2.0', schemas,
        })
        driver.open()
        return driver
    }

    it('transaction(fn) commits on normal return', () => {
        const driver = makeDriver()
        const insert = driver.prepare('INSERT INTO catalog_entities (id, data) VALUES (?, ?)')
        driver.transaction(() => {
            insert.run('a', '{}')
            insert.run('b', '{}')
        })
        const count = driver.prepare('SELECT COUNT(*) AS c FROM catalog_entities').get().c
        assert.equal(count, 2)
        driver.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('transaction(fn) rolls back on throw', () => {
        const driver = makeDriver()
        const insert = driver.prepare('INSERT INTO catalog_entities (id, data) VALUES (?, ?)')
        assert.throws(() => {
            driver.transaction(() => {
                insert.run('a', '{}')
                throw new Error('boom')
            })
        }, /boom/)
        const count = driver.prepare('SELECT COUNT(*) AS c FROM catalog_entities').get().c
        assert.equal(count, 0, 'failed transaction should leave no rows')
        driver.close()
        rmSync(runtimeFolder, { recursive: true, force: true })
    })

    it('returns the value from fn()', () => {
        const driver = makeDriver()
        const out = driver.transaction(() => 42)
        assert.equal(out, 42)
        driver.close()
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

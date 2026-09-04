import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../../src/runtime.js'
import { createSqliteDatabase } from '../../../src/database/index.js'

// A report-and-exit invocation — --explain, --audit-output, --tools, --tool — never
// runs a build. Wiping the cache for one therefore destroys the state it was
// asked to describe and then answers from the empty result as though that were
// the answer.
//
// Measured on a real site: one `--tool mikser_query_entities` after an edit to
// mikser.config.js dropped 521 entities and replied `total: 0`, which reads as
// "there are none". The agent asking the question destroyed the build state and
// got a confidently wrong answer for it.

const SCHEMA = 'CREATE TABLE IF NOT EXISTS rows_t (id TEXT PRIMARY KEY)'

let dir
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mikser-readonly-')) })
after(async () => {
    await rm(dir, { recursive: true, force: true })
    runtime.options = { ...runtime.options, explain: undefined, auditOutput: undefined, tool: undefined, tools: undefined }
})

beforeEach(() => {
    runtime.options = {
        ...runtime.options,
        explain: undefined, auditOutput: undefined, tool: undefined, tools: undefined,
    }
})

function open({ version = '1.0.0', configChecksum } = {}) {
    runtime.options.configChecksum = configChecksum
    const db = createSqliteDatabase({
        runtimeFolder: dir,
        version,
        config: { filename: 'readonly.sqlite' },
        schemas: new Map([['rows', SCHEMA]]),
    })
    db.open()
    return db
}

const count = (db) => db.handle.prepare('SELECT count(*) c FROM rows_t').get().c

// Seeds a cache that a COMPLETED build left behind. commitStamp is what a
// finished cycle does, and it is what records the version and config this
// cache was built for — without it there is nothing for a later open to
// detect a change against, because an unstamped cache is by definition one
// whose rebuild never finished.
function seedAndClose({ configChecksum }) {
    const db = open({ configChecksum })
    db.handle.exec("INSERT OR REPLACE INTO rows_t (id) VALUES ('built')")
    assert.equal(count(db), 1)
    db.commitStamp()
    db.close?.()
}

describe('a read-only run does not wipe the cache it was asked to describe', () => {
    for (const flag of ['explain', 'auditOutput', 'tool', 'tools']) {
        it(`--${flag} keeps the cache when the config checksum moved`, () => {
            seedAndClose({ configChecksum: 'config-a' })
            runtime.options[flag] = flag === 'explain' ? '/documents/x.md'
                : flag === 'tool' ? 'mikser_ping' : true
            const db = open({ configChecksum: 'config-b' })
            assert.equal(count(db), 1,
                `--${flag} must not destroy the state it reports on`)
            db.close?.()
        })
    }

    it('keeps the cache when the SCHEMA version moved, too', () => {
        seedAndClose({ configChecksum: 'config-a' })
        runtime.options.tool = 'mikser_ping'
        const db = open({ version: '2.0.0', configChecksum: 'config-a' })
        assert.equal(count(db), 1)
        db.close?.()
    })

    it('still wipes for a BUILD, which is the run that rebuilds it', () => {
        // The wipe is correct when something will repopulate. Suppressing it
        // there would leave a stale cache forever.
        seedAndClose({ configChecksum: 'config-a' })
        const db = open({ configChecksum: 'config-b' })
        assert.equal(count(db), 0, 'a build must still wipe a stale cache')
        db.close?.()
    })

    it('leaves an unchanged cache alone in both modes', () => {
        seedAndClose({ configChecksum: 'config-a' })
        const build = open({ configChecksum: 'config-a' })
        assert.equal(count(build), 1)
        build.close?.()

        runtime.options.tool = 'mikser_ping'
        const read = open({ configChecksum: 'config-a' })
        assert.equal(count(read), 1)
        read.close?.()
    })
})

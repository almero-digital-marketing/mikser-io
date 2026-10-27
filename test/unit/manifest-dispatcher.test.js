// A snapshot records which dispatcher rendered it, and the reads that a
// dispatcher makes about "its" outputs see only its own.
//
// One entity can be a page (mikser-io-layouts) and the source of preset
// derivatives (mikser-io-assets) under the same id. Each row is re-recorded
// only when its own task renders, so the two drift apart: a page re-renders on
// derived meta while the derivatives beside it are reused from their markers.
// The end-to-end consequence — the finalize cleanup unlinking a live page — is
// in test/scenarios/shared-entity-dispatchers.test.js; this pins the parts that
// carry the name there.

import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import { createManifest, SNAPSHOTS_SCHEMA, FAILURES_SCHEMA } from '../../src/manifest/index.js'
import { createSqliteDatabase } from '../../src/database/index.js'
import { forgetMissingOutputs } from '../../src/invalidation.js'
import { inputHashOf } from '../../src/utils/index.js'

function makeDb() {
    const db = createSqliteDatabase({
        runtimeFolder: '/tmp',
        version: 'test',
        config: { filename: ':memory:' },
        schemas: new Map([
            ['mikser_snapshots', SNAPSHOTS_SCHEMA],
            ['mikser_failures', FAILURES_SCHEMA],
        ]),
    })
    db.open()
    return db
}

// recordedHashes omits an entity whose output is gone, so the outputs have to
// be there for the hash question to be the one asked.
const outputFolder = mkdtempSync(path.join(tmpdir(), 'manifest-dispatcher-'))
after(() => rmSync(outputFolder, { recursive: true, force: true }))
const PAGE = '/report/index.html'
const DERIVATIVE = path.join(outputFolder, 'assets', 'marks', 'report.webp')

beforeEach(() => {
    runtime.catalog = { byId: new Map() }
    runtime.options ??= {}
    runtime.options.outputFolder = outputFolder
    for (const file of [path.join(outputFolder, PAGE), DERIVATIVE]) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, 'rendered')
    }
    forgetMissingOutputs()
})

// The same entity at two moments: the page saw the new meta, the derivative
// was last rendered from the old.
const before = { id: '/report.json', meta: { score: 1 }, content: '{}' }
const now = { ...before, meta: { score: 2 } }

function twoDispatchers() {
    const m = createManifest(makeDb())
    m.record({ ...before, destination: DERIVATIVE }, [], undefined, undefined, 'assets')
    m.record({ ...now, destination: PAGE }, [], undefined, undefined, 'layouts')
    return m
}

describe('a snapshot carries its dispatcher', () => {
    it('is read back with the dispatcher that recorded it', () => {
        const m = twoDispatchers()
        const byDestination = Object.fromEntries(
            m.snapshotsFor('/report.json').map(s => [s.destination, s.dispatcher]))
        assert.deepEqual(byDestination, { [PAGE]: 'layouts', [DERIVATIVE]: 'assets' })
    })

    it('is absent when the task named none', () => {
        const m = createManifest(makeDb())
        m.record({ ...now, destination: PAGE }, [])
        assert.equal(m.lookup({ id: now.id, destination: PAGE }).dispatcher, undefined)
    })
})

describe('recordedHashes(dispatcher)', () => {
    it('answers from that dispatcher\'s renders only', () => {
        const m = twoDispatchers()
        assert.equal(m.recordedHashes('layouts').get('/report.json'), inputHashOf(now))
        assert.equal(m.recordedHashes('assets').get('/report.json'), inputHashOf(before))
    })

    it('does not let another dispatcher\'s row vouch for a render it never saw', () => {
        // The case that matters: the meta moves BACK. The page last rendered
        // `now`, so `before` is a change for it — and the derivative's row,
        // which still holds `before`, must not make it look current.
        const m = twoDispatchers()
        assert.notEqual(m.recordedHashes('layouts').get('/report.json'), inputHashOf(before))
    })

    it('reads every row when no dispatcher is named', () => {
        const m = twoDispatchers()
        assert.ok(m.recordedHashes().has('/report.json'))
    })
})

describe('recordNoOutput(id, dispatcher)', () => {
    it('keeps each report with the dispatcher that made it', () => {
        const m = createManifest(makeDb())
        m.recordNoOutput('/report.json', 'layouts')
        m.recordNoOutput('/report.json', 'layouts')
        m.recordNoOutput('/plain.md')
        assert.deepEqual([...m._noOutputIds].map(([id, by]) => [id, [...by]]),
            [['/report.json', ['layouts']], ['/plain.md', [null]]])
    })
})

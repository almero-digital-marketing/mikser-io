// Faults — the report's view of coded error records.
//
// These go through the REAL logger rather than calling captureFault directly,
// because the thing under test is the seam: the log call is the only way to
// raise a fault, and a test that reaches past it would pass while the stream
// that feeds it was disconnected. That is the exact failure this feature
// exists to make visible, so it is not one the tests may have.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import path from 'node:path'
import { tmpdir } from 'node:os'

import { createMikserLogger } from '../../src/logger.js'
import { recordChangeSetWrite, forgetAllChangeSets, pendingChangeSets } from '../../src/changeset.js'
import { faults, resetFaults, buildReport, requestReport, resetReport } from '../../src/report.js'
import runtime from '../../src/runtime.js'

describe('faults', () => {
    let priorEngine, priorState, priorOptions
    let logger

    beforeEach(() => {
        priorEngine = runtime.engine
        priorState = runtime.state
        priorOptions = runtime.options
        runtime.state = {}
        runtime.options = { ...runtime.options }
        resetFaults()
        logger = createMikserLogger('info')
    })
    afterEach(() => {
        resetFaults()
        runtime.engine = priorEngine
        runtime.state = priorState
        runtime.options = priorOptions
    })

    it('captures an error carrying a code', () => {
        logger.error({ code: 'change-set-log' }, 'The log could not be written (%s).', 'no such column')
        const open = faults()
        assert.equal(open.length, 1)
        assert.equal(open[0].code, 'change-set-log')
        assert.equal(open[0].message, 'The log could not be written (no such column).')
        assert.equal(open[0].count, 1)
        assert.ok(open[0].first > 0 && open[0].last >= open[0].first)
    })

    it('keeps extra fields from the log call', () => {
        logger.error({ code: 'search-index', table: 'mikser_entities' }, 'unusable')
        assert.equal(faults()[0].table, 'mikser_entities')
    })

    it('ignores an error with no code', () => {
        // Already carried in `errors` with the entity attached. Forty failed
        // renders must not read as forty broken subsystems.
        logger.error('Render error: %s %s', 'doc-1', 'boom')
        logger.error('Render error: %s %s', 'doc-2', 'boom')
        assert.deepEqual(faults(), [])
    })

    it('does not capture an errno from a thrown Error', () => {
        // pino puts it under `err`, not at the top level — so a raw throw
        // logged this way is an event, not a declared condition.
        const err = new Error('missing'); err.code = 'ENOENT'
        logger.error(err, 'Preset loading error')
        assert.deepEqual(faults(), [])
    })

    it('counts repeats as one condition', () => {
        for (let i = 0; i < 40; i++) logger.error({ code: 'change-set-log' }, 'broken')
        const open = faults()
        assert.equal(open.length, 1)
        assert.equal(open[0].count, 40)
        assert.ok(open[0].last >= open[0].first)
    })

    it('survives a cycle reset, unlike warnings', () => {
        requestReport()
        logger.warn({ code: 'preset-no-match' }, 'no preset matched')
        logger.error({ code: 'change-set-log' }, 'broken')
        assert.equal(buildReport().warnings.length, 1)

        resetReport()
        // The warning described one cycle. The fault describes a subsystem,
        // which is still broken in the next one.
        assert.equal(buildReport().warnings.length, 0)
        assert.equal(faults().length, 1)
    })

    it('is recorded with no report reader asking', () => {
        // Unlike warnings: a deployed watch server is exactly where a broken
        // subsystem matters, and gating this on --json would lose it there.
        runtime.options.json = false
        runtime.options.reportRequested = false
        logger.error({ code: 'change-set-log' }, 'broken')
        assert.equal(faults().length, 1)
    })

    it('reaches the build report and its summary', () => {
        requestReport()
        logger.error({ code: 'change-set-log' }, 'broken')
        const report = buildReport()
        assert.equal(report.summary.faults, 1)
        assert.equal(report.faults[0].code, 'change-set-log')
        // Distinct from `errors`, which stays "a render ran and threw".
        assert.deepEqual(report.errors, [])
    })

    it('orders most recently seen first', () => {
        logger.error({ code: 'first' }, 'a')
        logger.error({ code: 'second' }, 'b')
        logger.error({ code: 'first' }, 'a again')
        assert.deepEqual(faults().map(f => f.code), ['first', 'second'])
    })

    it('still captures warnings unchanged', () => {
        requestReport()
        logger.warn({ code: 'preset-no-match', preset: 'thumb' }, 'no match for %s', 'hero.jpg')
        const [warning] = buildReport().warnings
        assert.equal(warning.code, 'preset-no-match')
        assert.equal(warning.preset, 'thumb')
        assert.equal(warning.message, 'no match for hero.jpg')
        assert.deepEqual(faults(), [])
    })

    it('surfaces a real subsystem failure, not just a synthetic log call', async () => {
        // The historical case, reproduced: a durable table left with an older
        // column shape. Every write to the change-set log throws, the write
        // itself still succeeds, and the feature silently becomes a no-op that
        // looks like it is working — which is the failure this whole surface
        // exists to make sayable.
        const knexFactory = (await import('knex')).default
        const knex = knexFactory({
            client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
        })
        await knex.schema.createTable('mikser_change_sets', (t) => t.string('id').primary())

        const priorDurable = runtime.durable
        runtime.durable = knex
        runtime.engine = { logger }
        runtime.options.workingFolder = tmpdir()
        forgetAllChangeSets()
        try {
            const id = recordChangeSetWrite({ changeSet: 'cs-1', uri: path.join(tmpdir(), 'documents', 'x.md') })
            // The write is still attributed in memory — the log is what broke.
            assert.equal(id, 'cs-1')
            // Reading drains the write queue, which is where the failure lands.
            await pendingChangeSets()

            const [fault] = faults()
            assert.equal(fault.code, 'change-set-log')
            assert.match(fault.message, /cannot be listed or undone/)
        } finally {
            runtime.durable = priorDurable
            await knex.destroy()
        }
    })
})

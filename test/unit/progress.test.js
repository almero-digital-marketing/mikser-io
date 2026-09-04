// The progress bar, and the two things it must not do.
//
// It writes to stdout. stdout is also where --json and --tool put their
// DOCUMENT, and a forwarded request captures the instance's stdout writes and
// frames them to the client — so the gauge landed inside the JSON:
//
//     ^[[?25lDocuments import: >416/800
//
// at byte 0, and JSON.parse threw. Four runs in ten at the default level on an
// 800-document corpus, six in ten at --log warn.
//
// Tested here rather than as a scenario because a scenario cannot see it: the
// harness spawns the instance with a pipe, so `process.stdout.isTTY` is false,
// the bar never draws, and a test that forwards --json and parses the result
// passes whether or not the invariant holds. The invariant is "a bar never
// starts while stdout carries a document", and that is what this asserts.
//
// The second thing: suppressing the bar must not suppress the INFORMATION.
// Tracking and drawing used to be one decision, so anything that could not
// draw also stopped counting — and stopProgress returns early without a bar,
// which is where the "finished: N in Ns" line comes from. A piped build
// reported no phase timings at all.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { trackProgress, updateProgress, stopProgress } from '../../src/logger.js'

let records
const priorEngine = runtime.engine
const priorOptions = runtime.options

beforeEach(() => {
    records = []
    const capture = (level) => (...args) => {
        const fields = typeof args[0] === 'object' ? args[0] : {}
        records.push({ level, ...fields })
    }
    runtime.engine = { logger: { info: capture('info'), warn: capture('warn'), debug: capture('debug') } }
    runtime.options = { ...priorOptions, info: true }
})

afterEach(() => {
    stopProgress()
    runtime.engine = priorEngine
    runtime.options = priorOptions
})

const coded = (code) => records.filter(r => r.code === code)

describe('the progress bar never writes where a document is written', () => {
    for (const flag of ['json', 'tool', 'tools']) {
        it(`starts no bar under --${flag}`, () => {
            runtime.options[flag] = flag === 'tool' ? 'mikser_ping' : true
            trackProgress('Import', 4)
            // The bar is what corrupts the document; a record is not.
            assert.equal(coded('progress').length, 1,
                'the phase is still reported, as data')
            assert.equal(coded('progress')[0].value, 0)
            assert.equal(coded('progress')[0].total, 4)
        })
    }

    it('reports the phase even when nothing can be drawn', () => {
        // A piped build — no TTY — used to report no phase timings at all,
        // because tracking and drawing were one decision.
        runtime.options.json = true
        trackProgress('Import', 4)
        for (let i = 0; i < 4; i++) updateProgress()
        const finished = coded('progress-finished')
        assert.equal(finished.length, 1, 'the phase says when it finished')
        assert.equal(finished[0].phase, 'Import')
        assert.equal(finished[0].total, 4)
        assert.equal(typeof finished[0].ms, 'number')
    })

    it('reports at quartiles rather than per item', () => {
        // A bar redraws in place and costs one line; a log record does not.
        // 800 documents must not become 800 lines.
        runtime.options.json = true
        trackProgress('Import', 100)
        for (let i = 0; i < 100; i++) updateProgress()
        const during = coded('progress')
        assert.ok(during.length <= 4,
            `expected at most a start plus quartiles, got ${during.length}`)
        assert.deepEqual(during.map(r => r.value), [0, 25, 50, 75])
    })

    it('says so when a phase does not finish', () => {
        runtime.options.json = true
        trackProgress('Import', 10)
        updateProgress()
        stopProgress()
        const unfinished = coded('progress-unfinished')
        assert.equal(unfinished.length, 1)
        assert.equal(unfinished[0].missing, 9)
        assert.equal(unfinished[0].level, 'warn', 'and it is a warning, not a note')
    })
})

// The progress bar, and the three things it must not do.
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
// starts while stdout carries a document", and these tests fake a TTY so that
// the choice is actually made.
//
// The second thing: suppressing the bar must not suppress the INFORMATION.
// Tracking and drawing used to be one decision, so anything that could not
// draw also stopped counting — and stopProgress returns early without a bar,
// which is where the "finished: N in Ns" line comes from. A piped build
// reported no phase timings at all.
//
// The third thing, which is what the first fix for the second got wrong: a
// record per quartile is right for 800 documents and absurd for 5. Eleven of
// a plain build's thirteen phases carry five items, so a piped no-op build
// went from 32 lines to 97 — five records in the same millisecond to say a
// phase did nothing, written into the log a deployment keeps.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import {
    trackProgress, updateProgress, stopProgress, formatDuration, PROGRESS_INTERVAL_MS,
} from '../../src/logger.js'

let records
const priorEngine = runtime.engine
const priorOptions = runtime.options
const priorTTY = process.stdout.isTTY
const priorNow = performance.now
let clock = 0
const tick = (ms) => { clock += ms }

beforeEach(() => {
    records = []
    const capture = (level) => (...args) => {
        const object = typeof args[0] === 'object'
        const fields = object ? args[0] : {}
        records.push({ level, ...fields, args: object ? args.slice(1) : args })
    }
    runtime.engine = { logger: { info: capture('info'), warn: capture('warn'), debug: capture('debug') } }
    runtime.options = { ...priorOptions, info: true }
    // performance.now, because that is the clock phases are timed on and
    // node:test's mock.timers does not cover it (verified: ticking Date
    // leaves performance.now advancing on its own).
    clock = 0
    performance.now = () => clock
})

afterEach(() => {
    stopProgress()
    performance.now = priorNow
    runtime.engine = priorEngine
    runtime.options = priorOptions
    process.stdout.isTTY = priorTTY
})

const coded = (code) => records.filter(r => r.code === code)
const run = (count, detail) => { for (let i = 0; i < count; i++) updateProgress(detail) }

describe('progress is reported for long phases and nothing else', () => {
    it('says nothing about the RUNNING of a phase that took no time', () => {
        // The regression this exists for. Five items, one millisecond, and
        // the old code printed 0/5, 2/5, 3/5, 4/5 and a finished line.
        runtime.options.json = true
        trackProgress('Import', 5)
        run(5)
        assert.deepEqual(coded('progress'), [],
            'no running commentary on a phase that did nothing')
    })

    it('still says that the phase RAN, however brief', () => {
        // The gate is on the commentary, never on this. With the quartiles
        // held back it is the only record a short phase produces, so gating
        // it too left a build unable to say what it had done — and off a TTY
        // it is the only place phase timings come from.
        runtime.options.json = true
        trackProgress('Import', 5)
        run(5)
        assert.equal(coded('progress-finished').length, 1)
        assert.equal(coded('progress-finished')[0].total, 5)
    })

    it('gives a duration at the resolution it has, not rounded away to 0s', () => {
        // `Documents import finished: 5 0s` reported the whole phase as
        // nothing. Under a second the number IS the information.
        runtime.options.json = true
        trackProgress('Import', 5)
        tick(340)
        run(5)
        const finished = coded('progress-finished')[0]
        assert.equal(finished.ms, 340)
        assert.ok(finished.args.includes('340ms'),
            `340ms must not print as 0s — got ${JSON.stringify(finished.args)}`)
    })

    it('measures below a millisecond, where most phases actually live', () => {
        // Moving from seconds to milliseconds moved the same defect one order
        // of magnitude down: nine of a plain build's thirteen phases printed
        // `0ms`. Date.now() cannot resolve this at all, which is why phases
        // are timed on performance.now().
        runtime.options.json = true
        trackProgress('Catalog', 6)
        tick(0.42)
        run(6)
        const finished = coded('progress-finished')[0]
        assert.equal(finished.ms, 0.42, 'the field keeps sub-millisecond precision')
        assert.ok(finished.args.includes('0.42ms'),
            `a sub-millisecond phase must read as a measurement — got ${JSON.stringify(finished.args)}`)
    })

    it('reports on a TIME interval, not per item and not per quartile', () => {
        // A quartile is a fraction of the WORK, so it says nothing about how
        // often a line appears — four records in three seconds on a fast
        // phase, four records over an hour on a slow one. 800 documents must
        // not become 800 lines, and neither must a long phase go quiet.
        runtime.options.json = true
        trackProgress('Import', 1000)
        for (let i = 0; i < 1000; i++) {
            tick(300)          // 300s of work, ten intervals
            updateProgress()
        }
        // Nine, not ten: the interval that lands exactly on the last item is
        // the finished line's, not a progress record's.
        const during = coded('progress')
        assert.deepEqual(during.map(r => r.value),
            [100, 200, 300, 400, 500, 600, 700, 800, 900])
    })

    it('reports a SMALL phase that is SLOW, which a count threshold could not', () => {
        // Four PDFs through Chrome: a small phase and a slow one, and exactly
        // the phase worth narrating. This is why the gate is elapsed time and
        // not a minimum total.
        runtime.options.json = true
        trackProgress('Postprocess', 4)
        for (let i = 0; i < 4; i++) { tick(PROGRESS_INTERVAL_MS + 1); updateProgress() }
        assert.ok(coded('progress').length > 0, 'a slow phase reports however few items it has')
        assert.equal(coded('progress-finished').length, 1)
    })

    it('stays quiet for a phase that finishes inside one interval', () => {
        // Its finished line covers it. This is the case that took a piped
        // no-op build from 32 lines to 97.
        runtime.options.json = true
        trackProgress('Import', 100)
        tick(PROGRESS_INTERVAL_MS - 1)
        run(100)
        assert.equal(coded('progress').length, 0, 'no running commentary')
        assert.equal(coded('progress-finished').length, 1, 'but it still says it ran')
    })

    it('says what finished, how much of it, and what it cost', () => {
        runtime.options.json = true
        trackProgress('Rendering', 4)
        tick(1500)
        run(4, '/documents/post.md')
        const finished = coded('progress-finished')
        assert.equal(finished.length, 1, 'the phase says when it finished')
        assert.equal(finished[0].phase, 'Rendering')
        assert.equal(finished[0].total, 4)
        assert.equal(finished[0].ms, 1500)
        assert.ok(finished[0].args.includes('1.5s'))
        // The PHASE is the subject, not the last item the walk happened to
        // end on: seven journal phases reported the same /layouts/page.hbs,
        // and a filename here broke a test asserting that file is never
        // mentioned in the build output.
        assert.equal(finished[0].detail, undefined,
            'the finished line names the phase, not an arbitrary entity')
    })

    it('says so when a phase does not finish, at any duration', () => {
        // A warning, not progress: an abandoned phase is unexpected however
        // briefly it ran, so it is deliberately not behind the time gate.
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

describe('a duration is a measurement, never a zero', () => {
    // Each band printed at the resolution it has. The floor is not
    // decoration: a monotonic clock can return two identical readings, and
    // `0.00ms` would be the same lie one order of magnitude further down.
    const cases = [
        [0,       '<0.01ms'],
        [0.004,   '<0.01ms'],
        [0.42,    '0.42ms'],
        [0.999,   '1.00ms'],
        [1,       '1ms'],
        [340,     '340ms'],
        [999.6,   '1000ms'],
        [1000,    '1.0s'],
        [3200,    '3.2s'],
        [44400,   '44.4s'],
    ]
    for (const [ms, expected] of cases) {
        it(`${ms}ms reads as ${expected}`, () => {
            assert.equal(formatDuration(ms), expected)
        })
    }

    it('never renders a bare zero at any magnitude', () => {
        for (const ms of [0, 0.0001, 0.001, 0.009]) {
            assert.doesNotMatch(formatDuration(ms), /^0(\.0+)?(ms|s)$/,
                `${ms} rendered as ${formatDuration(ms)}`)
        }
    })
})

describe('progress says WHAT is progressing', () => {
    it('carries the item the phase is on', () => {
        // A phase name says a build is doing something. What a stuck build
        // has to say is what it is stuck ON.
        runtime.options.json = true
        trackProgress('Rendering', 100)
        tick(PROGRESS_INTERVAL_MS + 1)
        run(100, '/documents/post.md')
        assert.equal(coded('progress')[0].detail, '/documents/post.md')
    })

    it('leaves an entity id alone rather than relativising it', () => {
        // An entity id LOOKS absolute and is not a filesystem path.
        // `/documents/p3706.md` against the working folder became
        // `../../../documents/p3706.md`, which names nothing anyone can act on.
        runtime.options.json = true
        runtime.options.workingFolder = '/srv/site'
        trackProgress('Rendering', 100)
        tick(PROGRESS_INTERVAL_MS + 1)
        run(100, '/documents/p3706.md')
        assert.equal(coded('progress')[0].detail, '/documents/p3706.md')
    })

    it('shortens a real path that IS inside the working folder', () => {
        runtime.options.json = true
        runtime.options.workingFolder = '/srv/site'
        trackProgress('Import', 100)
        tick(PROGRESS_INTERVAL_MS + 1)
        run(100, '/srv/site/documents/post.md')
        assert.equal(coded('progress')[0].detail, 'documents/post.md')
    })

    it('reports the phase without a detail when the call site has none', () => {
        runtime.options.json = true
        trackProgress('Import', 100)
        tick(PROGRESS_INTERVAL_MS + 1)
        run(100)
        const first = coded('progress')[0]
        assert.ok(first, 'still reported')
        assert.equal(first.detail, undefined)
    })
})

describe('the progress bar never writes where a document is written', () => {
    for (const flag of ['json', 'tool', 'tools']) {
        it(`starts no bar under --${flag}, even on a TTY`, () => {
            // A real TTY, so the choice is actually made. Without this the
            // test passes on the harness's pipe no matter what the code does.
            process.stdout.isTTY = true
            runtime.options[flag] = flag === 'tool' ? 'mikser_ping' : true
            trackProgress('Import', 100)
            tick(PROGRESS_INTERVAL_MS + 1)
            run(100)
            assert.ok(coded('progress').length > 0,
                'records, not a bar — the phase took the non-drawn branch')
        })
    }
})

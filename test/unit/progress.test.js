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

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import {
    trackProgress, updateProgress, stopProgress, PROGRESS_MIN_MS,
} from '../../src/logger.js'

let records
const priorEngine = runtime.engine
const priorOptions = runtime.options
const priorTTY = process.stdout.isTTY

beforeEach(() => {
    records = []
    const capture = (level) => (...args) => {
        const fields = typeof args[0] === 'object' ? args[0] : {}
        records.push({ level, ...fields })
    }
    runtime.engine = { logger: { info: capture('info'), warn: capture('warn'), debug: capture('debug') } }
    runtime.options = { ...priorOptions, info: true }
    // Date only — setTimeout must keep working for the test runner itself.
    mock.timers.enable({ apis: ['Date'] })
})

afterEach(() => {
    stopProgress()
    mock.timers.reset()
    runtime.engine = priorEngine
    runtime.options = priorOptions
    process.stdout.isTTY = priorTTY
})

const coded = (code) => records.filter(r => r.code === code)
const run = (count, detail) => { for (let i = 0; i < count; i++) updateProgress(detail) }

describe('progress is reported for long phases and nothing else', () => {
    it('says nothing at all about a phase that took no time', () => {
        // The regression this exists for. Five items, one millisecond, and
        // the old code printed 0/5, 2/5, 3/5, 4/5 and a finished line.
        runtime.options.json = true
        trackProgress('Import', 5)
        run(5)
        assert.deepEqual(records.filter(r => r.code?.startsWith('progress')), [],
            'a phase that did nothing has nothing to report')
    })

    it('reports a phase that runs long, at quartiles rather than per item', () => {
        // A bar redraws in place and costs one line; a log record does not.
        // 800 documents must not become 800 lines.
        runtime.options.json = true
        trackProgress('Import', 100)
        mock.timers.tick(PROGRESS_MIN_MS + 1)
        run(100)
        const during = coded('progress')
        assert.ok(during.length <= 4,
            `expected at most quartiles, got ${during.length}`)
        assert.deepEqual(during.map(r => r.value), [25, 50, 75])
    })

    it('reports a SMALL phase that is SLOW, which a count threshold could not', () => {
        // Four PDFs through Chrome: a small phase and a slow one, and exactly
        // the phase worth narrating. This is why the gate is elapsed time and
        // not a minimum total.
        runtime.options.json = true
        trackProgress('Postprocess', 4)
        for (let i = 0; i < 4; i++) { mock.timers.tick(30_000); updateProgress() }
        assert.ok(coded('progress').length > 0, 'a slow phase reports however few items it has')
        assert.equal(coded('progress-finished').length, 1)
    })

    it('does not burst the milestones it passed under the threshold', () => {
        // The milestone has to advance whether or not the record is emitted.
        // Held back, every quartile the phase passed while it was still quick
        // would fire at once the moment it crossed.
        runtime.options.json = true
        trackProgress('Import', 100)
        run(60)
        assert.equal(coded('progress').length, 0, 'still quick, still quiet')
        mock.timers.tick(PROGRESS_MIN_MS + 1)
        run(40)
        assert.deepEqual(coded('progress').map(r => r.value), [75],
            'only the quartile it actually reached while slow')
    })

    it('says when a long phase finished, and how long it took', () => {
        runtime.options.json = true
        trackProgress('Import', 4)
        mock.timers.tick(PROGRESS_MIN_MS + 500)
        run(4)
        const finished = coded('progress-finished')
        assert.equal(finished.length, 1, 'the phase says when it finished')
        assert.equal(finished[0].phase, 'Import')
        assert.equal(finished[0].total, 4)
        assert.equal(finished[0].ms, PROGRESS_MIN_MS + 500)
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

describe('progress says WHAT is progressing', () => {
    it('carries the item the phase is on', () => {
        // A phase name says a build is doing something. What a stuck build
        // has to say is what it is stuck ON.
        runtime.options.json = true
        trackProgress('Rendering', 100)
        mock.timers.tick(PROGRESS_MIN_MS + 1)
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
        mock.timers.tick(PROGRESS_MIN_MS + 1)
        run(100, '/documents/p3706.md')
        assert.equal(coded('progress')[0].detail, '/documents/p3706.md')
    })

    it('shortens a real path that IS inside the working folder', () => {
        runtime.options.json = true
        runtime.options.workingFolder = '/srv/site'
        trackProgress('Import', 100)
        mock.timers.tick(PROGRESS_MIN_MS + 1)
        run(100, '/srv/site/documents/post.md')
        assert.equal(coded('progress')[0].detail, 'documents/post.md')
    })

    it('reports the phase without a detail when the call site has none', () => {
        runtime.options.json = true
        trackProgress('Import', 100)
        mock.timers.tick(PROGRESS_MIN_MS + 1)
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
            mock.timers.tick(PROGRESS_MIN_MS + 1)
            run(100)
            assert.ok(coded('progress').length > 0,
                'records, not a bar — the phase took the non-drawn branch')
        })
    }
})

// Which clock "how long until the first render" is measured against.
//
// Two different questions wear similar names. `cycle.startedAt` is the
// report's window — stamped when a rebuild is triggered, and on the first
// cycle filled in lazily by whatever first reported, so it can land well
// after a cold build began. `cycleBeganAt` is where the reader's wait
// started, which for the first cycle is the process itself: the import scan
// is most of what they sat through, and it happens before any cycle exists.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { cycleBeganAt } from '../../src/report.js'

describe('the clock a cycle is measured from', () => {
    beforeEach(() => { runtime.state = {} })

    it('is the process, before any cycle exists', () => {
        // A one-shot build that has not reported anything yet: the render
        // dispatcher asks this while `runtime.state.cycle` is still absent.
        assert.equal(cycleBeganAt(), performance.timeOrigin)
    })

    it('is the process for the first cycle, whenever it was stamped', () => {
        // Stamped by `store()` at the moment of the first report, which on a
        // large build is minutes into the run. Measuring from it would say a
        // restart reached its first render immediately.
        runtime.state.cycle = { id: 1, startedAt: Date.now(), finishedAt: null }
        assert.equal(cycleBeganAt(), performance.timeOrigin)
    })

    it('is the rebuild trigger for every cycle after the first', () => {
        // A watch rebuild has a real start: resetReport() stamps it when the
        // debounce fires, before any of the work this measures.
        const startedAt = Date.now() - 5_000
        runtime.state.cycle = { id: 2, startedAt, finishedAt: null }
        assert.equal(cycleBeganAt(), startedAt)
    })
})

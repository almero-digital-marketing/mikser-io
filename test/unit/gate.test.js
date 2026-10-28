// How many tasks carrying one key may be dispatched at once.
//
// The dispatcher is the only place this can be held. A renderer that spawns
// an external process — ffmpeg, a headless browser — needs a cap on how many
// of itself run, and it cannot hold that cap itself: under WORKER dispatch
// its code runs in a worker, so a counter it keeps is per thread and the
// limit comes out multiplied by the pool size. mikser-io-assets paid for that
// by pinning every capped preset to INLINE, which made a capped, CPU-bound
// preset impossible to run in parallel at all.
//
// PEAK is the assertion, never the completed count: a gate that let
// everything through at once and then finished would satisfy any test that
// only counted completions.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { withGate, gateState, resetGates } from '../../src/engine/gate.js'

// A task that parks inside the gate until it is let go, so the peak can be
// read when every participant has arrived rather than after a guessed delay.
function holding() {
    const seen = { active: 0, peak: 0, completed: 0 }
    let release
    const held = new Promise(resolve => { release = resolve })
    const task = async () => {
        seen.active++
        seen.peak = Math.max(seen.peak, seen.active)
        await held
        seen.active--
        seen.completed++
    }
    return { seen, task, release }
}

// Every caller accounted for at the gate — running or queued. Once this
// holds, the peak is final: an over-admitting gate is visible and an
// over-restrictive one times out.
const allArrived = async (key, count, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (true) {
        const { active, waiting } = gateState(key)
        if (active + waiting === count) return
        assert.ok(Date.now() < deadline, `timed out waiting for ${count} at ${key}`)
        await new Promise(resolve => setTimeout(resolve, 5))
    }
}

// A lost slot deadlocks, and a deadlocked await reports itself as a test that
// ran out of time with no reason attached. This gives it one.
const within = (promise, what, ms = 15000) => Promise.race([
    promise,
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
        timer.unref?.()
    }),
])

describe('the dispatch gate', () => {
    beforeEach(() => resetGates())

    it('runs one at a time when asked for one', async () => {
        const { seen, task, release } = holding()
        const all = Array.from({ length: 6 }, () => withGate('video', 1, task))
        await allArrived('video', 6)
        assert.equal(seen.peak, 1, `${seen.peak} ran at once`)
        release()
        await within(Promise.all(all), 'the queue to drain')
        assert.equal(seen.completed, 6, 'the gate stopped handing out slots')
        assert.equal(seen.peak, 1, 'and never exceeded the cap while draining')
    })

    it('runs two at a time when asked for two', async () => {
        const { seen, task, release } = holding()
        const all = Array.from({ length: 6 }, () => withGate('video', 2, task))
        await allArrived('video', 6)
        assert.equal(seen.peak, 2)
        release()
        await within(Promise.all(all), 'the queue to drain')
    })

    it('does not gate a task with no key', async () => {
        // The overwhelmingly common case — an ordinary page render — and it
        // must cost one comparison, not a map lookup and a queue.
        const { seen, task, release } = holding()
        const all = Array.from({ length: 5 }, () => withGate(undefined, 1, task))
        await within((async () => { while (seen.active < 5) await new Promise(r => setTimeout(r, 5)) })(),
            'all five to run at once')
        assert.equal(seen.peak, 5)
        release()
        await within(Promise.all(all), 'them to finish')
    })

    it('keeps a separate cap per key, not one shared between them', async () => {
        // Two capped presets in one build is the ordinary case. A shared
        // counter would serialise unrelated work and read as a mysteriously
        // slow build.
        const video = holding()
        const poster = holding()
        const all = [
            ...Array.from({ length: 4 }, () => withGate('preset:video', 1, video.task)),
            ...Array.from({ length: 4 }, () => withGate('preset:poster', 2, poster.task)),
        ]
        await allArrived('preset:video', 4)
        await allArrived('preset:poster', 4)
        assert.equal(video.seen.peak, 1, `video ran ${video.seen.peak} at once under a cap of 1`)
        assert.equal(poster.seen.peak, 2, `poster ran ${poster.seen.peak} at once under a cap of 2`)
        video.release(); poster.release()
        await within(Promise.all(all), 'both to drain')
    })

    it('releases the slot when a task throws', async () => {
        // The failure that turns a cap into a deadlock: a task that throws
        // while holding the slot and never gives it back. The dispatcher
        // would then stop rendering that key for the rest of the build.
        let started = 0
        const task = async () => {
            started++
            await new Promise(resolve => setImmediate(resolve))
            throw new Error('ffmpeg exited 1')
        }
        const results = await within(
            Promise.allSettled(Array.from({ length: 3 }, () => withGate('video', 1, task))),
            'three failing tasks to finish')
        assert.equal(started, 3, 'a throw held the slot and blocked the ones behind it')
        assert.ok(results.every(r => r.status === 'rejected'), 'the failures must still surface')
    })

    it('ignores a cap that is not a positive whole number', async () => {
        for (const limit of [0, -1, 1.5, '2', null, undefined, true]) {
            resetGates()
            const { seen, task, release } = holding()
            const all = Array.from({ length: 4 }, () => withGate('video', limit, task))
            await within((async () => { while (seen.active < 4) await new Promise(r => setTimeout(r, 5)) })(),
                `all four to run under limit ${JSON.stringify(limit)}`)
            assert.equal(seen.peak, 4, `limit ${JSON.stringify(limit)} must not gate`)
            release()
            await within(Promise.all(all), 'them to finish')
        }
    })

    it('re-checks after being woken, instead of assuming the freed slot is free', async () => {
        // Waking a waiter means a slot WAS free, not that it still is. A
        // caller arriving in the microtask window between the release and the
        // waiter resuming takes it first, and a waiter that does not look
        // again puts the gate one over its limit — which for an external
        // process is one more than the machine was sized for.
        const seen = { active: 0, peak: 0 }
        const hold = (until) => async () => {
            seen.active++
            seen.peak = Math.max(seen.peak, seen.active)
            await until
            seen.active--
        }
        let releaseFirst, releaseRest
        const first = new Promise(resolve => { releaseFirst = resolve })
        const rest = new Promise(resolve => { releaseRest = resolve })

        const running = [withGate('video', 1, hold(first))]
        await Promise.resolve()
        running.push(withGate('video', 1, hold(rest)))

        releaseFirst()
        // Walk the microtask queue forward one turn at a time, starting a
        // fresh caller at each step. One of those steps is the window
        // between the waiter being woken and the waiter resuming.
        for (let turn = 0; turn < 6; turn++) {
            await Promise.resolve()
            running.push(withGate('video', 1, hold(rest)))
        }
        await Promise.resolve()

        assert.equal(seen.peak, 1, `${seen.peak} ran at once under a cap of 1`)
        releaseRest()
        await within(Promise.all(running), 'them to finish')
    })

    it('drains a queue much longer than the cap', async () => {
        const { seen, task, release } = holding()
        const all = Array.from({ length: 25 }, () => withGate('video', 3, task))
        await allArrived('video', 25)
        assert.equal(seen.peak, 3)
        release()
        await within(Promise.all(all), 'the queue to drain')
        assert.equal(seen.completed, 25)
        assert.equal(seen.peak, 3)
    })
})

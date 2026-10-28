// How many tasks carrying one key may be dispatched at once.
//
// The dispatcher is the only place that can answer this. A renderer that
// spawns an external process — ffmpeg, a headless browser, an image pipeline
// — needs a cap on how many of itself run, and it cannot hold that cap
// itself: under WORKER dispatch its code runs in a worker, so a counter it
// keeps is per thread and the limit comes out multiplied by the pool size.
// Held here, around the dispatch and before INLINE/SERIAL/WORKER is chosen,
// one counter on one thread bounds every mode.
//
// That is what a cap used to cost. mikser-io-assets pinned every preset
// declaring `concurrency` to INLINE so its own counter would be the only one
// — which made a capped, CPU-bound preset impossible to run in parallel at
// all. A site drawing image marks on a 24-core box worked around it by
// building a worker pool inside the preset by hand.
//
// KEYED, not global. Two presets each capped at one must still run beside
// each other; a shared counter would serialise unrelated work and read as a
// mysteriously slow build.
//
// What this deliberately does NOT do is free the outer slot. A task waiting
// here still occupies one of the `threads` the cycle dispatches with, so a
// build whose work is mostly capped can have every slot held by waiters. The
// alternative — returning the task to the queue and picking it up later —
// reorders renders and makes a cycle's dispatch order depend on contention,
// which is a much larger change than the problem justifies. Size `threads`
// and the cap together.
const gates = new Map()

function gateFor(key, limit) {
    const existing = gates.get(key)
    // A changed limit replaces the gate; tasks already through the old one
    // decrement the counter they incremented.
    if (existing && existing.limit === limit) return existing
    const gate = { limit, active: 0, waiting: [] }
    gates.set(key, gate)
    return gate
}

// Exported for tests, which need a clean slate between cases.
export function resetGates() {
    gates.clear()
}

// How many are running and how many are queued, for a test that needs to wait
// until every task has ARRIVED before reading a peak. Without it a test waits
// a fixed number of turns, which is a race that passes on a quiet machine.
export function gateState(key) {
    const gate = gates.get(key)
    return { active: gate?.active ?? 0, waiting: gate?.waiting.length ?? 0 }
}

/**
 * Run `task` with at most `limit` others sharing `key` in flight.
 *
 * An absent key or a limit that is not a positive whole number means no gate
 * at all — the overwhelmingly common case, and it costs one comparison.
 */
export async function withGate(key, limit, task) {
    if (!key || !Number.isInteger(limit) || limit < 1) return await task()
    const gate = gateFor(key, limit)
    // A LOOP, not a single await. Waking a waiter means a slot WAS free, not
    // that it still is: a caller arriving in the microtask window between the
    // release and the waiter resuming takes it first, and a waiter that
    // assumed otherwise would put the gate one over its limit — which for an
    // external process is one more than the machine was sized for.
    while (gate.active >= gate.limit) {
        await new Promise(resolve => gate.waiting.push(resolve))
    }
    gate.active++
    try {
        return await task()
    } finally {
        gate.active--
        gate.waiting.shift()?.()
    }
}

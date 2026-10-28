// The worker pools follow the resolved render width.
//
// They are built in `setup()`, which runs before the site config is loaded,
// so a `threads` key could not have reached them however it was resolved —
// the pools stayed at 4 while the inline dispatcher, which re-reads
// `runtime.options.threads` every cycle, moved. A site that raised the width
// got a wider inline dispatcher and the same four worker threads, which is
// the half of the problem that is invisible.
//
// Piscina's `maxThreads` is read-only, so the width changes by replacing the
// pools. That is free where it happens: `minThreads: 0` means an untouched
// pool has spawned no threads, and the resize runs at onLoad, before any
// cycle has dispatched.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { createWorkerPools, resizeWorkerPools } from '../../src/engine/workers.js'

describe('resizing the worker pools', () => {
    let saved
    before(() => { saved = runtime.engine })
    after(async () => {
        await Promise.all([runtime.engine?.renderWorkers, runtime.engine?.postprocessWorkers]
            .map(pool => pool?.destroy?.().catch(() => {})))
        runtime.engine = saved
    })
    beforeEach(async () => {
        await Promise.all([runtime.engine?.renderWorkers, runtime.engine?.postprocessWorkers]
            .map(pool => pool?.destroy?.().catch(() => {})))
        runtime.engine = { ...createWorkerPools(4) }
    })

    it('builds both pools to the width it is given', () => {
        assert.equal(runtime.engine.renderWorkers.options.maxThreads, 4)
        assert.equal(runtime.engine.postprocessWorkers.options.maxThreads, 4)
    })

    it('moves BOTH pools, not just the render one', async () => {
        assert.equal(await resizeWorkerPools(12), true)
        assert.equal(runtime.engine.renderWorkers.options.maxThreads, 12)
        assert.equal(runtime.engine.postprocessWorkers.options.maxThreads, 12,
            'postprocess dispatch is sized by the same number and was left behind')
    })

    it('does nothing when the width is already right', async () => {
        const before = runtime.engine.renderWorkers
        assert.equal(await resizeWorkerPools(4), false)
        assert.equal(runtime.engine.renderWorkers, before, 'replaced a pool for no reason')
    })

    it('narrows as well as widens', async () => {
        // `--threads 1` is the documented answer to a memory-bound build, so
        // it has to reach the pools too.
        await resizeWorkerPools(1)
        assert.equal(runtime.engine.renderWorkers.options.maxThreads, 1)
    })

    it('leaves a usable pool behind, not a destroyed one', async () => {
        // The swap happens before the old pools are torn down; getting that
        // order wrong hands dispatch a pool that is closing.
        await resizeWorkerPools(3)
        assert.equal(runtime.engine.renderWorkers.destroyed ?? false, false)
        assert.equal(typeof runtime.engine.renderWorkers.run, 'function')
    })
})

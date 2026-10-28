// How wide a build renders.
//
// One number sizes the inline render dispatcher, the inline postprocess
// dispatcher and both Piscina pools. It was hardcoded to 4: `setup()` read it
// from its own argument, which `app.js` never passes, and there was no flag
// and no config key. A 24-core container could keep four renders in flight
// with nothing able to say otherwise — and nothing saying so either, because
// a wide machine rendering four at a time looks exactly like a slow site.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveThreads, DEFAULT_THREADS } from '../../src/engine/threads.js'

describe('resolving the render width', () => {
    it('defaults to 4, and says that is where it came from', () => {
        // Wide-by-default is dangerous for a renderer that spawns external
        // processes, and worse than useless for a memory-bound build. The
        // default moving is a decision, not a tidy-up.
        assert.deepEqual(resolveThreads(), { threads: 4, source: 'default' })
        assert.equal(DEFAULT_THREADS, 4)
        assert.deepEqual(resolveThreads({}), { threads: 4, source: 'default' })
    })

    it('takes the config key', () => {
        assert.deepEqual(resolveThreads({ config: 12 }), { threads: 12, source: 'config' })
    })

    it('takes the CLI flag, as the string commander hands over', () => {
        assert.deepEqual(resolveThreads({ cli: '6' }), { threads: 6, source: 'cli' })
        assert.deepEqual(resolveThreads({ cli: 6 }), { threads: 6, source: 'cli' })
    })

    it('puts the CLI over the config', () => {
        assert.deepEqual(resolveThreads({ cli: '2', config: 16 }), { threads: 2, source: 'cli' })
    })

    it('reads a CLI value equal to the default as a CLI value', () => {
        // The reason the flag is declared with no default: `--threads 4` and
        // no flag at all must stay distinguishable, or the precedence has
        // nothing to stand on.
        assert.deepEqual(resolveThreads({ cli: '4', config: 16 }), { threads: 4, source: 'cli' })
    })

    it('ignores an absent value rather than treating it as zero', () => {
        assert.deepEqual(resolveThreads({ cli: undefined, config: 8 }), { threads: 8, source: 'config' })
        assert.deepEqual(resolveThreads({ cli: null, config: 8 }), { threads: 8, source: 'config' })
        assert.deepEqual(resolveThreads({ config: null }), { threads: 4, source: 'default' })
    })

    describe('refusing a value that is not a positive whole number', () => {
        // Each of these silently becomes something through Number(): '' and
        // false become 0, true becomes 1, '4.5' stays fractional. A build
        // that quietly renders one at a time, or a p-map given 0, is worse
        // than a build that will not start.
        for (const bad of [0, -1, -4, 1.5, '4.5', '', ' ', 'four', NaN, Infinity, true, false, [], {}]) {
            it(`refuses ${JSON.stringify(bad) ?? String(bad)}`, () => {
                assert.throws(() => resolveThreads({ cli: bad }), /--threads must be a positive whole number/)
                assert.throws(() => resolveThreads({ config: bad }), /config\.threads must be a positive whole number/)
            })
        }
    })

    it('names the source in the refusal, so the reader knows where to look', () => {
        assert.throws(() => resolveThreads({ cli: 'x' }), /--threads/)
        assert.throws(() => resolveThreads({ config: 'x' }), /config\.threads/)
    })
})

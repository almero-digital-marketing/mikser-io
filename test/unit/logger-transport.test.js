// Unit tests for addLogTransport — the plugin-side log-transport
// surface. Covers:
//
//   - Queue behavior when no logger is built yet (factory-phase
//     registrations land in pendingTransports and get drained when
//     createMikserLogger eventually runs).
//   - Live-rebuild behavior when the logger already exists (plugins
//     adding a transport at onLoaded or later swap
//     runtime.engine.logger with a fresh multistream-backed instance).
//   - Graceful failure: a transport whose target package can't be
//     resolved returns false and DOES NOT corrupt the logger state.
//
// We use a fake transport target — `target: '__definitely-not-installed-target'`
// — to force the pino.transport() construction path to throw, which
// keeps the test hermetic (no real workers spawned, no real network).

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { addLogTransport, createMikserLogger } from '../../src/logger.js'
import runtime from '../../src/runtime.js'

describe('addLogTransport', () => {
    let priorEngine
    let priorConfig
    beforeEach(() => {
        priorEngine = runtime.engine
        priorConfig = runtime.config
        runtime.engine = null         // simulate "before bootstrap logger created"
        runtime.config = undefined
    })
    afterEach(() => {
        runtime.engine = priorEngine
        runtime.config = priorConfig
    })

    it('queues entries when the logger has not been built yet', () => {
        // With no logger built (currentStreams === null), the call
        // queues silently. Return true means "accepted".
        const result = addLogTransport({
            target: '__definitely-not-installed-target',
            options: {},
        })
        assert.equal(result, true)
        // We can't directly inspect pendingTransports from here, but
        // the next createMikserLogger() invocation should attempt to
        // build that entry. The build will fail (target not resolvable)
        // and surface to stderr — fine for the test, but it would
        // have failed BEFORE this fix if the entry had been silently
        // dropped or hard-thrown.
    })

    it('drains the pending queue when createMikserLogger runs', () => {
        addLogTransport({
            target: '__queued-target-A',
            options: {},
        })
        addLogTransport({
            target: '__queued-target-B',
            options: {},
        })
        // createMikserLogger will try to construct both transports; both
        // will fail (synthetic target names). The important thing is
        // that the call doesn't throw and the returned logger is still
        // functional — the terminal pretty stream is independent.
        const logger = createMikserLogger('info')
        assert.equal(typeof logger.info, 'function')
        assert.equal(typeof logger.debug, 'function')
        // Subsequent addLogTransport calls now run the live-rebuild
        // path; the queue must have been drained.
        assert.equal(addLogTransport({ target: '__test-after-build', options: {} }), false)
        // false = build-failed (target not resolvable). True would have
        // meant "queued for later", indicating the drain didn't happen.
    })

    it('returns false when a transport stream fails to build (live path)', () => {
        runtime.engine = { logger: createMikserLogger('info') }
        const result = addLogTransport({
            target: '__nonexistent-pino-transport-package',
            options: {},
        })
        assert.equal(result, false)
        // Live logger must still work after a failed transport addition.
        assert.equal(typeof runtime.engine.logger.info, 'function')
    })

    it('keeps the existing logger functional after a failed live add', () => {
        runtime.engine = { logger: createMikserLogger('info') }
        const before = runtime.engine.logger
        addLogTransport({
            target: '__nonexistent-pino-transport-package',
            options: {},
        })
        // Failed adds must not swap in a broken logger instance.
        assert.equal(runtime.engine.logger, before)
        assert.equal(typeof runtime.engine.logger.info, 'function')
    })
})

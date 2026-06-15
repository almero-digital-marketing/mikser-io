// Contract tests for runtime.validate + onValidate.
//
// The load-bearing invariant: a validator ABSTAINS by returning
// undefined (it doesn't care about this entry's operation) and that
// MUST pass. Only an explicit `false` rejects. The old truthiness
// check treated abstain as rejection, so any validator scoped to a
// subset of operations — onValidate([CREATE, UPDATE]) is the common
// case — silently dropped every entry it never opted into, DELETEs
// most visibly.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { onValidate } from '../../src/lifecycle.js'
import { OPERATION } from '../../src/constants.js'

// onValidate grabs a logger at registration and on the warn/error
// paths. Stub it so those paths don't throw in isolation.
function stubLogger() {
    const calls = { warn: [], error: [] }
    runtime.engine = {
        logger: {
            warn:  (...a) => calls.warn.push(a),
            error: (...a) => calls.error.push(a),
        },
    }
    return calls
}

const entry = (operation) => ({ operation, entity: { id: '/x', name: 'x' } })

describe('runtime.validate contract', () => {
    beforeEach(() => {
        runtime.validators = []
        stubLogger()
    })

    it('passes when there are no validators', async () => {
        assert.equal(await runtime.validate(entry(OPERATION.CREATE)), true)
    })

    it('abstain (undefined return) passes — does not reject', async () => {
        runtime.validators.push(async () => undefined)
        assert.equal(await runtime.validate(entry(OPERATION.DELETE)), true)
    })

    it('only an explicit false rejects', async () => {
        runtime.validators.push(async () => false)
        assert.equal(await runtime.validate(entry(OPERATION.CREATE)), false)
    })

    it('a truthy non-true return still passes (abstain-is-pass, only false fails)', async () => {
        // A validator returning a message-like truthy value is NOT a
        // rejection signal at the runtime layer — only `=== false` is.
        runtime.validators.push(async () => 'some note')
        assert.equal(await runtime.validate(entry(OPERATION.UPDATE)), true)
    })

    it('the regression: a subset-scoped onValidate does NOT drop other operations', async () => {
        // This is the exact shape that was silently broken: a plugin
        // (schemas) validating CREATE/UPDATE caused DELETEs to vanish.
        let createUpdateSeen = 0
        onValidate([OPERATION.CREATE, OPERATION.UPDATE], async () => {
            createUpdateSeen++
            return                       // clean — no validation problem
        })

        // DELETE is out of scope → must pass untouched, callback never runs.
        assert.equal(await runtime.validate(entry(OPERATION.DELETE)), true)
        assert.equal(createUpdateSeen, 0, 'callback must not fire for out-of-scope ops')

        // CREATE is in scope → callback runs, still passes (no problem returned).
        assert.equal(await runtime.validate(entry(OPERATION.CREATE)), true)
        assert.equal(createUpdateSeen, 1)
    })

    it('onValidate: a thrown callback rejects only the in-scope operation', async () => {
        onValidate([OPERATION.CREATE], async () => { throw new Error('bad shape') })

        // In scope + throws → rejected.
        assert.equal(await runtime.validate(entry(OPERATION.CREATE)), false)
        // Out of scope → abstains → passes, throw never reached.
        assert.equal(await runtime.validate(entry(OPERATION.DELETE)), true)
    })

    it('two disjoint validators do not interfere', async () => {
        // Validator A cares about CREATE, validator B about DELETE.
        // An UPDATE is out of scope for both → passes. A CREATE that B
        // abstains on still passes if A is happy.
        const seen = []
        onValidate([OPERATION.CREATE], async () => { seen.push('A') })
        onValidate([OPERATION.DELETE], async () => { seen.push('B') })

        assert.equal(await runtime.validate(entry(OPERATION.UPDATE)), true)
        assert.deepEqual(seen, [], 'neither validator fires for UPDATE')

        assert.equal(await runtime.validate(entry(OPERATION.CREATE)), true)
        assert.deepEqual(seen, ['A'], 'only A fires for CREATE')
    })
})

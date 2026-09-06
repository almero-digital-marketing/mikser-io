// `*` grants everything, and it does so in ONE place.
//
// It was already being written in grants — a role configured `['*']` meaning
// "everything" — and matched nothing, because every gate was an exact
// `includes`. The shape that produced was worse than a plain refusal: the role
// could use api and mcp, which declare no capability and so pass the
// unscoped check, and could not open the drive, which declares one. Its own
// summary said it had everything. Its printed reach was empty. Nothing
// disagreed with anything loudly enough to be noticed.
//
// The reason this file also tests the SHAPE — that the gates route through
// hasCapability rather than re-deriving the rule — is that four of the five
// capability checks in the tree bypassed it. A wildcard added to the shared
// function alone would have worked on two surfaces out of four, which is the
// same bug one layer down.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { hasCapability, CAPABILITY_WILDCARD } from '../../index.js'
import { reachOf, rolesIn, explainRefusal } from '../../src/roles.js'

const principal = (capabilities) => ({ subject: 'x', capabilities })

describe('the capability wildcard', () => {
    it('grants a capability the principal does not name', () => {
        assert.equal(hasCapability(principal(['*']), 'drive:documents'), true)
        assert.equal(hasCapability(principal(['*']), 'api:update'), true)
    })

    it('does not turn an unrelated capability into a wildcard', () => {
        assert.equal(hasCapability(principal(['drive:layouts']), 'drive:documents'), false)
        assert.equal(hasCapability(principal([]), 'drive:documents'), false)
    })

    it('leaves the unscoped credential alone', () => {
        // `capabilities: null` is "not capability-scoped" — a bare static
        // token — and already passed everything. That is a different rule and
        // must stay a different rule.
        assert.equal(hasCapability(principal(null), 'drive:documents'), true)
    })

    it('is exported, so a plugin can ask instead of guessing at a string', () => {
        assert.equal(CAPABILITY_WILDCARD, '*')
    })
})

describe('a wildcard role describes itself honestly', () => {
    const catalogue = {
        editors:    ['drive:documents', 'drive:documents:write'],
        developers: ['drive:documents', 'drive:layouts', 'drive:layouts:write'],
        admins:     ['*'],
    }

    it('reports the reach it actually has, not an empty list', () => {
        // Measured on a live deployment: a role summarised as "everything"
        // printed `writable: []` and `readOnly: []`, which reads as "can do
        // nothing" and is how the inert grant was found.
        const admins = rolesIn(catalogue, { acting: 'admins' }).find(r => r.name === 'admins')
        assert.deepEqual(admins.writable.map(r => r.name), ['documents', 'layouts'])
        assert.ok(!admins.also?.includes('*'),
            'the wildcard is expanded, not reported as an unexplained extra')
    })

    it('counts as a holder when someone else is refused', () => {
        const message = explainRefusal({ capability: 'drive:documents', role: 'editors', catalogue })
        assert.match(message, /admins/,
            'a role that can do everything can do this, and the person asking needs to know who to ask')
        assert.doesNotMatch(message, /No configured role carries it/)
    })

    it('expands to nothing in particular when the site defines nothing', () => {
        assert.deepEqual(reachOf(['*'], { universe: [] }).writable, [])
    })
})

describe('every gate routes through the one function', () => {
    // The bypasses are the bug. Asserted on the source because the alternative
    // is a live server per surface, and because what must not come back is the
    // SHAPE: a second place that decides what a capability means.
    const gatesIn = async (path) => {
        const text = await readFile(new URL(path, import.meta.url), 'utf8')
        return text.split('\n')
            .filter(l => /capabilities[^\n]{0,40}\.includes\(/.test(l))
            .filter(l => !l.includes('CAPABILITY_WILDCARD'))   // roles.js's own holder scan
    }

    it('has no capability check in the engine that re-derives the rule', async () => {
        for (const file of ['../../src/auth.js', '../../src/plugins/api.js']) {
            assert.deepEqual(await gatesIn(file), [], `${file} should ask hasCapability`)
        }
    })
})

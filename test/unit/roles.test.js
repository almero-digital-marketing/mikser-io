// A session must be able to say which role it holds.
//
// Enforcement needs only the flat capability list. Explaining a refusal needs
// the role, and without it an admin token and a site with no roles configured
// are indistinguishable from inside — so an agent reports "I got a 403"
// instead of a sentence the end user can forward.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { reachOf, actingRole, otherRoles, describeAuthority, explainRefusal } from '../../src/roles.js'

// lmed's real shape: widening tiers built by readWrite(...).
const rw = (...names) => names.flatMap(n => [`drive:${n}`, `drive:${n}:write`])
const CATALOGUE = {
    editors: rw('documents', 'media'),
    developers: rw('documents', 'media', 'files', 'layouts', 'styles', 'scripts'),
    admins: [...rw('documents', 'media', 'files', 'layouts', 'styles', 'scripts'), 'mcp:use', 'api:list'],
}
const SUMMARIES = {
    editors: 'Content and the media that goes with it, not the code that renders it.',
    developers: 'Everything an editor has, plus the templates, styles and scripts.',
    admins: 'Every endpoint, plus the administrative surfaces.',
}

describe('what a capability list means', () => {
    it('separates what can be changed from what can only be read', () => {
        const reach = reachOf(['drive:documents', 'drive:documents:write', 'drive:layouts'])
        assert.deepEqual(reach.writable, ['documents'])
        assert.deepEqual(reach.readOnly, ['layouts'], 'readOnly is what makes a refusal explainable')
    })

    it('ignores capabilities that name no collection', () => {
        assert.deepEqual(reachOf(['mcp:use', 'api:list']), { writable: [], readOnly: [] })
    })
})

describe('which role is acting', () => {
    it('names the one when there is one', () => {
        assert.equal(actingRole(['editors'], CATALOGUE), 'editors')
    })

    it('names the widest when several are held', () => {
        // Roles are written as widening tiers, so one usually covers the rest.
        assert.equal(actingRole(['editors', 'developers'], CATALOGUE), 'developers')
    })

    it('names none rather than picking arbitrarily when none dominates', () => {
        // The acting authority genuinely is the union here. Naming one half
        // of it would be a lie in the sentence an agent repeats.
        const split = { a: ['drive:documents:write'], b: ['drive:media:write'] }
        assert.equal(actingRole(['a', 'b'], split), null)
    })

    it('ignores a group with no capabilities configured for it', () => {
        assert.equal(actingRole(['editors', 'some-unmapped-group'], CATALOGUE), 'editors')
    })
})

describe('who to ask', () => {
    it('names the roles that add something, and what', () => {
        const others = otherRoles(['editors'], CATALOGUE, SUMMARIES)
        const developers = others.find(r => r.name === 'developers')
        assert.deepEqual(developers.adds, ['files', 'layouts', 'scripts', 'styles'],
            'expressed as collections, which is what a person asking can act on')
        assert.equal(developers.summary, SUMMARIES.developers)
    })

    it('omits a role that adds nothing — there is nobody to ask', () => {
        assert.deepEqual(otherRoles(['admins'], CATALOGUE, SUMMARIES), [])
    })
})

describe('what ping reports', () => {
    it('reports an editor as editors, writing documents and media', () => {
        const a = describeAuthority({ capabilities: CATALOGUE.editors, roles: ['editors'], catalogue: CATALOGUE, summaries: SUMMARIES })
        assert.equal(a.role, 'editors')
        assert.deepEqual(a.writable, ['documents', 'media'])
        assert.equal(a.roleSummary, SUMMARIES.editors)
        assert.ok(a.otherRoles.some(r => r.name === 'developers'), 'and names who carries the rest')
    })

    it('reports an admin with nothing it cannot write', () => {
        const a = describeAuthority({ capabilities: CATALOGUE.admins, roles: ['admins'], catalogue: CATALOGUE, summaries: SUMMARIES })
        assert.equal(a.role, 'admins')
        assert.deepEqual(a.readOnly, [])
        assert.deepEqual(a.otherRoles, [])
    })

    it('says so plainly when no roles are configured at all', () => {
        // A credential that is not capability-scoped. Reporting a role here
        // would invent one.
        const a = describeAuthority({ capabilities: null, roles: [], catalogue: {}, summaries: {} })
        assert.equal(a.role, null)
        assert.equal(a.writable, null)
        assert.match(a.roleSummary, /no roles configured/)
    })
})

describe('the refusal an agent repeats', () => {
    it('names the role, the missing capability and who has it', () => {
        const message = explainRefusal({
            capability: 'drive:styles:write', role: 'editors',
            target: 'styles/tokens/buttons.css', catalogue: CATALOGUE, summaries: SUMMARIES,
        })
        assert.match(message, /Connected as editors/)
        assert.match(message, /drive:styles:write/)
        assert.match(message, /developers/, 'and names who to ask')
        assert.match(message, /styles\/tokens\/buttons\.css/)
        assert.doesNotMatch(message, /\.\./, 'no doubled full stop where a summary already ended one')
    })

    it('never suggests obtaining a role, retrying or working around it', () => {
        // The whole point is a handoff to a person. A sentence that hints at
        // escalation invites an agent to look for a way round the refusal.
        const message = explainRefusal({
            capability: 'drive:layouts:write', role: 'editors', catalogue: CATALOGUE, summaries: SUMMARIES,
        })
        for (const forbidden of [/request .*role/i, /escalat/i, /try again/i, /retry/i, /elevate/i, /grant yourself/i]) {
            assert.doesNotMatch(message, forbidden)
        }
        assert.match(message, /Ask whoever set the site up/)
    })

    it('still answers when no role carries the capability', () => {
        const message = explainRefusal({ capability: 'drive:secret:write', role: 'editors', catalogue: CATALOGUE })
        assert.match(message, /No configured role carries it/)
    })
})

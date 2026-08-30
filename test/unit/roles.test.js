// A session must be able to say which role it holds.
//
// Enforcement needs only the flat capability list. Explaining a refusal needs
// the role, and without it an admin token and a site with no roles configured
// are indistinguishable from inside — so an agent reports "I got a 403"
// instead of a sentence the end user can forward.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
    reachOf, actingRole, rolesIn, describeAuthority, explainRefusal, registerCapability,
} from '../../src/roles.js'

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
        assert.deepEqual(reach.writable.map(r => r.name), ['documents'])
        assert.deepEqual(reach.readOnly.map(r => r.name), ['layouts'],
            'readOnly is what makes a refusal explainable')
    })

    it('keeps a capability no plugin has explained, rather than dropping it', () => {
        // A role described only by the part of it that maps to folders is not
        // described. These belong in `also`, not nowhere.
        const reach = reachOf(['mcp:use', 'api:list'])
        assert.deepEqual(reach.writable, [])
        assert.deepEqual(reach.readOnly, [])
        assert.deepEqual(reach.also, ['api:list', 'mcp:use'])
    })

    it('carries the folder and purpose a plugin declared', () => {
        // The point of the registry: core cannot know where `documents` lives
        // or what it is for, and an agent reasoning about the site needs both.
        registerCapability('drive:brochures', {
            plugin: 'drive',
            grants: 'read',
            resource: { kind: 'collection', name: 'brochures', folder: 'files/brochures',
                        summary: 'PDFs offered for download' },
        })
        const [resource] = reachOf(['drive:brochures']).readOnly
        assert.equal(resource.folder, 'files/brochures')
        assert.equal(resource.summary, 'PDFs offered for download')
    })

    it('still understands the drive convention when nothing declared it', () => {
        // A deployment whose plugins predate the registry must keep its
        // answer rather than reporting every collection as an opaque string.
        const reach = reachOf(['drive:undeclared', 'drive:undeclared:write'])
        assert.deepEqual(reach.writable.map(r => r.name), ['undeclared'])
        assert.deepEqual(reach.also, [])
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

describe('the role listing', () => {
    it('describes every role, not only the ones that add something', () => {
        // One field has to serve both readers: someone deciding who to ask,
        // and someone with the widest role trying to see what exists at all.
        const listed = rolesIn(CATALOGUE, { acting: 'admins', summaries: SUMMARIES })
        assert.deepEqual(listed.map(r => r.name), ['editors', 'developers', 'admins'])
    })

    it('marks which one is acting', () => {
        const listed = rolesIn(CATALOGUE, { acting: 'editors' })
        assert.equal(listed.find(r => r.name === 'editors').acting, true)
        assert.equal(listed.find(r => r.name === 'admins').acting, undefined,
            'only the acting one is marked, so the flag means something')
    })

    it('says what each role can reach', () => {
        const editors = rolesIn(CATALOGUE).find(r => r.name === 'editors')
        assert.deepEqual(editors.writable.map(r => r.name), ['documents', 'media'])
    })

    it('keeps capabilities that name no collection, so a role is described in full', () => {
        const admins = rolesIn(CATALOGUE).find(r => r.name === 'admins')
        assert.ok(admins.also.includes('mcp:use'), 'an api or mcp verb is part of what a role is')
        assert.ok(!admins.also.some(c => c.startsWith('drive:')), 'and collections are not repeated there')
    })
})

describe('what ping reports', () => {
    it('reports an editor as editors, writing documents and media', () => {
        const a = describeAuthority({ capabilities: CATALOGUE.editors, roles: ['editors'], catalogue: CATALOGUE, summaries: SUMMARIES })
        assert.equal(a.role, 'editors')
        assert.deepEqual(a.writable.map(r => r.name), ['documents', 'media'])
        assert.equal(a.roleSummary, SUMMARIES.editors)
        const developers = a.roles.find(r => r.name === 'developers')
        assert.ok(developers.writable.some(r => r.name === 'layouts'), 'and shows who carries the rest')
    })

    it('reports an admin with nothing it cannot write', () => {
        const a = describeAuthority({ capabilities: CATALOGUE.admins, roles: ['admins'], catalogue: CATALOGUE, summaries: SUMMARIES })
        assert.equal(a.role, 'admins')
        assert.deepEqual(a.readOnly, [])
        // The friction that prompted this: a "roles you lack" field is empty
        // for an admin, who then cannot see that any other role exists.
        assert.deepEqual(a.roles.map(r => r.name), ['editors', 'developers', 'admins'])
        assert.equal(a.roles.find(r => r.name === 'admins').acting, true)
    })

    it('says so plainly when no roles are configured at all', () => {
        // A credential that is not capability-scoped. Reporting a role here
        // would invent one.
        const a = describeAuthority({ capabilities: null, roles: [], catalogue: {}, summaries: {} })
        assert.equal(a.role, null)
        assert.equal(a.writable, null)
        assert.deepEqual(a.roles, [])
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

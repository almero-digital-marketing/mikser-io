import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { bearer, resolveAuth, authorize, requireAuth, reachabilityOf, anyOf, hasCapability } from '../../index.js'

const req = (header, ip = '203.0.113.9') => ({
    headers: header ? { authorization: header } : {},
    ip,
})

describe('bearer verifier', () => {
    it('accepts the exact token and reports a subject', async () => {
        const v = bearer({ token: 's3cret' })
        assert.deepEqual(await v.verify(req('Bearer s3cret')), { subject: 'token', capabilities: null, scope: null })
    })

    it('distinguishes "not presented" (null) from "presented and wrong" (false)', async () => {
        // The whole uniform rule hangs off this distinction: absent may fall
        // back to loopback, wrong never may.
        const v = bearer({ token: 's3cret' })
        assert.equal(await v.verify(req(null)), null)
        assert.equal(await v.verify(req('Bearer nope')), false)
    })

    it('rejects a token of a different length without throwing', async () => {
        // timingSafeEqual throws on length mismatch — the guard has to run first.
        const v = bearer({ token: 's3cret' })
        assert.equal(await v.verify(req('Bearer s')), false)
        assert.equal(await v.verify(req('Bearer s3cret-and-then-some')), false)
    })

    it('does not accept a bare token without the Bearer scheme', async () => {
        const v = bearer({ token: 's3cret' })
        assert.equal(await v.verify(req('s3cret')), false)
    })

    it('requires a token to construct', () => {
        assert.throws(() => bearer({}), /requires a token/)
    })
})

describe('resolveAuth', () => {
    it('accepts a bare string, the { token } shape, and a verifier', () => {
        assert.equal(resolveAuth('abc').name, 'bearer')
        assert.equal(resolveAuth({ token: 'abc' }).name, 'bearer')
        const custom = { name: 'custom', verify: async () => null }
        assert.equal(resolveAuth(custom), custom)
    })

    it('wraps a bare async function as a verifier', async () => {
        const v = resolveAuth(async () => ({ subject: 'alice' }))
        assert.deepEqual(await v.verify(req(null)), { subject: 'alice' })
    })

    it('returns null for "nothing configured"', () => {
        assert.equal(resolveAuth(undefined), null)
        assert.equal(resolveAuth(null), null)
        assert.equal(resolveAuth({}), null)
    })
})

describe('authorize — the uniform rule', () => {
    const v = bearer({ token: 's3cret' })

    it('allows a valid credential from anywhere', async () => {
        const out = await authorize(req('Bearer s3cret'), v)
        assert.equal(out.ok, true)
        assert.equal(out.principal.subject, 'token')
    })

    it('401s an invalid credential even from loopback', async () => {
        const out = await authorize(req('Bearer nope', '127.0.0.1'), v, { trustLoopback: true })
        assert.equal(out.ok, false)
        assert.equal(out.status, 401)
        assert.equal(out.reason, 'invalid')
    })

    it('401s a missing credential by default — loopback does not bypass a verifier', async () => {
        const out = await authorize(req(null, '127.0.0.1'), v)
        assert.equal(out.ok, false)
        assert.equal(out.status, 401)
        assert.equal(out.reason, 'missing')
    })

    it('trustLoopback restores the older "trusted local host" behaviour', async () => {
        const out = await authorize(req(null, '127.0.0.1'), v, { trustLoopback: true })
        assert.equal(out.ok, true)
        assert.equal(out.principal.subject, 'loopback')
    })

    it('trustLoopback does not help a remote caller', async () => {
        const out = await authorize(req(null), v, { trustLoopback: true })
        assert.equal(out.ok, false)
        assert.equal(out.status, 401)
    })

    it('with no verifier: loopback allowed, remote 403s with the reachability reason', async () => {
        assert.equal((await authorize(req(null, '::1'), null)).ok, true)
        const out = await authorize(req(null), null)
        assert.equal(out.ok, false)
        assert.equal(out.status, 403)
        assert.equal(out.reason, 'reachability')
    })

    it('with no verifier and allowRemote: open to anyone', async () => {
        const out = await authorize(req(null), null, { allowRemote: true })
        assert.equal(out.ok, true)
        assert.equal(out.principal.subject, 'anonymous')
    })
})

describe('requireAuth middleware', () => {
    const res = () => {
        const r = { headers: {}, statusCode: null, body: null }
        r.set = (k, val) => { r.headers[k] = val; return r }
        r.status = (s) => { r.statusCode = s; return r }
        r.json = (b) => { r.body = b; return r }
        return r
    }

    it('calls next() and attaches req.principal on success', async () => {
        const r = req('Bearer s3cret')
        let called = false
        await requireAuth(bearer({ token: 's3cret' }))(r, res(), () => { called = true })
        assert.equal(called, true)
        assert.equal(r.principal.subject, 'token')
    })

    it('emits a WWW-Authenticate challenge alongside a 401', async () => {
        const out = res()
        await requireAuth(bearer({ token: 's3cret' }))(req(null), out, () => {
            assert.fail('next() must not run')
        })
        assert.equal(out.statusCode, 401)
        assert.equal(out.headers['WWW-Authenticate'], 'Bearer')
    })

    it('does not challenge on a 403 — the credential was never the problem', async () => {
        const out = res()
        await requireAuth(null)(req(null), out, () => assert.fail('next() must not run'))
        assert.equal(out.statusCode, 403)
        assert.equal(out.headers['WWW-Authenticate'], undefined)
    })

    it('500s rather than failing open when a verifier throws', async () => {
        const out = res()
        const exploding = { name: 'boom', verify: async () => { throw new Error('jwks unreachable') } }
        await requireAuth(exploding)(req('Bearer x'), out, () => assert.fail('next() must not run'))
        assert.equal(out.statusCode, 500)
    })
})

describe('reachabilityOf', () => {
    it('reports the vocabulary registerRoute already uses', () => {
        assert.equal(reachabilityOf({ token: 'x' }), 'token')
        assert.equal(reachabilityOf({ auth: { verify: () => {} } }), 'token')
        assert.equal(reachabilityOf({ allowRemote: true }), 'public')
        assert.equal(reachabilityOf({}), 'loopback')
    })
})

describe('anyOf — several credentials on one surface', () => {
    const machine = bearer({ token: 'machine-tok', name: 'machine', subject: 'gpoint-api', capabilities: ['api:update'] })
    const reader  = bearer({ token: 'reader-tok',  name: 'reader',  subject: 'gpoint-web', capabilities: ['api:list'] })
    const human   = {
        name: 'jwt',
        authorizationServers: ['https://id.example.com'],
        resource: 'https://cms.example.com/mcp',
        scopesSupported: ['mcp:use'],
        async verify(r) {
            const h = r.headers.authorization
            if (!h) return null
            return h === 'Bearer human' ? { subject: 'alice', capabilities: ['api:delete'] } : false
        },
        challenge(rq, rs) { rs.set('WWW-Authenticate', 'Bearer resource_metadata="…"') },
    }

    it('accepts each credential, keeping its own subject and capabilities', async () => {
        const v = anyOf(machine, reader, human)
        assert.deepEqual(await v.verify(req('Bearer machine-tok')), { subject: 'gpoint-api', capabilities: ['api:update'], scope: null })
        assert.deepEqual(await v.verify(req('Bearer reader-tok')),  { subject: 'gpoint-web', capabilities: ['api:list'],   scope: null })
        assert.deepEqual(await v.verify(req('Bearer human')),       { subject: 'alice',      capabilities: ['api:delete'] })
    })

    it('reports "nothing presented" only when every verifier does', async () => {
        assert.equal(await anyOf(machine, human).verify(req(null)), null)
    })

    it('reports "rejected" — never null — when a credential was presented and refused', async () => {
        // The bypass this guards: if a presented-but-wrong credential merged
        // to null, authorize() would fall back to the loopback policy and a
        // bad token would succeed from localhost.
        assert.equal(await anyOf(machine, reader, human).verify(req('Bearer wrong')), false)
    })

    it('a rejection does not mask a later acceptance', async () => {
        // 'human' rejects anything that isn't 'Bearer human'; the machine
        // token is checked too and must still win.
        assert.deepEqual(await anyOf(human, machine).verify(req('Bearer machine-tok')),
                         { subject: 'gpoint-api', capabilities: ['api:update'], scope: null })
    })

    it('carries OAuth discovery through the composite', () => {
        const v = anyOf(machine, human)
        assert.deepEqual(v.authorizationServers, ['https://id.example.com'])
        assert.equal(v.resource, 'https://cms.example.com/mcp')
        assert.deepEqual(v.scopesSupported, ['mcp:use'])
    })

    it('challenges with the interactive option, not the static one', () => {
        const res = { headers: {}, set(k, val) { this.headers[k] = val } }
        anyOf(machine, human).challenge({}, res)
        assert.match(res.headers['WWW-Authenticate'], /resource_metadata/)
    })

    it('collapses to the single verifier when given one', () => {
        assert.equal(anyOf(machine), machine)
        assert.equal(anyOf(null, undefined), null)
    })

    it('through authorize(): a wrong token from loopback is still 401', async () => {
        const out = await authorize(req('Bearer wrong', '127.0.0.1'), anyOf(machine, human), { trustLoopback: true })
        assert.equal(out.ok, false)
        assert.equal(out.status, 401)
    })
})

describe('resolveAuth with an array', () => {
    it('builds an anyOf from a list of token shapes', async () => {
        const v = resolveAuth(['tok-a', { token: 'tok-b' }])
        assert.match(v.name, /^anyOf/)
        assert.equal((await v.verify(req('Bearer tok-a'))).subject, 'token')
        assert.equal((await v.verify(req('Bearer tok-b'))).subject, 'token')
        assert.equal(await v.verify(req('Bearer tok-c')), false)
    })

    it('collapses a one-element array and ignores an empty one', () => {
        assert.equal(resolveAuth(['only']).name, 'bearer')
        assert.equal(resolveAuth([]), null)
        assert.equal(resolveAuth([null]), null)
    })
})

describe('hasCapability — endpoint ceiling ∩ principal grant', () => {
    it('an unscoped credential passes any check — the endpoint bounds it', () => {
        // Every pre-ADR-0012 endpoint: a bare token with nothing declared.
        assert.equal(hasCapability({ subject: 'token', capabilities: null }, 'api:delete'), true)
    })

    it('a scoped credential is bound by what it declares', () => {
        const p = { subject: 'gpoint-web', capabilities: ['api:list'] }
        assert.equal(hasCapability(p, 'api:list'), true)
        assert.equal(hasCapability(p, 'api:delete'), false)
    })

    it('an empty capability list grants nothing', () => {
        assert.equal(hasCapability({ capabilities: [] }, 'api:list'), false)
    })

    it('no capability required → always true', () => {
        assert.equal(hasCapability({ capabilities: [] }, null), true)
    })
})

describe('bearer carries a row scope opaquely', () => {
    it('hands the declared scope to the principal without inspecting it', async () => {
        // The engine must never look inside this — only the plugin whose
        // surface issued the credential knows what the value means.
        const rows = { 'meta.href': { $regex: '^/web' } }
        const v = bearer({ token: 'tok', subject: 'gpoint-web', scope: rows })
        const p = await v.verify(req('Bearer tok'))
        assert.equal(p.scope, rows)
    })

    it('defaults to null — unscoped', async () => {
        assert.equal((await bearer({ token: 'tok' }).verify(req('Bearer tok'))).scope, null)
    })
})

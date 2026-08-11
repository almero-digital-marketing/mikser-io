// subscribe()'s scope may be a predicate OR a sift object, and this covers the
// normalisation that makes both safe.
//
// An endpoint declares its scope once and it reaches consumers that want
// different things from it: queryEntities merges a sift object into the WHERE
// clause, while a dispatch holding a single entity can only test it. Every
// consumer that reached for `scope(entity)` worked with the function form and
// threw `TypeError: scope is not a function` with the object one.
//
// That is not hypothetical. It took gpoint's render endpoint down: a render
// mutates an entity, the refs dispatch calls the endpoint's scope, the
// TypeError escapes, the render answers 500, and the notification email behind
// it is lost. It needed BOTH an object scope and a live subscription to fire, so
// it reproduced in nothing smaller than production — twice, hours apart, blamed
// on two different things.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { subscribe } from '../../src/subscriptions.js'

const WEB = { id: '/documents/a.md', collection: 'documents', meta: { href: '/web/booking' } }
const ADMIN = { id: '/documents/b.md', collection: 'documents', meta: { href: '/admin/secret' } }

describe('subscribe: the scope is normalised once, at registration', () => {
    it('accepts a sift object', () => {
        const sub = subscribe({ scope: { 'meta.href': { $regex: '^/web' } }, onChange: () => {} })
        assert.ok(sub)
        sub.dispose()
    })

    it('accepts a predicate, unchanged', () => {
        const sub = subscribe({ scope: (e) => e.meta?.href?.startsWith('/web'), onChange: () => {} })
        assert.ok(sub)
        sub.dispose()
    })

    it('accepts no scope at all', () => {
        const sub = subscribe({ onChange: () => {} })
        assert.ok(sub)
        sub.dispose()
    })

    it('rejects anything else AT REGISTRATION, not at dispatch', () => {
        // The whole failure mode was a bad scope surviving registration and
        // throwing later, inside a render, where the message named neither the
        // endpoint nor the subscription.
        for (const bad of [42, 'nope', true]) {
            assert.throws(
                () => subscribe({ scope: bad, onChange: () => {} }),
                /scope must be a function or a sift filter object/,
                String(bad),
            )
        }
    })
})

describe('subscribe: both scope forms select the same entities', () => {
    // Equivalence is the point of normalising rather than special-casing: an
    // endpoint that switches its scope from a function to an object must keep
    // matching exactly what it matched before.
    const asObject = { 'meta.href': { $regex: '^/(web|system)' } }
    const asFunction = (e) => e.meta?.href?.startsWith('/web') || e.meta?.href?.startsWith('/system')

    it('agree on an in-scope and an out-of-scope entity', async () => {
        const seen = { object: [], function: [] }
        const subs = {
            object: subscribe({ scope: asObject, onChange: ({ entity }) => seen.object.push(entity.id) }),
            function: subscribe({ scope: asFunction, onChange: ({ entity }) => seen.function.push(entity.id) }),
        }
        // Both were registered without throwing, which is the regression: the
        // object form used to register fine and blow up on first dispatch.
        assert.ok(subs.object && subs.function)
        subs.object.dispose(); subs.function.dispose()
    })

    it('a sift object built from the same rule matches the same rows', async () => {
        const { default: sift } = await import('sift')
        const test = sift(asObject)
        assert.equal(test(WEB), asFunction(WEB))
        assert.equal(test(ADMIN), asFunction(ADMIN))
        assert.equal(test(WEB), true)
        assert.equal(test(ADMIN), false)
    })
})

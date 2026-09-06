// Writing to a collection is scoped to that collection.
//
// Before this, the MCP write tools consulted no capability at all —
// mikser-io-mcp imported `explainRefusal` and never called it — so a role
// whose published reach said "layouts: read only" could rewrite a layout
// through mikser_update_entity. The role model was describing a rule one
// transport enforced.
//
// The check is here and asked from the surfaces, not reimplemented by them,
// because the two bugs that preceded it were both a plugin deciding for
// itself: a private `capabilities.includes` that missed the `*` wildcard, and
// a write gate that required half the pair the mount required.
//
// It is OFF until an operator grants a `write:` capability. Enforcing on
// upgrade would refuse every write on every existing deployment, since nobody
// holds a capability that did not exist. The first grant turns it on for every
// collection at once — surprising exactly once, and the only reading that does
// not leave a site half-enforced.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import { missingCollectionWrite, writeCapabilityFor } from '../../src/auth.js'
import { withPrincipal, currentPrincipal } from '../../src/principal.js'
import { useCollection } from '../../src/utils/index.js'

const scoped = { editors: ['write:documents'], admins: ['*'] }
const unscoped = { editors: ['drive:documents', 'drive:documents:write'] }
const holder = (capabilities) => ({ subject: 'u', capabilities })

describe('the rule', () => {
    it('names the capability a collection needs', () => {
        assert.equal(writeCapabilityFor('documents'), 'write:documents')
    })

    it('stays off until a site grants one', () => {
        // Every deployment that exists today is this case.
        assert.equal(missingCollectionWrite('documents',
            { principal: holder([]), catalogue: unscoped }), null)
    })

    it('bites once a site grants one', () => {
        assert.equal(missingCollectionWrite('layouts',
            { principal: holder(['write:documents']), catalogue: scoped }), 'write:layouts')
        assert.equal(missingCollectionWrite('documents',
            { principal: holder(['write:documents']), catalogue: scoped }), null)
    })

    it('honours the wildcard, like every other capability', () => {
        assert.equal(missingCollectionWrite('layouts',
            { principal: holder(['*']), catalogue: scoped }), null)
    })

    it('leaves a credential that carries no capabilities alone', () => {
        // A bare static token or a library caller. That is "not
        // capability-scoped", which is a different state from "scoped and
        // holds nothing", and it stays different.
        assert.equal(missingCollectionWrite('layouts',
            { principal: holder(null), catalogue: scoped }), null)
    })
})

describe('a principal is an object, never a label', () => {
    it('ignores the display string the change-set log carries', () => {
        // `writeEntitySource` takes a `principal` and MCP puts
        // "dk@almero.bg (admins)" there — built for the log. Asked about, a
        // string reads `undefined.capabilities`, takes the unscoped branch,
        // and returns true for everything: protection that protects nothing.
        withPrincipal('dk@almero.bg (admins)', () => {
            assert.equal(currentPrincipal(), null, 'a string is not an identity')
        })
    })

    it('carries an object for the length of the call', () => {
        withPrincipal(holder(['write:documents']), () => {
            assert.deepEqual(currentPrincipal().capabilities, ['write:documents'])
        })
        assert.equal(currentPrincipal(), null, 'and not beyond it')
    })
})

describe('the lowest write primitive refuses', () => {
    let dir, priorOptions
    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'mikser-cw-'))
        priorOptions = runtime.options
        runtime.options = {
            ...runtime.options,
            workingFolder: dir,
            // `<name>Folder` is what useCollection resolves against.
            documentsFolder: path.join(dir, 'documents'),
            layoutsFolder: path.join(dir, 'layouts'),
            roles: { catalogue: scoped },
        }
    })
    afterEach(async () => {
        runtime.options = priorOptions
        await rm(dir, { recursive: true, force: true })
    })

    const writeAs = (principal, collection, name) => withPrincipal(principal,
        () => useCollection(runtime, collection).write(name, 'x'))

    it('allows the collection the principal holds', async () => {
        await writeAs(holder(['write:documents']), 'documents', 'ok.md')
        assert.equal(await readFile(path.join(dir, 'documents', 'ok.md'), 'utf8'), 'x')
    })

    it('refuses one it does not, and names what is missing', async () => {
        await assert.rejects(
            () => writeAs(holder(['write:documents']), 'layouts', 'nope.liquid'),
            /needs write:layouts/)
    })

    it('throws rather than returning falsy', async () => {
        // `write` returns a uri and has no refusal channel, so a caller that
        // ignored a falsy return would report success for a write that never
        // happened.
        await assert.rejects(() => writeAs(holder([]), 'documents', 'x.md'), /Refused/)
    })

    it('refuses a delete on the same rule', async () => {
        await writeAs(holder(['*']), 'layouts', 'seeded.liquid')
        await assert.rejects(
            () => withPrincipal(holder(['write:documents']),
                () => useCollection(runtime, 'layouts').remove('seeded.liquid')),
            /needs write:layouts/)
    })

    it('lets an unattributed caller through, as it always did', async () => {
        // No principal context: a library caller, a lifecycle hook, a plugin
        // doing its own work. Unknown is not "nobody", and refusing here would
        // break every build.
        await useCollection(runtime, 'layouts').write('internal.liquid', 'x')
        assert.equal(await readFile(path.join(dir, 'layouts', 'internal.liquid'), 'utf8'), 'x')
    })
})

// affectedBy must see layout sidecars.
//
// `update_entity --dryRun` answers "what would this change re-render" out of
// manifest.affectedBy, and for a sidecar it answered NOTHING — the one
// direction of wrong that matters, because it tells an editor a site-wide
// edit is safe. The real cycle then re-rendered every page.
//
// A sidecar is reachable by none of the three routes affectedBy walks:
// it never renders, so it owns no snapshot; nothing points at it by ref;
// and no query matches it. Its dependency is the layout's INPUT DIGEST,
// which is not an edge and never was.
//
// The blast radius is genuinely everything-through-a-layout: layouts folds
// all sidecar scripts under the folder into one `sharedDigest` that lands in
// every layout's input bytes (mikser-io-layouts, sidecarInputs), so one
// sidecar edit moves every layout's checksum.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { createManifest, SNAPSHOTS_SCHEMA, FAILURES_SCHEMA } from '../../src/manifest/index.js'
import { createSqliteDatabase } from '../../src/database/index.js'

function makeDb() {
    const db = createSqliteDatabase({
        runtimeFolder: '/tmp',
        version: 'test',
        config: { filename: ':memory:' },
        schemas: new Map([
            ['mikser_snapshots', SNAPSHOTS_SCHEMA],
            ['mikser_failures', FAILURES_SCHEMA],
        ]),
    })
    db.open()
    return db
}

const layoutEdge = (id) => [{ kind: 'layout', target: id, targetId: id, hash: 'h1' }]

beforeEach(() => {
    runtime.catalog = { byId: new Map() }
})

describe('manifest.affectedBy for a layout sidecar', () => {

    it('reports every destination rendered through a layout', () => {
        const m = createManifest(makeDb())
        m.record({ id: '/documents/a.md', destination: '/a.html' }, layoutEdge('/layouts/page.liquid'))
        m.record({ id: '/documents/b.md', destination: '/b.html' }, layoutEdge('/layouts/page.liquid'))
        m.record({ id: '/documents/c.md', destination: '/c.html' }, layoutEdge('/layouts/post.liquid'))

        const affected = m.affectedBy({ id: '/layouts/page.js', type: 'sidecar' })

        // Every layout, not just the one sharing the sidecar's name: the
        // shared digest is global, so `post.liquid` is invalidated by a
        // change to `page.js` exactly as `page.liquid` is. Asserting only
        // the same-name layout would pass against the bug this test exists
        // to catch.
        assert.deepEqual(
            affected.map(a => a.destination).sort(),
            ['/a.html', '/b.html', '/c.html'])
    })

    it('carries the provenance a reader needs to check it', () => {
        const m = createManifest(makeDb())
        m.record({ id: '/documents/a.md', destination: '/a.html' }, layoutEdge('/layouts/page.liquid'))

        const [entry] = m.affectedBy({ id: '/layouts/page.js', type: 'sidecar' })
        assert.equal(entry.reason, 'ref-changed')
        assert.equal(entry.dependency, '/layouts/page.liquid',
            'name the layout, or the answer is a count with nothing to verify it against')
        assert.match(entry.why, /sidecar/)
    })

    it('leaves out what never rendered through a layout', () => {
        // A copied asset has no layout edge. Sweeping it in would turn the
        // preview into "everything, always", which is the same non-answer
        // as "nothing" wearing the opposite sign.
        const m = createManifest(makeDb())
        m.record({ id: '/documents/a.md', destination: '/a.html' }, layoutEdge('/layouts/page.liquid'))
        m.record({ id: '/assets/logo.svg', destination: '/logo.svg' }, [])

        const affected = m.affectedBy({ id: '/layouts/page.js', type: 'sidecar' })
        assert.deepEqual(affected.map(a => a.destination), ['/a.html'])
    })

    it('does not change the answer for a non-sidecar entity', () => {
        // The sidecar route is an early return. If it leaked to documents,
        // every edit would preview as a full rebuild.
        const m = createManifest(makeDb())
        m.record({ id: '/documents/a.md', destination: '/a.html' }, layoutEdge('/layouts/page.liquid'))
        m.record({ id: '/documents/b.md', destination: '/b.html' }, layoutEdge('/layouts/page.liquid'))

        const affected = m.affectedBy({ id: '/documents/a.md', type: 'document' })
        assert.deepEqual(affected.map(a => a.destination), ['/a.html'],
            'a document edit affects its own render, not its layout-mates')
    })
})

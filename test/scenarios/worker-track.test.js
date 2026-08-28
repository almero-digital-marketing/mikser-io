// Dependency tracking for renders dispatched to a WORKER.
//
// A track is an object of closures, so it cannot be structured-cloned across a
// thread boundary. It used to be dropped before dispatch, and a worker render
// therefore recorded no partials and no lookups — only the layout edge the
// manifest adds by itself. The consequence was quiet and bad: edit a partial,
// or rename the page a template links to, and nothing scheduled the pages that
// depended on them. A green build, and stale output.
//
// The closures are what cannot cross; the collected data can. So the worker
// builds its own track and returns its CONTENTS with the result, which the
// engine folds into the real one.
//
// Returned WITH THE RESULT rather than posted over the IPC port, which is how
// logging crosses. The port is a different channel from the one carrying the
// result, so nothing orders the last message before the promise resolves — a
// dep that lost that race would be silently missing, which is the exact
// failure this is fixing. A log line arriving late costs nothing; a dependency
// arriving late costs a stale page.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir, readManifest } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' } }),
        renderHbs(),
    ],
}
`

// The layout pulls in a partial and resolves a link, so a correct track has
// three kinds in it. `a` renders on a worker; `b` renders inline and is the
// control — whatever the worker records, the inline render must record too.
const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs':
        '<html><body>{{> partials/box}}{{#if (lookupHref "/other")}}<a>o</a>{{/if}}</body></html>',
    'layouts/partials/box.hbs': '<div>{{document.meta.title}}</div>',
    'documents/a.md':     '---\nhref: /a\ntitle: One\ntask: worker\n---\n',
    'documents/b.md':     '---\nhref: /b\ntitle: Two\n---\n',
    'documents/other.md': '---\nhref: /other\ntitle: Other\n---\n',
}

describe('a render dispatched to a worker', () => {
    const workdir = freshWorkdir('worker-track')
    after(() => cleanup(workdir))

    let onWorker, inline
    before(async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir, [])
        const manifest = await readManifest(workdir)
        onWorker = manifest.find(s => s.id === '/documents/a.md')
        inline   = manifest.find(s => s.id === '/documents/b.md')
    })

    const kinds = (snap) => (snap?.refClosure ?? []).map(e => e.kind)

    it('records the PARTIALS the template pulled in', () => {
        // The one that used to be missing entirely. Without it, editing
        // partials/box.hbs re-renders nothing that uses it.
        assert.ok(kinds(onWorker).includes('partial'),
            `no partial edge: ${JSON.stringify(onWorker?.refClosure)}`)
        const partial = onWorker.refClosure.find(e => e.kind === 'partial')
        assert.match(partial.target, /partials\/box/)
    })

    it('records the LOOKUPS the template resolved', () => {
        // Same failure in the other direction: rename /other and the page
        // linking to it keeps pointing at something that no longer exists.
        assert.ok(kinds(onWorker).includes('lookup'),
            `no lookup edge: ${JSON.stringify(onWorker?.refClosure)}`)
        assert.equal(onWorker.refClosure.find(e => e.kind === 'lookup').target, '/other')
    })

    it('records the meta keys the template read', () => {
        assert.ok(onWorker.metaReads?.includes('data.meta.title'),
            `metaReads: ${JSON.stringify(onWorker?.metaReads)}`)
    })

    it('tracks the same kinds an INLINE render does', () => {
        // The point of the fix: dispatch mode is an execution detail and must
        // not change what the build knows about the page.
        assert.deepEqual(kinds(onWorker).sort(), kinds(inline).sort())
    })

    it('still renders correctly', async () => {
        const manifest = await readManifest(workdir)
        assert.equal(manifest.length, 3)
        assert.ok(onWorker.outputHash, 'the worker render produced output')
    })
})

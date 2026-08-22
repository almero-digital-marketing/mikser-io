// Integration tests for lookup-based invalidation.
//
// The gap this closes: `runtime.href()` and `runtime.lookupUrl()` are
// how a template asks "where does /contacts live?". The answer depends
// on ANOTHER entity's destination, but the asking template's own source
// never changes — so nothing scheduled it for re-render, and nothing
// recorded that it had asked. Move or rename the target and the build
// went green with a dead link in the output.
//
// The fix is one edge kind, written at render time:
//   render.js  — the href/lookupUrl wrappers call track.lookup(target)
//   manifest   — collectEdges emits {kind:'lookup', target, hash}
//   refs       — replaceDynamic owns kind != 'ref', so the edge lands
//                in mikser_refs and inverseClosureOf walks back to the
//                asking entity on the next cycle
//
// The kind matters: writing these as 'ref' put them under the STATIC
// indexer's ownership, which clears kind='ref' per source. The edge got
// inserted and then wiped — visible in the manifest, absent from the
// refs index, and still never scheduling anything.
//
// Two directions are both required, and they pull against each other:
//   - the target MOVES  -> the asking entity MUST re-render (staleness)
//   - nothing changes   -> it must NOT re-render (over-invalidation)

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { rename, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

// cleanUrls: false keeps destinations as plain .html so the assertions
// read literally; the tracking has nothing to do with URL shape.
const CONFIG = `
import { documents, frontMatter, yaml, renderHbs, hrefUrlHelpers } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(), hrefUrlHelpers(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' }, cleanUrls: false }),
        renderHbs(),
    ],
}
`

// The lookup is by meta.href — a name that SURVIVES the rename. Only
// the destination behind it moves, which is what makes the stale link
// silent: the lookup still resolves, just to a different file.
const PAGE_LAYOUT = '<a href="{{#with (href "/contacts")}}{{url}}{{/with}}">contact</a>'

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'documents/page-a.md': '---\ntitle: A\n---\nbody\n',
    'documents/contacts.md': '---\ntitle: Contacts\nhref: /contacts\n---\nbody\n',
    'layouts/page.hbs': PAGE_LAYOUT,
}

describe('lookup invalidation: runtime.href() targets are tracked', () => {
    const workdir = freshWorkdir('lookup-invalidation')
    after(() => cleanup(workdir))

    const linkIn = async (file) => {
        const html = await readFile(path.join(workdir, 'out', file), 'utf8')
        return html.match(/href="([^"]*)"/)?.[1]
    }
    const htmlFiles = async () =>
        (await readdir(path.join(workdir, 'out'))).filter((f) => f.endsWith('.html')).sort()

    it('renders the initial link', async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir)
        assert.deepEqual(await htmlFiles(), ['contacts.html', 'page-a.html'])
        assert.equal(await linkIn('page-a.html'), 'contacts.html')
    })

    it('re-renders the asking page when the target is RENAMED', async () => {
        await rename(
            path.join(workdir, 'documents', 'contacts.md'),
            path.join(workdir, 'documents', 'contact-us.md'),
        )
        await runMikser(workdir)

        // The link must follow the target, and must point at a file
        // that actually exists — the original bug left it pointing at
        // the deleted contacts.html with a green build.
        const files = await htmlFiles()
        assert.deepEqual(files, ['contact-us.html', 'page-a.html'])
        const link = await linkIn('page-a.html')
        assert.equal(link, 'contact-us.html')
        assert.ok(files.includes(link), `dead link: ${link} is not among ${files.join(', ')}`)
    })

    it('does NOT re-render when nothing changed', async () => {
        const result = await runMikser(workdir)
        // A lookup edge whose target hash is unchanged must not drag
        // the asking entity back into the render set every cycle.
        assert.equal(/Rendered:/.test(stripAnsi(result.stdout)), false)
    })

    it('re-renders when the target is DELETED', async () => {
        await rm(path.join(workdir, 'documents', 'contact-us.md'))
        await runMikser(workdir)

        // The output must stop claiming a file that is gone. The helper
        // degrades to the unresolved form; what matters here is that
        // page-a was rebuilt at all rather than left pinned to bytes
        // naming a deleted destination.
        assert.deepEqual(await htmlFiles(), ['page-a.html'])
        assert.notEqual(await linkIn('page-a.html'), 'contact-us.html')
    })

    it('re-renders when the target CHANGES its href', async () => {
        // The case that motivated recording bindings. The target keeps
        // its file, so there is no DELETE payload carrying the old name
        // and no new id — only `meta.href` moves, and the old key is the
        // one every dependent recorded. Name-based invalidation cannot
        // see this; the edge's target_id can, because it names the
        // entity rather than what the entity is currently called.
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir)
        assert.equal(await linkIn('page-a.html'), 'contacts.html')

        await writeFile(
            path.join(workdir, 'documents', 'contacts.md'),
            '---\ntitle: Contacts\nhref: /reach-us\n---\nbody\n',
        )
        await runMikser(workdir)

        // /contacts resolves to nothing now, so the helper falls back to
        // the raw name. What matters is that page-a was rebuilt at all
        // instead of keeping a link to a destination no entity owns.
        assert.notEqual(await linkIn('page-a.html'), 'contacts.html')
    })
})

// `catalog: false` keeps the file and drops the row.
//
// This is gpoint-api's shape: it renders documents and emails through mikser
// with `{ save: true, catalog: false }` — the file on disk is the whole point,
// the catalog row is not. The entity is ad-hoc, assembled per request from
// data that is nobody's source file, and a row for it would sit in the catalog
// as a scratch entity forever. gpoint's cms accumulated 1,134 of them carrying
// 86 MB of render payload before anyone noticed.
//
// The pairing used to be REFUSED, and for a reason worth keeping in view: the
// old implementation pruned by journalling a DELETE, and a journalled DELETE
// drags the manifest's file cleanup along with it — so honouring `save: true,
// catalog: false` literally would have written the file and then unlinked it.
// The refusal hid the coupling instead of removing it.
//
// So the guarantee is stated as two halves that have to hold TOGETHER, since
// each is individually easy to satisfy by breaking the other:
//   - the file the render was asked to produce is on disk, and stays there
//   - no row for it is in the catalog
//
// The `save: false` half of the same rule lives in
// preview-render-no-snapshot.test.js.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, readCatalog, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs, useRenderer, runtime, findEntity } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'

// An entity that exists nowhere but in this call — no source file, nothing in
// the catalog before it, exactly like a document gpoint-api assembles from a
// request body. Rendered for its FILE.
function renderOnDemandDocument() {
    return ({ onLoaded }) => {
        onLoaded(async () => {
            // Layouts are catalog entities too, so on a FRESH workdir there is
            // nothing to resolve 'page' against yet and the render would fail
            // for that reason rather than any this scenario is about. The
            // second run is the one that matters; this is how the sibling
            // preview scenario gets past the first as well.
            if (!await findEntity({ id: '/documents/published.md' })) return
            const { render } = useRenderer(runtime)
            const { output } = await render(
                {
                    // gpoint-api's exact shape: a per-request id, no layout
                    // object and no destination — only \`meta.layout\`, which
                    // the layouts plugin resolves during the render's own
                    // cycle, deriving the destination from \`name\`.
                    id: '/archive/invoices/42.md',
                    name: 'invoices/42',
                    format: 'md',
                    type: 'document',
                    collection: 'documents',
                    content: 'body',
                    layout: { name: 'page', template: 'page.hbs' },
                    meta: { layout: 'page', title: 'Invoice 42' },
                },
                { save: true, catalog: false },
            )
            console.log('RENDERED_BYTES=' + String(output?.result ?? '').replace(/\\s+/g, ' ').trim())
        })
    }
}

export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ layoutsFolder: 'layouts' }), renderHbs(),
        renderOnDemandDocument(),
    ],
}
`

describe('a save:true, catalog:false render', () => {
    const workdir = freshWorkdir('catalog-false-keeps-file')
    after(() => cleanup(workdir))

    it('leaves the file on disk and no row in the catalog', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<article>{{entity.meta.title}}</article>',
            // A real page, so the build has something ordinary to do and we can
            // tell "nothing was written" apart from "this render wrote nothing".
            'documents/published.md': '---\nlayout: page\ntitle: Published\n---\nbody\n',
        })

        // Two runs. onLoaded is the only place a one-shot build can render
        // OUTSIDE a cycle — which is where an HTTP render handler lives, and
        // asking for one from inside a cycle deadlocks, since render() waits
        // for the next one. On a fresh workdir the first run's onLoaded has no
        // layouts to resolve against yet: they are catalog entities too.
        const first = await runMikser(workdir)
        assert.equal(first.code, 0, first.combined)

        const build = await runMikser(workdir)
        assert.equal(build.code, 0, stripAnsi(build.stderr))
        assert.match(stripAnsi(build.stdout), /RENDERED_BYTES=<article>Invoice 42<\/article>/,
            'the caller gets the rendered bytes')

        // layouts derives the destination from `name` and cleanUrls turns it
        // into a directory index — the entity carries no destination of its
        // own, same as gpoint-api's.
        const invoice = path.join(workdir, 'out', 'invoices', '42', 'index.html')
        assert.ok(existsSync(invoice), 'save: true must write the file')
        assert.match(readFileSync(invoice, 'utf8'), /<article>Invoice 42<\/article>/,
            'and it holds what was rendered, not an empty or stale file')

        const catalog = await readCatalog(workdir)
        assert.ok(!catalog.entities.some(e => e.id === '/archive/invoices/42.md'),
            'catalog: false must leave no row behind')
        assert.ok(catalog.entities.some(e => e.id === '/documents/published.md'),
            'the ordinary entity is still there — the prune was not indiscriminate')

        // The second build is the half the old design would have failed: the
        // journalled DELETE that used to implement pruning takes the manifest's
        // file cleanup with it, so the file disappears on a LATER cycle rather
        // than this one.
        const again = await runMikser(workdir)
        assert.equal(again.code, 0, again.combined)
        assert.ok(existsSync(invoice), 'and the file survives the next build')
    })
})

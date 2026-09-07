// A render that writes nothing records no snapshot.
//
// `render(entity, { save: false })` hands the bytes back and deliberately
// writes no file — it is how an on-demand surface (an MCP app, an HTTP
// preview) renders without publishing. A snapshot, though, is the manifest's
// CLAIM that a file exists at a destination: it is what --audit-output
// verifies and what invalidation compares against.
//
// Recording one for a render that wrote nothing makes the manifest assert a
// file nobody wrote. Seen on a live site: an app rendered on demand left
// /internal/customer-registration.html claimed and absent, and --audit-output
// went red for a page that was never meant to exist. Every other check agreed
// with itself, which is what made it hard to see — the same shape as the
// retried-render bug in this folder.
//
// Not recording it is also the truthful state for invalidation: nothing was
// produced, so a later real build has nothing to reuse.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, readManifest, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs, useRenderer, runtime, findEntity } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'

// Renders one entity on demand, the way a preview surface does: bytes back,
// nothing on disk. It picks an entity the pipeline does NOT render by itself
// (no layout matches it), so anything the manifest ends up holding for it came
// from THIS render and nowhere else.
function onDemandPreview() {
    // onLoaded, not a cycle hook: render() waits for the next cycle, so asking
    // for one from INSIDE a cycle deadlocks. A preview surface calls it from a
    // request handler — outside any cycle — and this is the closest a one-shot
    // build gets to that.
    return ({ onLoaded }) => {
        onLoaded(async () => {
            const entity = await findEntity({ id: '/documents/on-demand.md' })
            if (!entity) return
            const { render } = useRenderer(runtime)
            const { output } = await render(
                { ...entity, layout: { name: 'page', template: 'page.hbs' },
                  meta: { ...entity.meta, layout: 'page' },
                  destination: '/on-demand.html' },
                { save: false },
            )
            console.log('PREVIEW_BYTES=' + String(output?.result ?? '').replace(/\\s+/g, ' ').trim())
        })
    }
}

export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ layoutsFolder: 'layouts' }), renderHbs(),
        onDemandPreview(),
    ],
}
`

describe('a save:false render records no snapshot', () => {
    const workdir = freshWorkdir('preview-no-snapshot')
    after(() => cleanup(workdir))

    it('hands back bytes, writes no file, and leaves the manifest clean', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<article>{{entity.meta.title}}</article>',
            // Rendered normally: proves the fixture builds and that a real
            // render still records its snapshot.
            'documents/published.md': '---\nlayout: page\ntitle: Published\n---\nbody\n',
            // No layout in its frontmatter and no auto-match, so the pipeline
            // leaves it alone. Only the on-demand render touches it.
            'documents/on-demand.md': '---\ntitle: On demand\n---\nbody\n',
        })

        // Two runs: the first populates the catalog, the second finds the
        // entity at load and previews it. onLoaded is the only place a
        // one-shot build can render OUTSIDE a cycle, which is where a preview
        // surface lives — asking for a render from inside a cycle deadlocks,
        // since render() waits for the next one.
        const first = await runMikser(workdir)
        assert.equal(first.code, 0, stripAnsi(first.stderr))

        const build = await runMikser(workdir)
        assert.equal(build.code, 0, stripAnsi(build.stderr))
        assert.match(stripAnsi(build.stdout), /PREVIEW_BYTES=<article>On demand<\/article>/,
            'the caller still gets the rendered bytes')

        assert.equal(existsSync(path.join(workdir, 'out', 'on-demand.html')), false,
            'save: false must not write the file')

        const snapshots = await readManifest(workdir)
        const claimed = snapshots.map(s => s.destination)
        assert.ok(claimed.includes('/published/index.html'), 'a real render still records its snapshot')
        assert.ok(!claimed.includes('/on-demand.html'),
            'a render that wrote nothing must not claim a destination')

        const audit = await runMikser(workdir, ['--audit-output'])
        assert.equal(audit.code, 0, stripAnsi(audit.stdout) + stripAnsi(audit.stderr))
        assert.doesNotMatch(stripAnsi(audit.stdout), /on-demand\.html/,
            'the audit has nothing to report about a file that was never meant to exist')
    })
})

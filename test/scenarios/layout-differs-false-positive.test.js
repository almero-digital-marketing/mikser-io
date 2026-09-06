// mikser_explain must not report an untouched layout as diverged.
//
// A layout's catalog checksum is composed — md5("<template>:<sidecar>:<shared>")
// — so a sidecar edit invalidates the layout that uses it. explain compared
// that against a fresh md5 of the template, which is a different recipe, so it
// reported `differs: true` for every layout on every site. On a live site both
// layouts reported it, about files last edited days earlier and committed.
//
// The reader's next move is to hunt for an edit that was never made, and the
// verdict text told them to: "source differs from the catalog — a build would
// re-import it first". The build would do no such thing.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { renderHbs } from 'mikser-io'
export default {
    plugins: [
        documents(), frontMatter(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' } }),
        renderHbs(),
    ],
}
`

describe('a layout nobody has touched', () => {
    const workdir = freshWorkdir('layout-differs')
    after(() => cleanup(workdir))
    let explained

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<html><body>{{document.meta.title}}</body></html>',
            'documents/a.md': '---\nhref: /a\ntitle: One\n---\n',
        })
        await runMikser(workdir)
        const { combined } = await runMikser(workdir, ['--explain', '/layouts/page.hbs', '--json'])
        explained = JSON.parse(combined.slice(combined.indexOf('{'), combined.lastIndexOf('}') + 1))
    })

    it('reports the catalog and the disk as agreeing', () => {
        assert.ok(explained.source, `explain returned no source block\n${JSON.stringify(explained, null, 2)}`)
        assert.equal(explained.source.differs, false,
            `an unedited layout must not report as diverged\n${JSON.stringify(explained.source, null, 2)}`)
    })

    it('shows the composed value it compared, so the reader can see why', () => {
        // The raw file hash is still reported — it is a real fact — but the
        // comparison is against the composed one, and both are visible so the
        // difference between them stops looking like a discrepancy.
        assert.ok(explained.source.comparableChecksum,
            'a composing collection must show what was actually compared')
        assert.notEqual(explained.source.comparableChecksum, explained.source.fileChecksum,
            'and it is genuinely a different value from the file hash')
        assert.equal(explained.source.comparableChecksum, explained.source.catalogChecksum)
    })

    it('does not send the reader hunting for an edit nobody made', () => {
        assert.doesNotMatch(explained.verdict ?? '', /source differs from the catalog/,
            `the verdict still claims a divergence\n${explained.verdict}`)
    })
})

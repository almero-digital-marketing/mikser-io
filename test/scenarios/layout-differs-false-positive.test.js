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
            // A sidecar lives in the SAME collection but is gated on its own
            // bytes, not composed — so it must be compared as a file hash.
            'layouts/page.js': 'export default async () => ({})\n',
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

    it('does not report a sidecar as diverged either', async () => {
        // Same collection, different rule: a sidecar has no template and no
        // sidecar of its own, so its catalog checksum IS the file hash.
        // A collection-wide composition would report every one as diverged —
        // the same false alarm pointed the other way.
        const { combined } = await runMikser(workdir, ['--explain', '/layouts/page.js', '--json'])
        const sidecar = JSON.parse(combined.slice(combined.indexOf('{'), combined.lastIndexOf('}') + 1))
        assert.ok(sidecar.source, `explain returned no source block\n${combined}`)
        assert.equal(sidecar.source.differs, false,
            `a sidecar must be compared as a file hash\n${JSON.stringify(sidecar.source, null, 2)}`)
        assert.equal(sidecar.source.comparableChecksum, undefined,
            'and must not claim a composed value it does not have')
    })

    it('does not send the reader hunting for an edit nobody made', () => {
        assert.doesNotMatch(explained.verdict ?? '', /source differs from the catalog/,
            `the verdict still claims a divergence\n${explained.verdict}`)
    })
})

// The same false alarm, in a second collection, for a different reason.
//
// A preset's catalog checksum is its module's `revision`, not a hash of the
// file — deliberately, so an author can edit a preset freely and bump the
// revision only when derivatives must be produced again. Compared against a
// file hash it never matched, so every preset on every site reported as
// diverged.
//
// Kept here rather than in mikser-io-assets because the behaviour spans both:
// the registry is core's and the recipe is the plugin's, and only a real build
// exercises the pair.
describe('a preset nobody has touched', () => {
    const workdir = freshWorkdir('preset-differs')
    after(() => cleanup(workdir))

    const PRESET = [
        "import { mkdir, copyFile } from 'node:fs/promises'",
        "import path from 'node:path'",
        'export const revision = 3',
        'export default async function web({ entity }) {',
        '    await mkdir(path.dirname(entity.destination), { recursive: true })',
        '    await copyFile(entity.source ?? entity.uri, entity.destination)',
        '}',
    ].join('\n')

    it('is compared against the revision the catalog holds, not the file', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { assets, renderPreset } from 'mikser-io-assets'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [ documents(), files(), frontMatter(),
    assets({ assetsFolder: 'derived', presets: { web: { match: ['/files/media/**'] } } }), renderPreset(),
    layouts({ autoLayouts: false, match: { '@/**': 'page' } }), renderHbs() ] }
`,
            'presets/web.js': PRESET,
            'files/media/hero.jpg': 'jpeg-ish',
            'layouts/page.hbs': '<html>{{document.meta.title}}</html>',
            'documents/a.md': '---\nhref: /a\ntitle: One\n---\n',
        })
        await runMikser(workdir)
        const { combined } = await runMikser(workdir, ['--explain', '/presets/web', '--json'])
        const explained = JSON.parse(combined.slice(combined.indexOf('{'), combined.lastIndexOf('}') + 1))

        assert.equal(explained.source.catalogChecksum, 3, 'the catalog holds the revision')
        assert.equal(explained.source.comparableChecksum, 3, 'and that is what was compared')
        assert.notEqual(explained.source.fileChecksum, 3, 'the file hash is a different kind of value')
        assert.equal(explained.source.differs, false,
            `an unedited preset must not report as diverged\n${JSON.stringify(explained.source, null, 2)}`)
    })
})

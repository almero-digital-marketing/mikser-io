// --force must actually force.
//
// Three independent gates can stop a render:
//
//   1. the import checksum gate      (source.js gateChecksum, and a
//                                     SECOND one inside files())
//   2. the dispatch filter           (mikser-io-layouts assembly)
//   3. the manifest skip             (manifest.skipDecision)
//
// Force has to be honoured by all four (3 and files()'s own copy of 1
// are the easy ones to miss). Because 3 runs last, one gate ignoring
// force is enough for a forced build to re-import everything,
// re-dispatch everything, then drop all of it as `unchanged` —
// rendered=0, exit 0, and a summary that reads like a success. That is
// the one situation --force exists for: the invalidation graph under
// suspicion.
//
// Each gate is individually correct, so this asserts on the whole
// pipeline rather than any single one.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs, files } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(), files(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' }, cleanUrls: false }),
        renderHbs(),
    ],
}
`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs': '<html><body>{{{document.content}}}</body></html>',
    'documents/page-a.md': '---\ntitle: A\n---\nbody a\n',
    'documents/page-b.md': '---\ntitle: B\n---\nbody b\n',
    'files/hero.txt': 'v1',
}

describe('--force', () => {
    const workdir = freshWorkdir('force')
    after(() => cleanup(workdir))

    const report = async (args = []) =>
        JSON.parse((await runMikser(workdir, [...args, '--json'])).stdout)

    it('cold build renders everything', async () => {
        await setupFixture(workdir, FIXTURE)
        const r = await report()
        assert.equal(r.summary.rendered, 3)
    })

    it('a plain rebuild gates at import and renders nothing', async () => {
        const r = await report()
        assert.equal(r.summary.rendered, 0)
        // Gated, not skipped: they never became render tasks at all. This
        // is the baseline the forced run has to differ from.
        assert.ok(r.summary.gated > 0)
        assert.equal(r.summary.skipped, 0)
    })

    it('--force renders everything and skips nothing', async () => {
        const r = await report(['--force'])
        assert.equal(r.summary.gated, 0, 'the import gate must be bypassed')
        assert.equal(r.summary.skipped, 0, 'the manifest must not skip under --force')
        assert.equal(r.summary.rendered, 3)
        assert.deepEqual([...new Set(r.rendered.map(e => e.reason))], ['force'])
    })

    it('--force re-emits collections that have no layout', async () => {
        // files() carries its own checksum gate, separate from source.js's,
        // and honoured neither --force nor a wiped catalog. So no amount of
        // forcing re-derived a file's name / meta.url / meta.presets, which
        // left a catalog holding bad `files` rows with no repair path short
        // of deleting them (see #7).
        const r = await report(['--force'])
        assert.ok(
            r.rendered.some(e => e.id.startsWith('/files/')),
            `expected a /files/ entity among ${r.rendered.map(e => e.id).join(', ')}`,
        )
    })

    it('--force does not disturb output whose bytes are unchanged', async () => {
        // The point of forcing is to redo the WORK, not to touch every
        // file. Composed with the unchanged-output check, a forced build
        // re-renders everything and writes only what actually differs, so
        // it stays cheap to reach for — and `unchanged` then measures how
        // much of the catalog was stale by suspicion rather than in fact.
        const before = (await stat(path.join(workdir, 'out', 'page-a.html'))).mtimeMs
        await new Promise(resolve => setTimeout(resolve, 20))

        const r = await report(['--force'])
        assert.equal(r.summary.rendered, 3)
        assert.equal(r.summary.unchanged, 3, 'every render produced identical bytes')
        assert.equal(
            (await stat(path.join(workdir, 'out', 'page-a.html'))).mtimeMs, before,
            'forcing must not move mtime when the bytes did not change',
        )
    })

    it('a plain rebuild after a forced one gates again', async () => {
        // Forcing must not leave the manifest in a state that keeps
        // re-rendering afterwards.
        const r = await report()
        assert.equal(r.summary.rendered, 0)
        assert.ok(r.summary.gated > 0)
    })
})

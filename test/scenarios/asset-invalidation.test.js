// Integration tests for $-refs that name a SERVED PATH.
//
// `refFilter` resolves a ref four ways — id, meta.href, meta.url, and
// id-minus-extension. `meta.url` is the ADR-0011 served path, and it is
// how content authors reference assets: `$hero: /hero.jpg`, not
// `$hero: /files/hero.jpg`. It is the normal form, not an edge case.
//
// Two independent things have to hold, or editing an image or a video
// leaves every page using it holding the previous checksum, dimensions
// and URL, on a green build:
//
//   1. `lookupKeys()` must produce all four forms refFilter resolves.
//      Omit meta.url and an edge recorded against '/hero.txt' is matched
//      against the keys of '/files/hero.txt', which never include it.
//
//   2. `inputHashOf()` must fold in the file checksum whenever content
//      is absent, not only when meta is absent too. `files()` stamps
//      meta.url on every file entity, so conditioning on meta being null
//      means the checksum is always ignored and a file's inputHash does
//      not move when its bytes do — the dep-hash comparison then answers
//      "unchanged" even with the edge matched.
//
// Both are required, so the test asserts the observable behaviour — did
// the dependent rebuild? — rather than either mechanism.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
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
    // Names the served path, which resolves via meta.url.
    'documents/page-a.md': '---\ntitle: A\n$hero: /hero.txt\n---\nbody\n',
    // A control: same layout, no reference to the asset.
    'documents/page-b.md': '---\ntitle: B\n---\nbody\n',
    'files/hero.txt': 'v1',
    'layouts/page.hbs': 'page',
}

describe('asset invalidation: $-refs by served path (meta.url)', () => {
    const workdir = freshWorkdir('asset-invalidation')
    after(() => cleanup(workdir))

    // --json puts the machine-readable report on stdout and every log
    // line on stderr, so the whole of stdout parses.
    const renderedIds = async () => {
        const result = await runMikser(workdir, ['--json'])
        return JSON.parse(result.stdout).rendered.map(entry => entry.id)
    }

    it('renders everything on a cold build', async () => {
        await setupFixture(workdir, FIXTURE)
        const ids = await renderedIds()
        assert.ok(ids.includes('/documents/page-a.md'))
        assert.ok(ids.includes('/documents/page-b.md'))
    })

    it('re-renders the referring page when the asset bytes change', async () => {
        await writeFile(path.join(workdir, 'files', 'hero.txt'), 'v2-different-bytes')
        const ids = await renderedIds()
        assert.ok(
            ids.includes('/documents/page-a.md'),
            `page-a references the changed asset and must rebuild; rendered: ${ids.join(', ')}`,
        )
    })

    it('leaves pages that do not reference the asset alone', async () => {
        // Precision matters as much as coverage here: the binding is
        // meant to invalidate the dependents, not the corpus. If this
        // fails the fix has degenerated into "rebuild everything".
        await writeFile(path.join(workdir, 'files', 'hero.txt'), 'v3-changed-again')
        const ids = await renderedIds()
        assert.ok(ids.includes('/documents/page-a.md'))
        assert.ok(!ids.includes('/documents/page-b.md'))
    })

    it('renders nothing when nothing changed', async () => {
        assert.deepEqual(await renderedIds(), [])
    })
})

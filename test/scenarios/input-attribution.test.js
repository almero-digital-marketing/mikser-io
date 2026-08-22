// Which input moved, not merely that one did.
//
// `inputs-changed` on its own is an answer that stops one step short of
// useful: it says the entity's hash differs from what it was rendered at,
// and leaves "which of meta / content / checksum / inputs" to a database
// query. The manifest records per-component hashes of the same payload the
// combined hash covers, so the answer is already in hand.
//
// The case that motivated it: an image re-rendering a page, where the
// question is whether the bytes moved or something about the entity did.
// `checksum` versus `meta.url` is the whole difference, and both live under
// one hash.

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
    'layouts/page.hbs': '<html><body>{{{document.content}}}</body></html>',
    'documents/page-a.md': '---\ntitle: A\n---\nbody a\n',
    'files/hero.txt': 'v1',
}

describe('input change attribution', () => {
    const workdir = freshWorkdir('input-attribution')
    after(() => cleanup(workdir))

    const report = async () => JSON.parse((await runMikser(workdir, ['--json'])).stdout)
    const changedFor = async (id) => {
        const entry = (await report()).rendered.find(e => e.id === id)
        return entry?.changed ?? null
    }

    it('cold build reports no attribution — nothing to compare against', async () => {
        await setupFixture(workdir, FIXTURE)
        const r = await report()
        for (const entry of r.rendered) {
            assert.equal(entry.reason, 'never-rendered')
            assert.equal(entry.changed, undefined, 'a first render has no prior parts to diff')
        }
    })

    it('names `checksum` when an asset\'s bytes change', async () => {
        // The motivating case. `checksum` rather than `meta` is what says the
        // file itself moved, as opposed to something about its entity.
        await writeFile(path.join(workdir, 'files', 'hero.txt'), 'v2-different-bytes')
        assert.deepEqual(await changedFor('/files/hero.txt'), ['checksum'])
    })

    it('names the front-matter FIELD, not just "meta"', async () => {
        await writeFile(path.join(workdir, 'documents', 'page-a.md'),
            '---\ntitle: A renamed\n---\nbody a\n')
        assert.deepEqual(await changedFor('/documents/page-a.md'), ['meta.title'])
    })

    it('names `content` when the body changes', async () => {
        await writeFile(path.join(workdir, 'documents', 'page-a.md'),
            '---\ntitle: A renamed\n---\nbody rewritten\n')
        assert.deepEqual(await changedFor('/documents/page-a.md'), ['content'])
    })

    it('marks a field that appeared as added', async () => {
        await writeFile(path.join(workdir, 'documents', 'page-a.md'),
            '---\ntitle: A renamed\nweight: 3\n---\nbody rewritten\n')
        assert.deepEqual(await changedFor('/documents/page-a.md'), ['meta.weight (added)'])
    })

    it('marks a field that vanished as removed', async () => {
        await writeFile(path.join(workdir, 'documents', 'page-a.md'),
            '---\ntitle: A renamed\n---\nbody rewritten\n')
        assert.deepEqual(await changedFor('/documents/page-a.md'), ['meta.weight (removed)'])
    })

    it('does not attribute a DEPENDENCY change to the entity\'s own inputs', async () => {
        // A layout change is ref-changed, not inputs-changed. Conflating the
        // two would make the attribution actively misleading.
        await writeFile(path.join(workdir, 'layouts', 'page.hbs'),
            '<html><body><main>{{{document.content}}}</main></body></html>')
        const entry = (await report()).rendered.find(e => e.id === '/documents/page-a.md')
        assert.equal(entry.reason, 'ref-changed')
        assert.equal(entry.changed, undefined)
    })
})

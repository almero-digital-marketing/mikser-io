// Editing a layout sidecar must re-render.
//
// The sidecar is where a mikser site's data layer lives, and it was the one
// file that could be edited without effect — `.js` is excluded from the
// layouts scan, so it was not an entity, not watched as an input, and not
// part of any hash. A fresh build reported "unchanged" and left the previous
// output in place. Only --force picked it up.
//
// End-to-end because the complaint is specifically about a fresh process:
// the ESM cache was already handled (assembly imports with ?stamp=), so the
// unit-level hash change is necessary but not sufficient evidence.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), frontMatter(), yaml(), layouts({ autoLayouts: true, cleanUrls: false }), renderHbs()],
}
`

const sidecar = (prefix) => `
export async function load({ entity }) {
    return { title: '${prefix}' + entity.meta.title }
}
`

describe('a sidecar edit re-renders', () => {
    const workdir = freshWorkdir('sidecar-invalidation')
    after(() => cleanup(workdir))

    const out = () => readFile(path.join(workdir, 'out', 'hera.html'), 'utf8')

    it('picks up a changed sidecar without --force', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/hera.md': '---\ntitle: ONIX\n---\nbody\n',
            'layouts/hera.hbs': '<h4>{{data.title}}</h4>',
            'layouts/hera.js': sidecar(''),
        })

        const first = await runMikser(workdir)
        assert.equal(first.code, 0, stripAnsi(first.stderr))
        assert.match(await out(), /<h4>ONIX<\/h4>/)

        // Only the sidecar changes. No source document is touched, so
        // without the sidecar as an input every entity is "unchanged".
        await writeFile(path.join(workdir, 'layouts', 'hera.js'), sidecar('ZZ'))

        const second = await runMikser(workdir)
        assert.equal(second.code, 0, stripAnsi(second.stderr))
        assert.match(await out(), /<h4>ZZONIX<\/h4>/, 'the sidecar edit must reach the output')
    })

    it('leaves output alone when nothing changed', async () => {
        // The invalidation must be driven by an actual change, or every run
        // is a cold build and the cache stops meaning anything.
        const third = await runMikser(workdir)
        assert.equal(third.code, 0, stripAnsi(third.stderr))
        assert.match(await out(), /<h4>ZZONIX<\/h4>/)
        assert.match(stripAnsi(third.stdout), /unchanged/)
    })
})

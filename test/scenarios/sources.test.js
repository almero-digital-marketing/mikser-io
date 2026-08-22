// Build inputs as catalog entities.
//
// The gap: a site bundling assets needs a sidecar to read styles/ and js/.
// Reading them with `fs` works once and silently breaks watch — the engine
// has no dependency on a file it never saw, so editing a part rebuilds
// nothing. Registered as entities, findEntities() records the query into the
// render's refClosure and touching a part re-renders the bundle.
//
// End-to-end because that refClosure behaviour is the whole feature, and it
// only exists across two real runs.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs, sources } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        sources({ styles: { folder: 'styles', extensions: ['css'] } }),
        layouts({ autoLayouts: true, cleanUrls: false }),
        renderHbs(),
    ],
}
`

// The sidecar bundles every style part, in name order, via findEntities —
// which is what puts the query into the refClosure.
const SIDECAR = `
import { findEntities } from 'mikser-io'
export async function load() {
    const parts = await findEntities({ collection: 'styles' })
    return { css: parts.sort((a, b) => a.name.localeCompare(b.name)).map(p => p.content).join('') }
}
`

describe('sources: build inputs as entities', () => {
    const workdir = freshWorkdir('sources')
    after(() => cleanup(workdir))

    const out = () => readFile(path.join(workdir, 'out', 'page.html'), 'utf8')

    it('bundles the parts on the first build', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/page.md': '---\ntitle: P\n---\nbody\n',
            'layouts/page.hbs': '<style>{{data.css}}</style>',
            'layouts/page.js': SIDECAR,
            'styles/a-base.css': 'a{color:red}',
            'styles/b-hero.css': 'b{color:blue}',
        })
        const first = await runMikser(workdir)
        assert.equal(first.code, 0, stripAnsi(first.stderr))
        const html = await out()
        assert.match(html, /a\{color:red\}/)
        assert.match(html, /b\{color:blue\}/)
    })

    it('re-renders the bundle when a part is EDITED', async () => {
        // The failure this feature exists to prevent: with fs.readFile in the
        // sidecar, nothing depends on the part and this edit reaches nothing.
        await writeFile(path.join(workdir, 'styles', 'b-hero.css'), 'b{color:green}')
        const run = await runMikser(workdir)
        assert.equal(run.code, 0, stripAnsi(run.stderr))
        assert.match(await out(), /b\{color:green\}/)
    })

    it('re-renders when a part is ADDED', async () => {
        // A query edge, not a per-file one: a NEW matching entity has to
        // invalidate the consumer too, which is the harder half.
        await writeFile(path.join(workdir, 'styles', 'c-extra.css'), 'c{color:teal}')
        const run = await runMikser(workdir)
        assert.equal(run.code, 0, stripAnsi(run.stderr))
        assert.match(await out(), /c\{color:teal\}/)
    })

    it('re-renders when a part is REMOVED', async () => {
        await rm(path.join(workdir, 'styles', 'c-extra.css'))
        const run = await runMikser(workdir)
        assert.equal(run.code, 0, stripAnsi(run.stderr))
        assert.ok(!/c\{color:teal\}/.test(await out()), 'the removed part must leave the bundle')
    })

    it('does not link inputs into the output folder', async () => {
        // They are inputs, not output. A stylesheet part is not a thing the
        // site serves; it is a thing the site is built from.
        const { readdir } = await import('node:fs/promises')
        const outFiles = await readdir(path.join(workdir, 'out'), { recursive: true })
        assert.deepEqual(outFiles.filter(f => f.endsWith('.css')), [])
    })
})

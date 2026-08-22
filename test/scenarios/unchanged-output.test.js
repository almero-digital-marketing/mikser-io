// A re-render that produces byte-identical output must not touch the file.
//
// Invalidation is deliberately conservative: an entity that merely READ
// another entity re-renders when that one changes, because the engine
// cannot know which field was read. That is the right default — a
// referenced entity appearing or disappearing genuinely changes the
// output — and it means renders regularly produce identical bytes.
//
// Writing them anyway moved mtime, and three things downstream key off
// the file rather than its contents:
//
//   - mikser-io-live watches the output folder, so editing one image
//     reloaded the browser on pages that had not changed
//   - rsync, `aws s3 sync` and most CDN tools compare size plus mtime,
//     so unchanged pages re-uploaded
//   - `find out -newer` could not answer "what did this build change?"
//
// The fix is at the write (utils.writeOutput), not at the edge: it
// covers every conservative-invalidation case at once and stays correct
// as the dependency graph gets more precise, rather than becoming
// redundant.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' }, cleanUrls: false }),
        renderHbs(),
    ],
}
`

// The layout reads NOTHING out of the shared entity — the same shape as
// a render that consults an asset row and uses only a path that happened
// not to move. The $-ref makes every page depend on it regardless.
const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs': '<html><body>{{{document.content}}}</body></html>',
    'documents/shared.yml': 'version: 1\n',
    'documents/page-a.md': '---\ntitle: A\n$shared: /documents/shared\n---\nbody\n',
    'documents/page-b.md': '---\ntitle: B\n$shared: /documents/shared\n---\nbody\n',
}

describe('unchanged output is not rewritten', () => {
    const workdir = freshWorkdir('unchanged-output')
    after(() => cleanup(workdir))

    const report = async () => JSON.parse((await runMikser(workdir, ['--json'])).stdout)
    const mtimeOf = async (file) => (await stat(path.join(workdir, 'out', file))).mtimeMs

    it('cold build writes everything', async () => {
        await setupFixture(workdir, FIXTURE)
        const r = await report()
        assert.equal(r.summary.rendered, 3)
        assert.equal(r.summary.unchanged, 0)
    })

    it('a dependency change re-renders but does not touch the files', async () => {
        const before = { a: await mtimeOf('page-a.html'), b: await mtimeOf('page-b.html') }
        // Wait past filesystem mtime granularity so a rewrite would be
        // visible rather than merely likely to be.
        await new Promise(resolve => setTimeout(resolve, 20))

        await writeFile(path.join(workdir, 'documents', 'shared.yml'), 'version: 2\n')
        const r = await report()

        // The pages DID re-render — the edge is correct and this test is
        // not asking for it to be narrowed.
        const rendered = r.rendered.map(e => e.id)
        assert.ok(rendered.includes('/documents/page-a.md'))
        assert.ok(rendered.includes('/documents/page-b.md'))

        // ...and produced identical bytes, so they were left alone.
        const unchanged = r.unchanged.map(e => e.id)
        assert.ok(unchanged.includes('/documents/page-a.md'), 'page-a output was identical')
        assert.ok(unchanged.includes('/documents/page-b.md'), 'page-b output was identical')
        assert.equal(await mtimeOf('page-a.html'), before.a, 'page-a mtime must not move')
        assert.equal(await mtimeOf('page-b.html'), before.b, 'page-b mtime must not move')
    })

    it('output that really changes is still written', async () => {
        const before = await mtimeOf('page-a.html')
        await new Promise(resolve => setTimeout(resolve, 20))

        await writeFile(
            path.join(workdir, 'documents', 'page-a.md'),
            '---\ntitle: A\n$shared: /documents/shared\n---\nbody rewritten\n',
        )
        const r = await report()
        assert.ok(r.rendered.some(e => e.id === '/documents/page-a.md'))
        assert.ok(!r.unchanged.some(e => e.id === '/documents/page-a.md'))
        assert.notEqual(await mtimeOf('page-a.html'), before, 'changed output must be written')
    })

    it('a missing output file is rewritten even when the render is unchanged', async () => {
        // Deleting from the output folder must not be papered over by the
        // manifest's belief about what is on disk — the check reads the
        // file, so an absent one simply writes.
        const { rm } = await import('node:fs/promises')
        await rm(path.join(workdir, 'out', 'page-b.html'))
        await writeFile(path.join(workdir, 'documents', 'shared.yml'), 'version: 3\n')
        const r = await report()
        assert.ok(r.rendered.some(e => e.id === '/documents/page-b.md'))
        assert.ok(!r.unchanged.some(e => e.id === '/documents/page-b.md'), 'a missing file must be written')
        await stat(path.join(workdir, 'out', 'page-b.html'))
    })
})

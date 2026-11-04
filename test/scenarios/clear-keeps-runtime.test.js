// `--clear` empties the output folder and the cache, and leaves the runtime
// folder alone.
//
// It used to empty that folder too, with one exemption: `.sqlite`,
// `.sqlite-wal`, `.sqlite-shm`. The exemption was a list of what the ENGINE
// recognised, so it kept what the engine owned and deleted what it did not —
// and what it did not own was every plugin's expensive, self-validating state.
// The provider plugins' mirrors of remote content went (re-download an entire
// Drive, every blob in a repository, a whole Directus asset library), the
// drive plugin's trash went (files MOVED rather than unlinked, so a delete
// could be undone), and the layouts sidecar graph went, whose own comment
// says a catalog wipe should not cost a full re-render.
//
// `server-port` is the one the engine can be held to in its own words: "`--
// clear` removes the cache database rather than this, so asking for a cold
// rebuild does not also move the server". That was not true when it was
// written.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' }, cleanUrls: false }),
        renderHbs(),
    ],
}
`

describe('--clear and the runtime folder', () => {
    const workdir = freshWorkdir('clear-keeps-runtime')
    after(() => cleanup(workdir))

    const runtimeFile = (...parts) => path.join(workdir, 'runtime', ...parts)

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/page.md': '---\ntitle: Page\n---\nbody\n',
            'layouts/page.hbs': '<html><body>{{{document.content}}}</body></html>',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(existsSync(path.join(workdir, 'out', 'page.html')), 'the fixture should build')

        // What a plugin keeps there: a mirror of remote content with its own
        // validity marker beside it, and a trash folder holding a file that
        // was moved rather than deleted. Written by hand rather than by
        // loading a provider, because the engine's behaviour is what is under
        // test and it must not depend on which plugins happen to be installed.
        await mkdir(runtimeFile('gdrive-cache'), { recursive: true })
        await writeFile(runtimeFile('gdrive-cache', '1AbC.pdf'), 'mirrored bytes')
        await writeFile(runtimeFile('gdrive-cache', '1AbC.pdf.sha'), 'deadbeef')
        await mkdir(runtimeFile('trash', '2026-11-04'), { recursive: true })
        await writeFile(runtimeFile('trash', '2026-11-04', 'deleted.md'), 'recoverable')
        await writeFile(runtimeFile('layouts-modules.json'), '{"modules":{},"digest":""}')

        // The engine's own, which it already claims not to take.
        await writeFile(runtimeFile('server-port'), '3002')

        // And the engine's own scratch, which it does own: per-run working
        // space that nothing reads later, so whatever is in it was left by an
        // interrupted build.
        await mkdir(runtimeFile('preview'), { recursive: true })
        await writeFile(runtimeFile('preview', 'intermediate.html'), 'scratch')
        await mkdir(runtimeFile('postprocess-scratch', 'documents_page.md'), { recursive: true })
        await writeFile(runtimeFile('postprocess-scratch', 'documents_page.md', 'stage-1.html'), 'scratch')
    })

    it('keeps a plugin mirror and the marker that validates it', async () => {
        const { code, combined } = await runMikser(workdir, ['--clear'])
        assert.equal(code, 0, combined)
        assert.equal(existsSync(runtimeFile('gdrive-cache', '1AbC.pdf')), true,
            `--clear re-downloads the whole mirror\n${combined}`)
        assert.equal(existsSync(runtimeFile('gdrive-cache', '1AbC.pdf.sha')), true,
            'the marker is what makes the mirror reusable; without it the bytes are re-fetched anyway')
    })

    it('keeps files that were moved to trash so a delete could be undone', () => {
        assert.equal(existsSync(runtimeFile('trash', '2026-11-04', 'deleted.md')), true,
            'these are the user\'s own files, kept to be recoverable')
    })

    it('keeps the layouts sidecar graph and the remembered server port', async () => {
        assert.equal(existsSync(runtimeFile('layouts-modules.json')), true)
        assert.equal(await readFile(runtimeFile('server-port'), 'utf8'), '3002',
            'a cold rebuild must not also move the server — see the comment on PORT_FILE')
    })

    it('still removes its own scratch', () => {
        assert.equal(existsSync(runtimeFile('preview')), false,
            'the preview folder is engine-owned intermediate state and nothing reuses it')
        assert.equal(existsSync(runtimeFile('postprocess-scratch')), false,
            'a postprocess chain\'s intermediates are the same: left behind only by an interrupted build')
    })

    it('still clears the output folder and rebuilds it', () => {
        assert.equal(existsSync(path.join(workdir, 'out', 'page.html')), true,
            'clearing must be followed by rebuilding')
    })
})

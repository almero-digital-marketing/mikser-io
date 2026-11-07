// An aggregate page must drop an entity that was deleted while --watch runs.
//
// Reported from lmed-web on 11.24.0: a sitemap built by a sidecar
// `findEntities({ 'meta.layout': 'page', 'meta.lang': lang })` picked up a NEW
// page within one cycle, but deleting that page removed its output and left
// the sitemap untouched — no render, the URL still listed, until a restart or
// --force. Two mechanisms stand between a delete and the aggregate, and both
// match the stored query filter against the deleted ENTITY: the dispatch hint
// (manifest.queryAffected, called by the layouts plugin) and the skip gate
// (manifest.skipDecision, in the render cycle). The unlink handler journaled
// the DELETE with `{ id, type, collection }` only, so a filter on anything
// else — meta.layout, meta.lang, format — could never match, and the
// aggregate was neither dispatched nor, had it been, allowed to render.
//
// The one-shot path does not show it: the delete sweep at startup journals the
// full catalog row. aggregate-invalidation.test.js covers that one, on a
// filter the stub happened to half-satisfy.
//
// Also covered here: the folder a clean-URL page lived in. Unlinking
// `aparati/new/index.html` left `aparati/new/` behind, empty, so a static host
// went on answering /aparati/new/ with a directory instead of a 404.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setupFixture, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), yaml(), layouts({ autoLayouts: true }), renderHbs()] }
`

// The lmed sitemap's query, verbatim: nothing in it is a column the stub
// carried.
const SITEMAP_SIDECAR = `
export async function load({ entity, findEntities }) {
    const pages = await findEntities({ 'meta.layout': 'page', 'meta.lang': entity.meta.lang })
    return { urls: pages.map(page => page.name).sort() }
}
`
const SITEMAP_LAYOUT = '<urlset>{{#each data.urls}}<url>{{this}}</url>{{/each}}</urlset>'
const PAGE_LAYOUT = '<h1>{{document.meta.title}}</h1>'

const page = (title) => `---\nlayout: page\nlang: bg\ntitle: ${title}\n---\n`

const exists = (file) => stat(file).then(() => true, () => false)

describe('deleting a page while --watch runs', () => {
    const workdir = freshWorkdir('aggregate-delete-watch')
    const sitemap = () => readFile(path.join(workdir, 'out/bg/sitemap/index.html'), 'utf8')
    let child
    let output = ''

    const completions = () => (output.match(/Mikser completed/g) ?? []).length
    const waitForBuilds = async (n) => {
        for (let i = 0; i < 300; i++) {
            if (completions() >= n) return true
            await new Promise(r => setTimeout(r, 100))
        }
        return false
    }
    // What the cycle that just finished rendered — the last `Rendered: N`,
    // or 0 when the cycle printed none (a cycle with nothing to do says
    // nothing). Read from the output since the cycle began, so an earlier
    // cycle's count cannot stand in for it.
    const renderedSince = (offset) => {
        const counts = [...output.slice(offset).matchAll(/Rendered: (\d+)/g)]
        return counts.length ? Number(counts.at(-1)[1]) : 0
    }

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': PAGE_LAYOUT,
            'layouts/sitemap.hbs': SITEMAP_LAYOUT,
            'layouts/sitemap.js': SITEMAP_SIDECAR,
            'documents/bg/sitemap.md': '---\nlayout: sitemap\nlang: bg\n---\n',
            'documents/bg/aparati/rf.md': page('RF'),
        })
        child = spawn(process.execPath,
            [path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir, '--watch'],
            { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
        child.stdout.on('data', (d) => { output += d })
        child.stderr.on('data', (d) => { output += d })
        await waitForBuilds(1)
    })

    after(async () => {
        if (child?.pid) {
            try { process.kill(-child.pid, 'SIGKILL') } catch {}
        }
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        await cleanup(workdir)
    })

    it('starts with the one page listed', async () => {
        assert.ok(completions() >= 1, `the watcher never finished a build\n${output}`)
        const xml = await sitemap()
        assert.match(xml, /<url>bg\/aparati\/rf<\/url>/)
        assert.doesNotMatch(xml, /aparati\/new/)
    })

    it('lists a page added while it runs', async () => {
        const before = completions()
        const offset = output.length
        await writeFile(path.join(workdir, 'documents/bg/aparati/new.md'), page('New'))
        assert.ok(await waitForBuilds(before + 1), `adding a page started no cycle\n${output}`)
        assert.equal(renderedSince(offset), 2, `expected the new page and the sitemap\n${output.slice(offset)}`)
        assert.match(await sitemap(), /<url>bg\/aparati\/new<\/url>/)
        assert.ok(await exists(path.join(workdir, 'out/bg/aparati/new/index.html')))
    })

    it('drops a page deleted while it runs', async () => {
        const before = completions()
        const offset = output.length
        await rm(path.join(workdir, 'documents/bg/aparati/new.md'))
        assert.ok(await waitForBuilds(before + 1), `deleting a page started no cycle\n${output}`)
        assert.equal(renderedSince(offset), 1,
            `the sitemap should re-render, and only the sitemap\n${output.slice(offset)}`)
        const xml = await sitemap()
        assert.doesNotMatch(xml, /aparati\/new/, 'the sitemap still lists the deleted page')
        assert.match(xml, /<url>bg\/aparati\/rf<\/url>/, 'and it should still list the one that stayed')
    })

    it('removes the folder the deleted page lived in, and nothing above it', async () => {
        assert.equal(await exists(path.join(workdir, 'out/bg/aparati/new/index.html')), false,
            'the deleted page\'s output is still there')
        assert.equal(await exists(path.join(workdir, 'out/bg/aparati/new')), false,
            'its now-empty clean-URL folder was left behind')
        assert.ok(await exists(path.join(workdir, 'out/bg/aparati/rf/index.html')),
            'a sibling page went with it')
    })

    it('settles afterwards', async () => {
        // Touching an unrelated page proves the watcher is still cycling and
        // that the delete left nothing behind to re-dispatch.
        const before = completions()
        const offset = output.length
        await writeFile(path.join(workdir, 'documents/bg/aparati/rf.md'), page('RF, edited'))
        assert.ok(await waitForBuilds(before + 1), `editing a page started no cycle\n${output}`)
        assert.equal(renderedSince(offset), 2, `expected rf and the sitemap\n${output.slice(offset)}`)
    })
})

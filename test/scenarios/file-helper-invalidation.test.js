// A template that reads files depends on them.
//
// `glob` and `readFile` reach the filesystem from inside a render. Until they
// recorded, the snapshot's refClosure named none of what was read — so editing
// a globbed file rebuilt nothing, on a green build, and the output went stale
// with no signal anywhere. Same hole lookupHref had.
//
// This is a SCENARIO rather than a unit test on purpose. The unit tests passed
// while the feature was completely broken: the edges were being recorded
// against `uri`, which for a `files` entity is where the file was DEPLOYED,
// not its source — so every edge matched nothing. Only a real build catches
// that, because only a real build has both an entity and a manifest.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs, fileHelpers } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), files(), frontMatter(), layouts(), renderHbs(), fileHelpers()],
}
`

// Reads every stylesheet under files/styles and inlines it.
const LAYOUT = `<html><head><style>
{{#each (glob "files/styles/*.css")}}{{{readFile this}}}
{{/each}}</style></head><body>{{{document.content}}}</body></html>`

const PAGE = `---\nlayout: page\nhref: /index.html\n---\n<p>hi</p>`

const rendered = (stdout) => Number(stdout.match(/Rendered: (\d+)/)?.[1] ?? 0)
const out = (workdir) => readFile(path.join(workdir, 'out/index.html'), 'utf8')

describe('a template that globs and reads files', () => {
    const workdir = freshWorkdir('file-helpers')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/index.html': PAGE,
            'layouts/page.hbs': LAYOUT,
            'files/styles/base.css': 'body{margin:0}',
            'files/styles/hero.css': '.hero{color:red}',
        })
    })

    it('inlines what it globbed', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        const html = await out(workdir)
        assert.match(html, /margin:0/)
        assert.match(html, /color:red/)
    })

    it('re-renders when a globbed file changes', async () => {
        // The whole point. Before tracking this rebuilt nothing and left the
        // old CSS in place, with a green build and no warning.
        await writeFile(path.join(workdir, 'files/styles/hero.css'), '.hero{color:blue}')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.ok(rendered(combined) >= 1, `expected a re-render\n${combined}`)
        assert.match(await out(workdir), /color:blue/)
    })

    it('re-renders when a NEW matching file appears', async () => {
        // Why the edge records the PATTERN and not the matched paths: a list
        // of paths cannot match a file that did not exist when it was written,
        // and appearing is half of what a glob is for.
        await writeFile(path.join(workdir, 'files/styles/footer.css'), '.footer{color:green}')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(await out(workdir), /color:green/, 'the new stylesheet has to be inlined')
    })

    it('does not re-render for a file the pattern excludes', async () => {
        // Over-invalidating would be the cheap way to pass every test above.
        await writeFile(path.join(workdir, 'files/styles/notes.txt'), 'not a stylesheet')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(rendered(combined), 0, `nothing should re-render\n${combined}`)
    })

    it('re-renders when a directly-read file changes', async () => {
        await rm(path.join(workdir, 'files/styles/notes.txt'))
        await writeFile(path.join(workdir, 'layouts/page.hbs'),
            `<html><head><style>{{{readFile "files/styles/base.css"}}}</style></head><body>x</body></html>`)
        await runMikser(workdir)

        await writeFile(path.join(workdir, 'files/styles/base.css'), 'body{margin:8px}')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(await out(workdir), /margin:8px/)
    })
})

describe('reading a collection the project registered itself', () => {
    // The reported regression, at the level that would have caught it.
    //
    // The untrackable check hardcoded five content folder names, so every file
    // in a sources()-registered collection was reported as having no entity —
    // 63 warnings a build on a real site, all wrong, while the dependency
    // edges were working perfectly. The unit tests passed throughout because
    // they hand-built the options object; only a real build has a real one.
    const workdir = freshWorkdir('file-helpers-sources')
    after(() => cleanup(workdir))

    const CONFIG = `
import { documents, frontMatter, sources, renderHbs, fileHelpers } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(),
        sources({ styles: { folder: 'styles', extensions: ['css'] } }),
        layouts(), renderHbs(), fileHelpers(),
    ],
}
`

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/index.html': '---\nlayout: page\nhref: /index.html\n---\n',
            'layouts/page.hbs': '<style>{{#each (glob "styles/**/*.css")}}{{{readFile this}}}\n{{/each}}</style>',
            'styles/base.css': 'body{margin:0}',
            'styles/sections/hero.css': '.hero{color:red}',
        })
    })

    it('does not warn about files it is tracking correctly', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(/outside every folder/.test(combined), false,
            `a registered source is not untracked\n${combined}`)
    })

    it('and the edge it was warning about actually works', async () => {
        // The warning being wrong is only half of it: it claimed edits would
        // not rebuild, and they do.
        await writeFile(path.join(workdir, 'styles/sections/hero.css'), '.hero{color:blue}')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(await out(workdir), /color:blue/)
    })
})

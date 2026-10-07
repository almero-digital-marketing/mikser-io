// A module a layout sidecar imports is an INPUT to that layout.
//
// `layouts/lib/context.js` already was: the layouts plugin globs `**/*.js`
// under the layouts folder into a shared digest, that digest is part of every
// layout's checksum, and the resolve hook stamps those URLs so the new code is
// what runs. `lib/context.js` one level up — the ordinary place to put a
// helper shared with the config or a script — was neither an input nor
// reloadable. Reported from a real site: the helper was edited, the build was
// green, nothing re-rendered, a restart did not help because the catalog was
// unchanged, and `--force` was the only thing that produced the new output.
//
// The set is not globbable — it is whatever a sidecar imports — so it is
// recorded by the resolve hook as the sidecar loads, stored at the end of the
// cycle, and read back by the next scan. That is the same bargain readFile and
// glob tracking already make: an edge is learned from the run that used it and
// invalidates the run after.
//
// A separate process per build is the point here. The in-package tests cover
// what the hook records; only a real build covers whether that record survives
// to the scan that needs it.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), yaml(), layouts({ autoLayouts: true }), renderHbs()] }
`
const SIDECAR = (specifier) =>
    `import { label } from '${specifier}'\nexport async function load() { return { label } }\n`

const rendered = (combined) => Number((combined.match(/Rendered: (\d+)/) ?? [0, 0])[1])

describe('a sidecar helper OUTSIDE the layouts folder', () => {
    const workdir = freshWorkdir('sidecar-outside')
    const helper = () => path.join(workdir, 'shared/context.js')
    const page = () => readFile(path.join(workdir, 'out/a/index.html'), 'utf8')
    const build = async (args) => {
        const { code, combined } = await runMikser(workdir, args)
        assert.equal(code, 0, combined)
        return rendered(combined)
    }

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<h1>{{data.label}}</h1>',
            'layouts/page.js': SIDECAR('../shared/context.js'),
            'shared/context.js': "export const label = 'FIRST'\n",
            'documents/a.md': '---\nlayout: page\n---\n',
        })
    })
    after(async () => { await cleanup(workdir) })

    it('renders through the helper on a cold build', async () => {
        assert.equal(await build(), 1)
        assert.match(await page(), /FIRST/)
    })

    it('costs nothing to learn the helper is an input', async () => {
        // The graph is discovered during the cold build's render. If merely
        // storing it moved the digest, every project would re-render every
        // layout on its first incremental build after upgrading — twice over,
        // since the next new helper would do it again.
        assert.equal(await build(), 0, 'discovering the import graph re-rendered')
        assert.equal(await build(), 0, 'and again on the build after')
    })

    it('re-renders with the new value when the helper is edited', async () => {
        await writeFile(helper(), "export const label = 'SECOND'\n")
        assert.equal(await build(), 1)
        assert.match(await page(), /SECOND/,
            'the page was re-rendered but not with the edited helper')
    })

    it('settles again afterwards', async () => {
        assert.equal(await build(), 0)
    })

    it('needed no --force to get there', async () => {
        // The reported workaround. If it is still the only thing that works,
        // the assertions above passed for some other reason.
        await writeFile(helper(), "export const label = 'THIRD'\n")
        assert.equal(await build(), 1)
        assert.match(await page(), /THIRD/)
    })
})

describe('a sidecar helper INSIDE the layouts folder', () => {
    // The path that already worked. It is here because the fix adds a term to
    // the shared digest, and a project with no outside imports must hash
    // exactly as it did before — otherwise every site pays a full re-render
    // for a feature it does not use.
    const workdir = freshWorkdir('sidecar-inside')
    const build = async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        return rendered(combined)
    }

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<h1>{{data.label}}</h1>',
            'layouts/page.js': SIDECAR('./lib/context.js'),
            'layouts/lib/context.js': "export const label = 'FIRST'\n",
            'documents/a.md': '---\nlayout: page\n---\n',
        })
    })
    after(async () => { await cleanup(workdir) })

    it('keeps re-rendering on an edit, and stays quiet otherwise', async () => {
        assert.equal(await build(), 1)
        assert.equal(await build(), 0)
        await writeFile(path.join(workdir, 'layouts/lib/context.js'), "export const label = 'SECOND'\n")
        assert.equal(await build(), 1)
        assert.match(await readFile(path.join(workdir, 'out/a/index.html'), 'utf8'), /SECOND/)
        assert.equal(await build(), 0)
    })

    it('tracks nothing, so its layouts hash as they always did', async () => {
        await assert.rejects(
            readFile(path.join(workdir, 'runtime/layouts-modules.json'), 'utf8'),
            /ENOENT/,
            'a project whose sidecars stay inside the layouts folder must store no graph',
        )
    })
})

// Under --watch the helper is not in a watched source folder, so nothing
// starts a cycle when it changes: the digest above would catch the edit, but
// only once something else happened to trigger a build. And the stamp matters
// here and nowhere else — a long-running process has already loaded the
// module, so without it the re-render runs the copy it loaded first and
// produces the old bytes.
describe('a sidecar helper edited while --watch is running', () => {
    const workdir = freshWorkdir('sidecar-watch')
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

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<h1>{{data.label}}</h1>',
            'layouts/page.js': SIDECAR('../shared/context.js'),
            'shared/context.js': "export const label = 'FIRST'\n",
            'documents/a.md': '---\nlayout: page\n---\n',
        })
        // No build first. The watcher has to do the COLD one itself, for two
        // reasons: it is when the graph is discovered, so it also proves the
        // watcher starts following a helper it only learned about at the end
        // of the cycle — and it is what loads the sidecar, so the module is in
        // this process's registry before the edit. Pre-building leaves the
        // registry empty and the stamp does nothing, which is a test that
        // passes whether or not the reload works.
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

    it('starts and settles', () => {
        assert.ok(completions() >= 1, `the watcher never finished a build\n${output}`)
    })

    it('rebuilds the page with the new value, with nothing else touched', async () => {
        const before = completions()
        await writeFile(path.join(workdir, 'shared/context.js'), "export const label = 'WATCHED'\n")
        assert.ok(await waitForBuilds(before + 1),
            `editing the helper started no cycle\n${output}`)
        assert.match(
            await readFile(path.join(workdir, 'out/a/index.html'), 'utf8'), /WATCHED/,
            'the cycle ran but the sidecar imported the module the process loaded first',
        )
    })
})

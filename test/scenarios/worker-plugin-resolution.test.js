// A worker resolves a plugin by NAME, and the name is not always enough.
//
// The main thread reads the runtime registry, where every configured plugin
// sits under its descriptor name. A worker is another thread with another
// runtime singleton, so its registry is empty and it falls back to guessing a
// package from the name: `render-preset` means `mikser-io-render-preset`.
//
// That guess is right for every plugin whose package is named for its
// renderer, and wrong for every plugin that ships alongside other things.
// mikser-io-assets ships two — `renderPreset()` and `assetUrlHelper()` — and
// when 10.12.0 moved them out of core, both became unresolvable on a worker
// while continuing to work perfectly on the main thread.
//
// The asymmetry is what made it survive: the same layout renders correctly
// for most entities and fails for the ones dispatched to a worker. The build
// logged two red lines and exited 0, because the only entity that proved it
// was one nobody had written yet.
//
// It surfaced when Chrome was installed on the dev box. The smoke step had
// been exiting non-zero for a missing browser, so two more red lines changed
// nothing an operator looked at — the same reason worker-state-clone gives
// for its own six releases in the dark.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { assets, assetUrlHelper, renderPreset } from 'mikser-io-assets'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), files(), frontMatter(),
        assets({ assetsFolder: 'derived', presets: { web: { match: ['/files/media/**'] } } }), renderPreset(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' } }),
        renderHbs(), assetUrlHelper(),
    ],
}
`

const PRESET = [
    "import { mkdir, copyFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    'export const revision = 1',
    'export default async function web({ entity }) {',
    '    await mkdir(path.dirname(entity.destination), { recursive: true })',
    '    await copyFile(entity.source ?? entity.uri, entity.destination)',
    '}',
].join('\n')

describe('a plugin whose package is not named for it', () => {
    const workdir = freshWorkdir('worker-plugin-resolution')
    after(() => cleanup(workdir))
    let out, code

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
            'files/media/hero.jpg': 'jpeg-ish',
            // ONE layout for both pages. Whatever differs between them is the
            // dispatch, not the template.
            'layouts/page.hbs': '<html><body>ASSET[{{url (asset "web" "/media/hero.jpg")}}]</body></html>',
            'documents/main.md': '---\nhref: /main\ntitle: Main\n---\n',
            // `task: worker` is the whole experiment.
            'documents/worker.md': '---\nhref: /worker\ntitle: Worker\ntask: worker\n---\n',
        })
        const result = await runMikser(workdir)
        out = result.combined
        code = result.code
    })

    const page = (name) => readFile(path.join(workdir, 'out', name, 'index.html'), 'utf8')

    it('resolves on the worker, where the registry is empty', () => {
        assert.doesNotMatch(out, /Render plugin render-preset not found/, out)
        assert.doesNotMatch(out, /Render plugin render-asset not found/, out)
    })

    it('publishes its template helper there too', async () => {
        // The sharp end. Without the helper the render does not degrade — it
        // throws `Missing helper: "asset"` and the page is never written.
        assert.doesNotMatch(out, /Missing helper/, out)
        assert.doesNotMatch(out, /Render error/, out)
    })

    it('renders the worker page at all', async () => {
        const rendered = await page('worker')
        assert.match(rendered, /ASSET\[/, rendered)
    })

    it('renders it the same as the main thread, which is the contract', async () => {
        // Two entities, one layout, one asset. A difference here means where
        // an entity is dispatched changes what it produces.
        assert.equal(
            (await page('worker')).replace(/Worker/g, 'X'),
            (await page('main')).replace(/Main/g, 'X'))
    })

    it('exits zero, which is the signal a smoke run reads', () => {
        assert.equal(code, 0, out)
    })

    it('still produces the derivative the preset renders', async () => {
        const derived = await readFile(path.join(workdir, 'out', 'derived', 'web', 'media', 'hero.jpg'), 'utf8')
        assert.equal(derived, 'jpeg-ish')
    })
})

describe('a renderer that resolves to nothing', () => {
    const workdir = freshWorkdir('worker-plugin-missing-renderer')
    after(() => cleanup(workdir))

    it('is a fault, not an entity that quietly produces no output', async () => {
        // The half that kept the bug alive. A missing HELPER announces itself
        // through the template; a missing RENDERER was an optional call that
        // returned undefined, so the entity produced nothing and the build
        // stayed green.
        await setupFixture(workdir, {
            'mikser.config.js': `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' } }),
        renderHbs(),
    ],
}
`,
            // The extension is what names the renderer, and no plugin
            // provides this one.
            'layouts/page.nonesuch': '<html><body>nothing renders this</body></html>',
            'documents/a.md': '---\nhref: /a\ntitle: One\n---\n',
        })
        const { combined } = await runMikser(workdir)
        assert.match(combined, /Renderer "nonesuch" is not loaded/, combined)
    })
})

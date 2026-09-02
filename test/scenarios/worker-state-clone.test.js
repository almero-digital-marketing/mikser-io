// Nothing callable may live on the state a worker receives.
//
// `runtime.state` is structured-cloned into render and postprocess workers,
// and a function cannot be structured-cloned. The assets plugin published its
// missing-derivative explainer there, so from 9.83.0 every worker-dispatched
// render failed with DataCloneError on any build that loaded assets — reported
// as a render error whose message was that function's own source, which reads
// like a template problem and is not one.
//
// Options already had `workerSafeOptions` for exactly this hazard. State had
// no equivalent, which is what makes state the wrong place to publish anything
// callable, rather than something to sanitise after the fact.
//
// It was caught by the tracked fixture — mjml renders on a worker there — and
// missed for six releases because the smoke step already exited non-zero for a
// missing Chrome, so one more red line changed nothing an operator looked at.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, files, assets, frontMatter, renderHbs, assetUrlHelper } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), files(), frontMatter(),
        // The plugin whose state carried the uncloneable value.
        assets({ assetsFolder: 'derived', presets: { web: { match: ['/files/media/**'] } } }),
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

describe('a worker render on a build that loads assets', () => {
    const workdir = freshWorkdir('worker-state-clone')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
            'files/media/hero.jpg': 'jpeg-ish',
            'layouts/page.hbs': '<html><body>{{document.meta.title}}</body></html>',
            // `task: worker` is what sends this one across the thread
            // boundary, taking state with it.
            'documents/a.md': '---\nhref: /a\ntitle: One\ntask: worker\n---\n',
            'documents/b.md': '---\nhref: /b\ntitle: Two\n---\n',
        })
        const { combined } = await runMikser(workdir)
        out = combined
    })

    it('does not fail to clone the state it is handed', () => {
        assert.doesNotMatch(out, /could not be cloned/,
            `state crossing the worker boundary must hold no functions\n${out}`)
    })

    it('renders on the worker rather than reporting a render error', () => {
        assert.doesNotMatch(out, /Render error/, out)
        assert.match(out, /Mikser completed/, out)
    })

    it('exits zero, which is the signal a smoke run reads', async () => {
        // The regression was invisible because the fixture's smoke step
        // already exited non-zero for an unrelated reason. Asserted directly
        // here so it cannot hide behind someone else's failure.
        const { code, combined } = await runMikser(workdir, ['--force'])
        assert.equal(code, 0, combined)
    })

})

describe('the explainer still answers, from its new home', () => {
    const workdir = freshWorkdir('worker-state-clone-explain')
    after(() => cleanup(workdir))

    it('names the cause of a missing derivative as before', async () => {
        // Moving it off cloned state must not take the diagnostic with it.
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
            'files/media/hero.jpg': 'jpeg-ish',
            'layouts/page.hbs':
                '<html><body><img src="{{url (asset "web" "/media/absent.jpg")}}"></body></html>',
            'documents/a.md': '---\nhref: /a\ntitle: One\ntask: worker\n---\n',
        })
        const { combined } = await runMikser(workdir)
        assert.match(combined, /No derivative was produced:.*no source file is named/, combined)
    })
})

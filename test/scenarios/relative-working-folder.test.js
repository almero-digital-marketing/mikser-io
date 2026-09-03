// The second CLI parse must not undo what the engine already normalised.
//
// `--working-folder` carries commander's default of './'. The engine
// resolves it to an absolute path in onInitialize, and every plugin that
// resolves its own folder does so against that value — schemas, presets and
// layout sidecars all join it and hand the result to import().
//
// Stage two of the parse used to re-assign the whole opts() blob, which put
// the raw './' back AFTER the load phase. path.join('./', 'schemas') is
// 'schemas', and a specifier with no leading ./ is a BARE specifier, so
// import() went looking for an npm package:
//
//   Schema footer: load failed: Cannot find package 'schemas'
//       imported from node_modules/mikser-io-schemas/index.js
//   Layout sidecar layouts/page.js failed to load: Cannot find package 'layouts'
//
// A clean build, exit 0 from the engine's point of view, and every
// project-loaded module silently missing.
//
// It survived 891 tests because runMikser always passes an absolute
// --working-folder. Nothing exercised the default until this test.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikserInPlace, cleanup, freshWorkdir } from './_harness.js'

// Reports the value at the moment plugins actually resolve their folders:
// in onLoaded, after the whole load phase has run.
const PROBE = `
import { cliOption } from 'mikser-io'
export function probe() {
    return ({ runtime, onLoaded, useLogger }) => {
        cliOption('--probe-flag [name]', 'so stage two has something of its own to do')
        onLoaded(() => {
            useLogger().warn({ code: 'probe-wf' }, 'workingFolder=%s', runtime.options.workingFolder)
        })
        return { collection: 'probe', type: 'probe' }
    }
}
`
const FILES = {
    'mikser.config.js': `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { probe } from './probe.js'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs(), probe()] }
`,
    'probe.js': PROBE,
    'layouts/page.js': 'export default { load: async () => ({ ok: true }) }\n',
    'layouts/page.html.hbs': '<!doctype html><body>x</body>',
    'documents/index.html': '---\nlayout: page\n---\n',
}

describe('a working folder left at its default', () => {
    const workdir = freshWorkdir('relwf')
    after(() => cleanup(workdir))
    before(async () => { await setupFixture(workdir, FILES) })

    it('is still absolute once the load phase is over', async () => {
        const { combined } = await runMikserInPlace(workdir, ['--force', '--probe-flag'])
        const line = combined.split('\n').find(l => l.includes('workingFolder='))
        assert.ok(line, `the probe never reported\n${combined}`)
        const value = line.slice(line.indexOf('workingFolder=') + 'workingFolder='.length).trim()
        assert.notEqual(value, './', 'the second parse put the raw default back')
        assert.ok(value.startsWith('/'),
            `plugins resolve their folders against this; relative makes bare specifiers: ${value}`)
    })

    it('lets a plugin load a file from the project', async () => {
        const { combined } = await runMikserInPlace(workdir, ['--force'])
        assert.ok(!/Cannot find package/.test(combined),
            `a project path reached import() as a bare specifier\n${combined}`)
        assert.ok(!/failed to load/.test(combined), `a project module did not load\n${combined}`)
    })
})

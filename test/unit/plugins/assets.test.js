import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import assetsPlugin from '../../../src/plugins/assets.js'
import { createHarness } from '../plugin-harness.js'

// Spin up a temp workingFolder with an optional npm preset package and
// optional local preset file, run the assets plugin through onLoaded +
// onImport, and hand the harness back for assertions. Cleans up the
// temp dir afterward.
async function withPresetProject({ npmPresets = {}, localPresets = {}, config }, fn) {
    const workingFolder = await mkdtemp(path.join(tmpdir(), 'mikser-presets-'))
    try {
        // Lay down npm-style packages under node_modules.
        for (const [name, mod] of Object.entries(npmPresets)) {
            const pkgDir = path.join(workingFolder, 'node_modules', `mikser-io-preset-${name}`)
            await mkdir(pkgDir, { recursive: true })
            await writeFile(path.join(pkgDir, 'package.json'),
                JSON.stringify({ name: `mikser-io-preset-${name}`, version: '1.0.0', type: 'module', main: 'index.js' }))
            await writeFile(path.join(pkgDir, 'index.js'), mod)
        }
        // Lay down local presets/<name>.js files.
        if (Object.keys(localPresets).length) {
            await mkdir(path.join(workingFolder, 'presets'), { recursive: true })
            for (const [name, mod] of Object.entries(localPresets)) {
                await writeFile(path.join(workingFolder, 'presets', `${name}.js`), mod)
            }
        }

        const h = createHarness({
            options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            config,
        })
        assetsPlugin(h.core)
        await h.runHook('loaded')
        await h.runHook('import')
        return await fn(h)
    } finally {
        await rm(workingFolder, { recursive: true, force: true })
    }
}

// A preset module body with distinctive exports and no native deps
// (no sharp/ffmpeg import) so the test can run anywhere and assert on
// the values that flowed through.
const presetModule = ({ revision, format }) =>
    `export const revision = ${revision}\n` +
    `export const format = '${format}'\n` +
    `export const options = { checksum: false }\n` +
    `export default () => {}\n`

describe('assets plugin: preset resolution', () => {
    it('loads a preset from an npm package (mikser-io-preset-<name>) when no local file exists', async () => {
        await withPresetProject({
            npmPresets: { thumbnail: presetModule({ revision: 7, format: 'avif' }) },
            config: { assets: { presets: { thumbnail: ['/files/**/*.jpg'] } } },
        }, (h) => {
            const created = h.journal.find(e => e.operation === 'create' && e.entity?.id === '/presets/thumbnail')
            assert.ok(created, 'expected a preset entity created for the npm-resolved thumbnail')
            // Values came through the package's exports.
            assert.equal(created.entity.format, 'avif')
            assert.equal(created.entity.checksum, 7)          // revision → checksum
            assert.deepEqual(created.entity.options, { checksum: false })
            // uri points at the npm package, not the (nonexistent) local file.
            assert.match(created.entity.uri, /node_modules[\\/]mikser-io-preset-thumbnail/)
            // State map is populated under the bare name.
            assert.ok(h.runtime.state.assets.presets.thumbnail)
        })
    })

    it('prefers a local presets/<name>.js over an npm package of the same name', async () => {
        await withPresetProject({
            localPresets: { thumbnail: presetModule({ revision: 1, format: 'webp' }) },   // local
            npmPresets:   { thumbnail: presetModule({ revision: 9, format: 'avif' }) },   // npm — should be ignored
            config: { assets: { presets: { thumbnail: ['/files/**/*.jpg'] } } },
        }, (h) => {
            const created = h.journal.filter(e => e.operation === 'create' && e.entity?.id === '/presets/thumbnail')
            assert.equal(created.length, 1, 'preset should be loaded exactly once')
            // Local values win: webp/1, not avif/9.
            assert.equal(created[0].entity.format, 'webp')
            assert.equal(created[0].entity.checksum, 1)
            assert.match(created[0].entity.uri, /[\\/]presets[\\/]thumbnail\.js$/)
            assert.doesNotMatch(created[0].entity.uri, /node_modules/)
        })
    })

    it('logs an error and skips a configured preset that resolves to neither local nor npm', async () => {
        await withPresetProject({
            config: { assets: { presets: { ghost: ['/files/**/*.jpg'] } } },
        }, (h) => {
            const created = h.journal.find(e => e.operation === 'create' && e.entity?.id === '/presets/ghost')
            assert.equal(created, undefined, 'unresolvable preset should not create an entity')
            const errored = h.logs.some(l => l.level === 'error' && l.args.join(' ').includes('Preset not found'))
            assert.ok(errored, 'should log a "Preset not found" error')
        })
    })
})

describe('assets plugin', () => {
    // The plugin's npm-facing name is "assets" but internally it tracks
    // transformed assets under the "presets" collection. Worth documenting
    // explicitly because the dual naming is easy to miss.
    it('returns its (internal) collection identifier', () => {
        const h = createHarness()
        const api = assetsPlugin(h.core)
        assert.equal(api.collection, 'presets')
        assert.equal(api.type, 'preset')
    })

    it('registers the expected hooks', () => {
        const h = createHarness()
        assetsPlugin(h.core)
        assert.ok(h.hooks.loaded.length >= 1)
        assert.ok(h.hooks.import.length >= 1)
        assert.ok(h.hooks.processed.length >= 1)
        assert.ok(h.hooks.beforeRender.length >= 1)
        assert.ok(h.hooks.complete.length >= 1)
        assert.ok(h.hooks.finalize.length >= 1)
        assert.ok(h.sync.has('presets'))
    })
})

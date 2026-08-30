// What this mikser is made of.
//
// A session can see what it may write and nothing about the machine doing the
// writing. A capability like `drive:layouts` means little until you know a
// plugin called mikser-io-drive exists and what it does.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import { inventory } from '../../src/inventory.js'

let dir
const pkg = async (name, manifest) => {
    await mkdir(path.join(dir, 'node_modules', name), { recursive: true })
    await writeFile(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify(manifest))
}

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-inv-'))
    await pkg('mikser-io', { name: 'mikser-io', version: '9.0.0', description: 'The engine.' })
    await pkg('mikser-io-drive', {
        name: 'mikser-io-drive', version: '0.14.0', description: 'WebDAV for mikser-io.',
        homepage: 'https://github.com/almero/mikser-io-drive#readme',
        repository: { type: 'git', url: 'git+https://github.com/almero/mikser-io-drive.git' },
    })
    await pkg('mikser-io-render-liquid', { name: 'mikser-io-render-liquid', version: '5.0.0' })
    await pkg('mikser-io-git', { name: 'mikser-io-git', version: '2.8.0', repository: 'almero/mikser-io-git' })
    // Not a mikser package: must not appear.
    await pkg('lodash', { name: 'lodash', version: '4.0.0', description: 'Not ours.' })
})
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

beforeEach(() => {
    runtime.routes = []
    runtime.renderers = new Map()
    runtime.postprocessors = new Map()
    runtime.options = { ...runtime.options, workingFolder: dir, layouts: undefined, preview: undefined }
})

describe('the plugin inventory', () => {
    it('lists the mikser packages and nothing else', () => {
        const names = inventory().map(p => p.name)
        assert.deepEqual(names, ['mikser-io', 'mikser-io-drive', 'mikser-io-git', 'mikser-io-render-liquid'])
        assert.ok(!names.includes('lodash'), 'a dependency that is not a plugin is not part of this system')
    })

    it('carries the purpose and the links from the package itself', () => {
        // Derived, not declared: a second hand-written summary would drift,
        // and the first time it drifted it would describe a plugin that had
        // changed underneath it.
        const drive = inventory().find(p => p.name === 'mikser-io-drive')
        assert.equal(drive.summary, 'WebDAV for mikser-io.')
        assert.equal(drive.version, '0.14.0')
        assert.equal(drive.repository, 'https://github.com/almero/mikser-io-drive',
            'a git+https url is normalised to something a reader can open')
        assert.equal(drive.npm, 'https://www.npmjs.com/package/mikser-io-drive')
    })

    it('normalises a shorthand repository too', () => {
        assert.equal(inventory().find(p => p.name === 'mikser-io-git').repository,
            'https://github.com/almero/mikser-io-git')
    })

    it('omits what a package does not declare rather than inventing it', () => {
        const liquid = inventory().find(p => p.name === 'mikser-io-render-liquid')
        assert.equal(liquid.summary, undefined)
        assert.equal(liquid.repository, undefined)
        assert.equal(liquid.version, '5.0.0')
    })

    it('marks the plugins that are actually running', () => {
        // Installed and active are different facts. An agent told a plugin is
        // present will look for a feature that is not switched on.
        runtime.routes = [{ plugin: 'drive', path: '/drive' }]
        runtime.renderers = new Map([['liquid', {}]])
        const active = inventory().filter(p => p.active).map(p => p.name)
        assert.deepEqual(active.sort(), ['mikser-io', 'mikser-io-drive', 'mikser-io-render-liquid'])
        assert.equal(inventory().find(p => p.name === 'mikser-io-git').active, undefined,
            'installed but not loaded — and absent rather than false, which would be a claim')
    })

    it('says nothing when there is nothing to read', () => {
        runtime.options = { ...runtime.options, workingFolder: path.join(tmpdir(), 'no-such-folder-here') }
        assert.deepEqual(inventory(), [])
    })
})

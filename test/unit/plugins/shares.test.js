import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { shares } from '../../../src/plugins/shares.js'
import { createHarness } from '../plugin-harness.js'

describe('shares plugin', () => {
    it('registers onLoaded', () => {
        const h = createHarness()
        shares({ locations: [] })(h.core)
        assert.equal(h.hooks.loaded.length, 1)
    })

    it('is a no-op when no shares are configured', async () => {
        const h = createHarness()
        shares()(h.core)
        await assert.doesNotReject(() => h.runHook('loaded'))
    })

    it('symlinks each configured source into outputFolder', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-shares-'))
        try {
            const workingFolder = dir
            const outputFolder = path.join(dir, 'out')
            const shared = path.join(dir, 'public')
            await mkdir(shared, { recursive: true })
            await mkdir(outputFolder, { recursive: true })
            await writeFile(path.join(shared, 'README.md'), 'shared')

            const h = createHarness({
                options: { workingFolder, outputFolder },
            })
            shares({ locations: ['public'] })(h.core)
            await h.runHook('loaded')

            const link = await readlink(path.join(outputFolder, 'public'))
            assert.ok(link.includes('public'))
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

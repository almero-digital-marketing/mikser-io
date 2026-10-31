import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { shares } from '../../../src/plugins/shares.js'
import { createHarness } from '../plugin-harness.js'
import realRuntime from '../../../src/runtime.js'

// A working folder with `public/` and `vendor/` to share, and an output
// folder. Each load is a fresh harness, as each start of mikser is a fresh
// process: only the disk carries over.
async function folder() {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-shares-'))
    for (const name of ['public', 'vendor', 'out', 'runtime']) await mkdir(path.join(dir, name), { recursive: true })
    await writeFile(path.join(dir, 'public', 'README.md'), 'shared')
    await writeFile(path.join(dir, 'vendor', 'lib.js'), 'vendor')
    const load = async (locations) => {
        const h = createHarness({
            options: { workingFolder: dir, outputFolder: path.join(dir, 'out'), runtimeFolder: path.join(dir, 'runtime') },
        })
        shares({ locations })(h.core)
        await h.runHook('loaded')
        return h
    }
    const linkAt = async (name) => {
        try { return await readlink(path.join(dir, 'out', name)) } catch { return null }
    }
    return { dir, load, linkAt, done: () => rm(dir, { recursive: true, force: true }) }
}

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
        const f = await folder()
        try {
            await f.load(['public', { source: 'vendor', destination: 'assets/vendor' }])
            assert.equal(await f.linkAt('public'), path.join(f.dir, 'public'))
            assert.equal(await f.linkAt('assets/vendor'), path.join(f.dir, 'vendor'))
        } finally {
            await f.done()
        }
    })

    // The source is still there, so the link is not broken and finalize's
    // sweep of broken links would never remove it.
    it('removes the link of a share taken out of the config', async () => {
        const f = await folder()
        try {
            await f.load(['public', { source: 'vendor', destination: 'vendor' }])
            const h = await f.load(['public'])
            assert.equal(await f.linkAt('vendor'), null)
            assert.equal(await f.linkAt('public'), path.join(f.dir, 'public'))
            assert.ok(h.logs.some(({ level, args }) => level == 'info' && String(args[0]).startsWith('Share removed')))
        } finally {
            await f.done()
        }
    })

    it('removes nothing it did not make', async () => {
        const f = await folder()
        try {
            await f.load(['public'])
            // Another plugin's link into the same output folder.
            await symlink(path.join(f.dir, 'vendor'), path.join(f.dir, 'out', 'other'), 'dir')
            await f.load([])
            assert.equal(await f.linkAt('public'), null)
            assert.equal(await f.linkAt('other'), path.join(f.dir, 'vendor'))
        } finally {
            await f.done()
        }
    })

    it('leaves a path alone that is no longer the link it made', async () => {
        const f = await folder()
        try {
            await f.load(['public'])
            await rm(path.join(f.dir, 'out', 'public'))
            await writeFile(path.join(f.dir, 'out', 'public'), 'a page')
            await f.load([])
            assert.equal(await readFile(path.join(f.dir, 'out', 'public'), 'utf8'), 'a page')
        } finally {
            await f.done()
        }
    })

    it('points a share at its new source', async () => {
        const f = await folder()
        try {
            await f.load([{ source: 'public', destination: 'static' }])
            await f.load([{ source: 'vendor', destination: 'static' }])
            assert.equal(await f.linkAt('static'), path.join(f.dir, 'vendor'))
            // And takes it back later as its own.
            await f.load([])
            assert.equal(await f.linkAt('static'), null)
        } finally {
            await f.done()
        }
    })

    it('warns, and replaces nothing, when the destination is not a link', async () => {
        const f = await folder()
        try {
            await mkdir(path.join(f.dir, 'out', 'public'))
            const h = await f.load(['public'])
            assert.ok((await lstat(path.join(f.dir, 'out', 'public'))).isDirectory())
            assert.ok(h.logs.some(({ level, args }) => level == 'warn' && String(args[0]).startsWith('Not shared')))
        } finally {
            await f.done()
        }
    })

    it('keeps the record out of the cache, in the runtime folder', async () => {
        const f = await folder()
        try {
            await f.load(['public'])
            const record = JSON.parse(await readFile(path.join(f.dir, 'runtime', 'shares.json'), 'utf8'))
            assert.deepEqual(record, { [path.join(f.dir, 'out', 'public')]: path.join(f.dir, 'public') })
        } finally {
            await f.done()
        }
    })

    it('takes nothing back on a run that only answers a question', async () => {
        const f = await folder()
        const options = realRuntime.options
        try {
            await f.load(['public'])
            realRuntime.options = { ...options, tool: 'explain' }
            await f.load([])
            realRuntime.options = options
            assert.equal(await f.linkAt('public'), path.join(f.dir, 'public'))
            // The record is unchanged too, so the build after still knows it.
            await f.load([])
            assert.equal(await f.linkAt('public'), null)
        } finally {
            realRuntime.options = options
            await f.done()
        }
    })
})

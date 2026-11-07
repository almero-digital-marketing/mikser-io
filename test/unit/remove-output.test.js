// Removing an output takes the folders it empties with it, and nothing else.
//
// A clean-URL page lives in a folder of its own, so unlinking the page alone
// left that folder behind, empty, for a static host to answer with a listing
// or a 403 instead of a 404.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { removeOutput } from '../../src/utils/output.js'

const exists = (file) => stat(file).then(() => true, () => false)

describe('removeOutput', () => {
    let root, out
    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-remove-output-'))
        out = path.join(root, 'out')
        await mkdir(out)
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    const put = async (relative) => {
        const file = path.join(out, relative)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, 'x')
    }

    it('takes the folders the file leaves empty', async () => {
        await put('bg/aparati/new/index.html')
        assert.equal(await removeOutput(out, '/bg/aparati/new/index.html'), true)
        assert.equal(await exists(path.join(out, 'bg')), false)
        assert.ok(await exists(out), 'the output folder itself is never removed')
    })

    it('stops at the first folder that still holds something', async () => {
        await put('bg/aparati/new/index.html')
        await put('bg/aparati/rf/index.html')
        await removeOutput(out, '/bg/aparati/new/index.html')
        assert.equal(await exists(path.join(out, 'bg/aparati/new')), false)
        assert.ok(await exists(path.join(out, 'bg/aparati/rf/index.html')))
    })

    it('leaves a folder holding something it did not write', async () => {
        // A share, a file another tool put there: rmdir refuses either.
        await put('bg/aparati/new/index.html')
        await symlink(path.join(root, 'elsewhere'), path.join(out, 'bg/aparati/new/brochure.pdf'))
        await removeOutput(out, '/bg/aparati/new/index.html')
        assert.ok(await exists(path.join(out, 'bg/aparati/new')))
    })

    it('still prunes when the file was already gone', async () => {
        await mkdir(path.join(out, 'bg/aparati/new'), { recursive: true })
        assert.equal(await removeOutput(out, '/bg/aparati/new/index.html'), false)
        assert.equal(await exists(path.join(out, 'bg')), false)
    })

    it('removes a file at the root without touching the root', async () => {
        await put('sitemap.xml')
        assert.equal(await removeOutput(out, '/sitemap.xml'), true)
        assert.ok(await exists(out))
    })

    it('never reaches outside the output folder', async () => {
        await writeFile(path.join(root, 'keep.txt'), 'x')
        assert.equal(await removeOutput(out, '/../keep.txt'), false)
        assert.ok(await exists(path.join(root, 'keep.txt')))
    })
})

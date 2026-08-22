// Tests for the files() plugin's sync path.
//
// files() had no test coverage at all, which is how two bugs sat in the
// same three lines of its ACTION.UPDATE branch:
//
//   1. `name: relativePath` instead of `name`. The prelude computes
//      `name` with the outputFolder prefix and CREATE uses it; UPDATE
//      dropped it, while `meta.url` on the next line kept it. The assets
//      plugin builds preset destinations from `name`, so a file replaced
//      under watch had its derivatives written to a different path than
//      the same file freshly imported — and meta.presets recorded the
//      wrong one, producing 404s for pages using the asset.
//
//   2. `current?.checksum != checksum` compared the stored checksum
//      string against the checksum FUNCTION from the plugin context.
//      Never equal, so the guard always passed, every sync re-emitted
//      the entity, and the `synced = false` branch was unreachable.
//
// Both only show on the sync (watch) path, never on a cold import, which
// is why a full build looked correct. These drive onSync directly rather
// than running a watcher.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { files } from '../../src/plugins/files.js'
import { createHarness } from './plugin-harness.js'

// One real file on disk: onSync checksums and lstats the source, so it
// cannot be faked out with a stub path.
async function makeWorkdir() {
    const root = await mkdtemp(path.join(tmpdir(), 'mikser-files-plugin-'))
    await mkdir(path.join(root, 'files', 'cosmetics'), { recursive: true })
    await mkdir(path.join(root, 'out'), { recursive: true })
    await writeFile(path.join(root, 'files', 'cosmetics', 'bg.jpg'), 'original-bytes')
    return root
}

// Build the harness with the folder options files() reads, install the
// plugin, and hand back a driver for its sync handler.
function install(root, options) {
    // The harness's findEntity reads this array by reference, so pushing
    // into it is how a test says "the catalog already knows this entity".
    const entities = []
    const harness = createHarness({
        entities,
        options: {
            workingFolder: root,
            filesFolder:   path.join(root, 'files'),
            outputFolder:  path.join(root, 'out'),
        },
    })
    files(options)(harness.core)
    return { ...harness, entities }
}

const RELATIVE = 'cosmetics/bg.jpg'

describe('files() sync path', () => {
    let root
    before(async () => { root = await makeWorkdir() })
    after(async () => { await rm(root, { recursive: true, force: true }) })

    // The configuration this matters for: media served under a single
    // /media/ prefix so asset folders cannot shadow page routes.
    const OPTIONS = { outputFolder: 'media' }

    it('CREATE carries the outputFolder prefix in name', async () => {
        const h = install(root, OPTIONS)
        await h.runSync('files', {
            action: h.constants.ACTION.CREATE,
            context: { relativePath: RELATIVE },
        })
        const entry = h.journal.at(-1)
        assert.equal(entry.operation, 'create')
        assert.equal(entry.entity.name, path.join('media', RELATIVE))
        assert.equal(entry.entity.meta.url, '/' + path.join('media', RELATIVE))
    })

    it('UPDATE carries the same prefix as CREATE', async () => {
        const h = install(root, OPTIONS)
        await h.runSync('files', {
            action: h.constants.ACTION.UPDATE,
            context: { relativePath: RELATIVE },
        })
        const entry = h.journal.at(-1)
        assert.equal(entry.operation, 'update')
        // The regression: this was `cosmetics/bg.jpg`, so the derivative
        // path moved and meta.url disagreed with name.
        assert.equal(entry.entity.name, path.join('media', RELATIVE))
        assert.equal(
            entry.entity.meta.url, '/' + entry.entity.name,
            'meta.url and name must describe the same served path',
        )
    })

    it('UPDATE skips when the checksum is unchanged', async () => {
        // Seed the catalog with the entity as it is on disk, then sync
        // without touching the file. A correct guard reports not-synced.
        const h = install(root, OPTIONS)
        await h.runSync('files', {
            action: h.constants.ACTION.CREATE,
            context: { relativePath: RELATIVE },
        })
        const created = h.journal.at(-1).entity
        h.entities.push(created)

        const before = h.journal.length
        const synced = await h.runSync('files', {
            action: h.constants.ACTION.UPDATE,
            context: { relativePath: RELATIVE },
        })
        assert.equal(synced, false, 'unchanged file must report not-synced')
        assert.equal(h.journal.length, before, 'unchanged file must emit no journal entry')
    })

    it('UPDATE fires when the bytes actually change', async () => {
        const h = install(root, OPTIONS)
        await h.runSync('files', {
            action: h.constants.ACTION.CREATE,
            context: { relativePath: RELATIVE },
        })
        const created = h.journal.at(-1).entity
        h.entities.push(created)

        await writeFile(path.join(root, 'files', RELATIVE), 'quite-different-bytes-here')
        const before = h.journal.length
        const synced = await h.runSync('files', {
            action: h.constants.ACTION.UPDATE,
            context: { relativePath: RELATIVE },
        })
        assert.notEqual(synced, false)
        assert.equal(h.journal.length, before + 1)
        assert.notEqual(h.journal.at(-1).entity.checksum, created.checksum)
    })

    it('without outputFolder, name is the plain relative path', async () => {
        const h = install(root, {})
        await h.runSync('files', {
            action: h.constants.ACTION.UPDATE,
            context: { relativePath: RELATIVE },
        })
        const entity = h.journal.at(-1).entity
        assert.equal(entity.name, RELATIVE)
        assert.equal(entity.meta.url, '/' + RELATIVE)
    })
})

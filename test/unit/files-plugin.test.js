// Tests for the files() plugin's sync path.
//
// Two invariants of its ACTION.UPDATE branch, both invisible on a cold
// import and observable only on the sync (watch) path — which is why a
// full build can look correct while either is broken:
//
//   1. `name` must carry the outputFolder prefix, as CREATE's does and as
//      `meta.url` on the next line does. Using `relativePath` instead
//      drops it, and the assets plugin builds preset destinations from
//      `name` — so a file replaced under watch gets its derivatives
//      written somewhere else than a fresh import's, with meta.presets
//      recording the wrong path and pages 404ing on the asset.
//
//   2. The guard must compare against `await checksum(source)`, not the
//      `checksum` FUNCTION from the plugin context. A string is never
//      equal to a function, so the guard always passes, every sync
//      re-emits the entity, and `synced = false` is unreachable.
//
// These drive onSync directly rather than running a watcher.

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

    // `id` and `uri` mean DIFFERENT things here, and the difference is
    // load-bearing for anything asking "which file is this?".
    //
    // A file entity is served by symlinking the source into the output
    // folder, and `uri` is that symlink — under outputFolder, moving when
    // `options.outputFolder` changes. For a document or a layout `uri` is the
    // source file, so the meaning is not consistent across collections and
    // `uri` cannot be used to identify a source.
    //
    // `id` can: it is always `/<collection>/<path under the source folder>`.
    // The render helpers (readFile / glob in src/plugins/render/file.js) key
    // their dependency edges on it for exactly this reason — keyed on uri they
    // recorded edges that matched nothing, on a green build.
    it('ids the source, uris the served copy — they are not interchangeable', async () => {
        const h = install(root, OPTIONS)
        await h.runSync('files', {
            action: h.constants.ACTION.CREATE,
            context: { relativePath: RELATIVE },
        })
        const { entity } = h.journal.at(-1)

        assert.equal(entity.id, '/files/' + RELATIVE.split(path.sep).join('/'),
            'the id names the file under its source folder')
        assert.ok(entity.uri.includes('media'),
            'the uri is the served copy, under the configured output prefix')
        assert.notEqual(entity.id, entity.uri)
        assert.equal(entity.uri.includes(path.join('files', RELATIVE)), false,
            'and it is NOT the source path — an edge matching on uri finds nothing')
    })

    it('keeps the same id when the served location moves', async () => {
        // Changing outputFolder relocates the symlink and therefore the uri.
        // Anything that identified the file by uri breaks; the id does not
        // move, which is what makes it the safe key.
        const plain = install(root, {})
        await plain.runSync('files', {
            action: plain.constants.ACTION.CREATE,
            context: { relativePath: RELATIVE },
        })
        const bare = plain.journal.at(-1).entity

        const prefixed = install(root, OPTIONS)
        await prefixed.runSync('files', {
            action: prefixed.constants.ACTION.CREATE,
            context: { relativePath: RELATIVE },
        })
        const moved = prefixed.journal.at(-1).entity

        assert.equal(bare.id, moved.id, 'the id is stable across output layouts')
        assert.notEqual(bare.uri, moved.uri, 'the uri is not')
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

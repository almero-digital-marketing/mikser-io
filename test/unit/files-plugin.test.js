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

    // `uri` names the SOURCE file, the same as in every other collection.
    //
    // It used to be the symlink in the output — so `uri` meant the source for
    // a document and the destination for a file, and three separate places
    // carry scars from that. The render helpers key their dependency edges on
    // `id` with a comment explaining that a uri edge "matches nothing" for
    // exactly the case they are most used for; locateEntityFile rejected every
    // file entity as living outside its own collection folder; and
    // sweepDeleted could not be called at all, because it scopes by uri rooted
    // at the folder a source owns, which left deleted files in the catalog and
    // dangling symlinks in the output forever.
    //
    // `id` is still the stable key — `/<collection>/<path under the source
    // folder>`, unmoved by output layout. Where the bytes are PUBLISHED is
    // meta.url.
    it('uris the source, and names the published copy in meta.url', async () => {
        const h = install(root, OPTIONS)
        await h.runSync('files', {
            action: h.constants.ACTION.CREATE,
            context: { relativePath: RELATIVE },
        })
        const { entity } = h.journal.at(-1)

        assert.equal(entity.id, '/files/' + RELATIVE.split(path.sep).join('/'),
            'the id names the file under its source folder')
        assert.ok(entity.uri.includes(path.join('files', RELATIVE)),
            `the uri is the source file, so a uri-scoped sweep can own it: ${entity.uri}`)
        assert.equal(entity.uri.includes(path.join('out', 'media')), false,
            'and it is NOT the served copy any more')
        assert.equal(entity.uri, entity.source, 'source and uri agree')
        assert.equal(entity.meta.url, '/media/' + RELATIVE.split(path.sep).join('/'),
            'the published location is meta.url, which is what consumers read')
    })

    it('keeps both id and uri stable when the served location moves', async () => {
        // Changing outputFolder relocates the symlink and the served url. It
        // does not move the source, so neither the id nor the uri moves —
        // which is what makes a uri-scoped sweep safe across output layouts.
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
        assert.equal(bare.uri, moved.uri, 'and so is the uri, now that it names the source')
        assert.notEqual(bare.meta.url, moved.meta.url, 'what moves is the published url')
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

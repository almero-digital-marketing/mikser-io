// A DELETE journalled after the persist drain must still land — in the catalog,
// in the manifest, and on disk.
//
// The catalog used to drain the journal only at onPersist, which runs BEFORE
// render. Anything a render or a post-render hook journalled arrived after the
// only pass that would have applied it, and onFinalized's clearJournal() then
// discarded it unread. The manifest never had this problem — it drains at
// onFinalize — so the two disagreed about what existed.
//
// The visible symptom was `catalog: false` pruning that silently did nothing: a
// render opting out of the catalog journals its DELETE once the render
// resolves, which is past persist. gpoint's cms ran that path for every
// notification mail and accumulated 1,134 scratch entities carrying 86 MB of
// render payload, which took its public endpoint from 70ms to 8-15s and served
// blank pages until the catalog was purged.
//
// A second bug sat behind it: the manifest drains DELETE and RENDER separately
// and applied both in one transaction, deleting the snapshot and then
// re-inserting it from the render entry a few statements later. An entity
// rendered and deleted in the same cycle kept its snapshot forever.
//
// This drives the journal helper directly from onPersisted rather than going
// through a transient render. Same structural position — after the persist
// drain, same cycle as the entity's own RENDER entry — with none of the
// layout-assignment machinery in between, so a failure here is unambiguous.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup, freshWorkdir,
    readCatalog, readManifest,
} from './_harness.js'

// `doomed` is deleted after persist; `kept` is the control. Without the
// control, a drain that wiped everything would satisfy every other assertion
// in this file.
const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'

function deleteAfterPersist() {
    return (core) => {
        core.onPersisted(async () => {
            // The minimal shape deleteEntity documents as sufficient.
            await core.deleteEntity({
                id: '/documents/doomed.html',
                type: 'document',
                collection: 'documents',
            })
        })
    }
}

export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ autoLayouts: true }), renderHbs(),
        deleteAfterPersist(),
    ],
}
`

const NOTE_LAYOUT = '<p>{{document.meta.message}}</p>'

describe('a DELETE journalled after persist still lands', () => {
    const workdir = freshWorkdir('post-persist-delete')
    let catalog, manifest, build

    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/doomed.html': '---\nlayout: note\nmessage: doomed\n---\n',
            'documents/kept.html': '---\nlayout: note\nmessage: kept\n---\n',
            'layouts/note.hbs': NOTE_LAYOUT,
        })
        build = await runMikser(workdir)
        catalog = await readCatalog(workdir)
        manifest = await readManifest(workdir)
    })

    it('builds cleanly', () => {
        assert.equal(build.code, 0, build.combined)
    })

    it('drops the catalog row', () => {
        assert.deepEqual(
            catalog.entities.filter((e) => e.id.includes('doomed')).map((e) => e.id),
            [],
            'a DELETE past the persist drain must still apply — this is the 86 MB leak',
        )
    })

    it('drops the manifest snapshot with it', () => {
        assert.deepEqual(
            manifest.filter((s) => s.id.includes('doomed')).map((s) => s.id),
            [],
            'the entity was rendered AND deleted this cycle; the DELETE has to win',
        )
    })

    it('unlinks the output file', () => {
        assert.equal(
            existsSync(path.join(workdir, 'out', 'doomed.html')),
            false,
            'the manifest unlinks outputs for deleted entities',
        )
    })

    it('leaves the untouched entity alone', () => {
        assert.ok(
            catalog.entities.some((e) => e.id.includes('kept')),
            'the control lost its catalog row — the drain is deleting too much',
        )
        assert.ok(
            manifest.some((s) => s.id.includes('kept')),
            'the control lost its snapshot',
        )
        assert.ok(
            existsSync(path.join(workdir, 'out', 'kept.html')),
            'the control lost its output file',
        )
    })
})

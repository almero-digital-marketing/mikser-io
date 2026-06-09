// Integration tests for the source.js checksum gate + delete sweep +
// catalog persistence + cache invalidation, exercising real cycle
// boundaries (spawn mikser fresh, mutate disk, spawn again).
//
// The cycle costs ~1-2s per spawn so each test runs 2-3 mikser
// invocations. Tolerable. See _harness.js for the rationale around
// subprocess-vs-in-process.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, appendFile, rm, rename, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup, readManifest, readCatalog,
    freshWorkdir,
} from './_harness.js'

// Minimal plugin set that exercises the documents → front-matter →
// yaml → layouts → render-hbs pipeline without pulling in
// vector/decap/schemas/etc.
const MINIMAL_CONFIG = `
export default {
    plugins: ['documents', 'front-matter', 'yaml', 'layouts', 'render-hbs'],
}
`

const POST_LAYOUT = '<html><body><main>{{{document.content}}}</main>{{> partials/footer}}</body></html>'
const FOOTER_PARTIAL = '<footer>by mikser</footer>'

function doc(content, layout = 'post') {
    return `---\nlayout: ${layout}\n---\n${content}`
}

// Helpers — pattern matchers that read better than inline regex.
function summaryLine(stdout, { loaded, emitted, unchanged, removed, force, invalidated } = {}) {
    const expected = [
        `Documents loaded: ${loaded}`,
        emitted    ? `${emitted} emitted`      : null,
        unchanged  ? `${unchanged} unchanged`  : null,
        removed    ? `${removed} removed`      : null,
        force      ? '--force'                 : null,
        invalidated ? 'cache-invalidated'      : null,
    ].filter(Boolean).join(', ')
    assert.match(stdout, new RegExp(escapeRegex(expected)), `expected summary "${expected}"\n--- got ---\n${stdout}`)
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertRendered(stdout, n) {
    if (n === 0) {
        assert.doesNotMatch(stdout, /Rendered: \d+/, `expected no Rendered: line\n${stdout}`)
    } else {
        assert.match(stdout, new RegExp(`Rendered: ${n}\\b`), `expected Rendered: ${n}\n${stdout}`)
    }
}

describe('source.js checksum gate', () => {
    const workdir = freshWorkdir('gate')
    after(() => cleanup(workdir))

    it('cold start emits CREATEs and renders everything', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/hello.html': doc('<p>hi</p>'),
            'documents/world.html': doc('<p>world</p>'),
            'layouts/post.hbs': POST_LAYOUT,
            'layouts/partials/footer.hbs': FOOTER_PARTIAL,
        })

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        summaryLine(combined, { loaded: 2, emitted: 2 })
        assertRendered(combined, 2)

        const catalog = await readCatalog(workdir)
        assert.equal(catalog.entities.filter(e => e.collection === 'documents').length, 2)
        assert.ok(catalog.entities.find(e => e.id === '/documents/hello.html').checksum,
            'gate stores checksum on document entity')
    })

    it('warm restart with no changes — gate fires for every file, nothing renders', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        summaryLine(combined, { loaded: 2, unchanged: 2 })
        assertRendered(combined, 0)
    })

    it('modify one document — gate emits exactly that one, only that renders', async () => {
        await appendFile(path.join(workdir, 'documents/hello.html'), '\n<p>modified</p>')

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        summaryLine(combined, { loaded: 2, emitted: 1, unchanged: 1 })
        assertRendered(combined, 1)
    })

    it('add a new document — emitted as CREATE, only the new file renders', async () => {
        await writeFile(path.join(workdir, 'documents/fresh.html'), doc('<p>fresh</p>'))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        summaryLine(combined, { loaded: 3, emitted: 1, unchanged: 2 })
        assertRendered(combined, 1)
    })

    it('delete a document — sweep emits DELETE, no orphan render', async () => {
        await rm(path.join(workdir, 'documents/fresh.html'))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        summaryLine(combined, { loaded: 2, unchanged: 2, removed: 1 })
        assertRendered(combined, 0)

        const catalog = await readCatalog(workdir)
        assert.equal(catalog.entities.filter(e => e.id === '/documents/fresh.html').length, 0,
            'deleted entity removed from catalog')
    })

    it('rename a document — handled as old-id DELETE + new-id CREATE', async () => {
        await rename(
            path.join(workdir, 'documents/world.html'),
            path.join(workdir, 'documents/earth.html'),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        summaryLine(combined, { loaded: 2, emitted: 1, unchanged: 1, removed: 1 })
        assertRendered(combined, 1)
    })

    it('--force bypasses the gate — re-emits every file', async () => {
        const { code, combined } = await runMikser(workdir, ['--force'])
        assert.equal(code, 0)
        summaryLine(combined, { loaded: 2, emitted: 2, force: true })
    })
})

describe('catalog cache invalidation', () => {
    const workdir = freshWorkdir('cache')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/hello.html': doc('<p>hi</p>'),
            'layouts/post.hbs': POST_LAYOUT,
            'layouts/partials/footer.hbs': FOOTER_PARTIAL,
        })
        await runMikser(workdir) // populate catalog + manifest
    })

    it('version-stamp mismatch invalidates cache, re-emits everything', async () => {
        const catalog = await readCatalog(workdir)
        catalog.version = '0.0.0-test'
        await writeFile(
            path.join(workdir, 'runtime/catalog.json'),
            JSON.stringify(catalog),
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.match(combined, /Catalog cache invalidated/)
        summaryLine(combined, { loaded: 1, emitted: 1, invalidated: true })
    })

    it('corrupt catalog.json — falls back gracefully and re-processes', async () => {
        await writeFile(
            path.join(workdir, 'runtime/catalog.json'),
            '{"version":"8.2.0","entities":[',
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, 'mikser should not crash on corrupt catalog')
        assert.match(combined, /Catalog read failed/)
        summaryLine(combined, { loaded: 1, emitted: 1, invalidated: true })

        // Catalog rewritten as a fresh, valid file
        const reborn = await readCatalog(workdir)
        assert.ok(Array.isArray(reborn.entities))
        assert.equal(reborn.entities.filter(e => e.collection === 'documents').length, 1)
    })
})

describe('layout & partial change invalidation', () => {
    const workdir = freshWorkdir('layout-deps')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/a.html': doc('<p>A</p>'),
            'documents/b.html': doc('<p>B</p>'),
            'layouts/post.hbs': POST_LAYOUT,
            'layouts/partials/footer.hbs': FOOTER_PARTIAL,
        })
        // Cold + warm to ensure manifest has snapshots for both docs.
        await runMikser(workdir)
        await runMikser(workdir)
    })

    it('layout file changes — every consumer re-renders', async () => {
        await appendFile(path.join(workdir, 'layouts/post.hbs'), '\n<!-- modified -->')

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        // documents themselves unchanged
        summaryLine(combined, { loaded: 2, unchanged: 2 })
        // but the layout-edge invalidation re-renders both consumers
        assertRendered(combined, 2)
    })

    it('partial changes — every consumer re-renders', async () => {
        await appendFile(path.join(workdir, 'layouts/partials/footer.hbs'), '\n<!-- modified -->')

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        summaryLine(combined, { loaded: 2, unchanged: 2 })
        assertRendered(combined, 2)
    })
})

describe('multi-cycle state survives across restarts', () => {
    const workdir = freshWorkdir('multi-cycle')
    after(() => cleanup(workdir))

    it('modifying different files in successive cycles touches only each cycle\'s delta', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/a.html': doc('<p>A</p>'),
            'documents/b.html': doc('<p>B</p>'),
            'documents/c.html': doc('<p>C</p>'),
            'layouts/post.hbs': POST_LAYOUT,
            'layouts/partials/footer.hbs': FOOTER_PARTIAL,
        })

        // Cycle 0 — cold
        let r = await runMikser(workdir)
        assert.equal(r.code, 0)
        summaryLine(r.combined, { loaded: 3, emitted: 3 })

        // Cycle 1 — modify A
        await appendFile(path.join(workdir, 'documents/a.html'), '\n<!-- cycle 1 -->')
        r = await runMikser(workdir)
        assert.equal(r.code, 0)
        summaryLine(r.combined, { loaded: 3, emitted: 1, unchanged: 2 })
        assertRendered(r.combined, 1)

        // Cycle 2 — modify B (A's cycle-1 state must still be in catalog)
        await appendFile(path.join(workdir, 'documents/b.html'), '\n<!-- cycle 2 -->')
        r = await runMikser(workdir)
        assert.equal(r.code, 0)
        summaryLine(r.combined, { loaded: 3, emitted: 1, unchanged: 2 })
        assertRendered(r.combined, 1)

        // Cycle 3 — no changes; gate should fire for all 3
        r = await runMikser(workdir)
        assert.equal(r.code, 0)
        summaryLine(r.combined, { loaded: 3, unchanged: 3 })
        assertRendered(r.combined, 0)
    })
})

describe('layout & partial deletion while mikser off', () => {
    const workdir = freshWorkdir('layout-delete')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/a.html': doc('<p>A</p>'),
            'documents/b.html': doc('<p>B</p>'),
            'layouts/post.hbs': POST_LAYOUT,
            'layouts/partials/footer.hbs': FOOTER_PARTIAL,
        })
        await runMikser(workdir)
        await runMikser(workdir) // settle
    })

    it('partial file deleted between runs — sweep emits DELETE, catalog cleans up, consumers loud-fail', async () => {
        await rm(path.join(workdir, 'layouts/partials/footer.hbs'))

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, 'mikser process should not crash')
        assert.match(combined, /Layouts loaded: 1.*1 removed/,
            'sweep should emit DELETE for the missing partial')
        assert.match(combined, /Render error/,
            'consumers should fail loudly when their partial is gone')

        const catalog = await readCatalog(workdir)
        const partialEntries = catalog.entities.filter(
            e => e.id === '/layouts/partials/footer.hbs',
        )
        assert.equal(partialEntries.length, 0,
            'deleted partial should be gone from catalog')
    })

    it('after partial is restored to identical content — emits CREATE, but no re-render needed', async () => {
        await writeFile(
            path.join(workdir, 'layouts/partials/footer.hbs'),
            FOOTER_PARTIAL,
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        // 1 emit (the partial wasn't in catalog after the delete sweep,
        // so source treats it as new).
        assert.match(combined, /Layouts loaded: 2, 1 emitted, 1 unchanged/)
        // BUT: the restored content matches the hash consumers
        // recorded last time they successfully rendered. Dispatcher's
        // hash-aware seeding correctly sees "same content as before" →
        // no consumer is invalidated. The on-disk output from the
        // failed-render cycle is broken; operator can `mikser --verify`
        // to detect that and `--force` to repair. Not re-rendering by
        // default is correct: nothing in the dependency graph actually
        // changed.
        assertRendered(combined, 0)
    })

    it('after partial is restored with NEW content — consumers invalidate and re-render', async () => {
        await writeFile(
            path.join(workdir, 'layouts/partials/footer.hbs'),
            FOOTER_PARTIAL + '\n<!-- post-restore -->',
        )

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assertRendered(combined, 2)
    })
})

describe('mikser --verify', () => {
    const workdir = freshWorkdir('verify')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/hello.html': doc('<p>hi</p>'),
            'layouts/post.hbs': POST_LAYOUT,
            'layouts/partials/footer.hbs': FOOTER_PARTIAL,
        })
        await runMikser(workdir)
    })

    it('exit 0 + Verify OK on a clean build', async () => {
        const { code, combined } = await runMikser(workdir, ['--verify'])
        assert.equal(code, 0)
        assert.match(combined, /Verify OK/)
    })

    it('exit 2 + Mismatched when an output file is tampered with', async () => {
        // Find the manifest's recorded destination and tamper with it
        const m = await readManifest(workdir)
        const snap = m.find(e => e.id === '/documents/hello.html')
        assert.ok(snap?.destination, 'manifest should have hello.html')
        const filePath = path.join(workdir, 'out', snap.destination)
        await appendFile(filePath, '<!-- tampered -->')

        const { code, combined } = await runMikser(workdir, ['--verify'])
        assert.equal(code, 2, 'tampered file should produce exit 2')
        assert.match(combined, /Mismatched/)
        assert.match(combined, /Verify FAIL/)
    })

    it('exit 2 + Missing when an output file is deleted', async () => {
        const m = await readManifest(workdir)
        const snap = m.find(e => e.id === '/documents/hello.html')
        await rm(path.join(workdir, 'out', snap.destination))

        const { code, combined } = await runMikser(workdir, ['--verify'])
        assert.equal(code, 2)
        assert.match(combined, /Missing/)
    })
})

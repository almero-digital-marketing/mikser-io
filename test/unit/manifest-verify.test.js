// manifest.verify() — what `mikser --verify` reports.
//
// `destination` arrives in two shapes and both are legitimate:
//
//   page   /bg/aparati/hera/index.html                output-relative
//   asset  /abs/working/derived/web/…/hero.webp       absolute
//
// assets.js builds the second from `runtime.options.assetsFolder`, which
// resolves inside the WORKING folder and may sit outside outputFolder
// entirely — a `derived/` tree symlinked into each language root by
// `shares` is the shape that proves it is not a mistake.
//
// So verify has to tolerate both. Joining an absolute destination onto
// outputFolder yields `<out>/abs/working/…`, which never exists, and the
// report then prints the real — present — path while calling it missing.
// The same value entering the `claimed` set as a slash-stripped absolute
// string matches nothing a walk of outputFolder produces, so assets can
// never be claimed and orphan detection silently under-reports.
//
// Nothing is wrong with either producer alone, which is why the asymmetry
// is the case worth pinning.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import runtime from '../../src/runtime.js'
import { createManifest, SNAPSHOTS_SCHEMA } from '../../src/manifest.js'
import { createSqliteDatabase } from '../../src/database/index.js'

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

function makeDb() {
    const db = createSqliteDatabase({
        runtimeFolder: '/tmp',
        version: 'test',
        config: { filename: ':memory:' },
        schemas: new Map([['mikser_snapshots', SNAPSHOTS_SCHEMA]]),
    })
    db.open()
    return db
}

describe('manifest.verify()', () => {
    let root, outputFolder, derivedFolder, db, manifest

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-verify-'))
        outputFolder = path.join(root, 'out')
        // Deliberately OUTSIDE outputFolder, as a real assetsFolder can be.
        derivedFolder = path.join(root, 'derived', 'web')
        await mkdir(outputFolder, { recursive: true })
        await mkdir(derivedFolder, { recursive: true })
        db = makeDb()
        manifest = createManifest(db)
        runtime.options = { ...runtime.options, outputFolder }
    })

    afterEach(async () => {
        db.close?.()
        await rm(root, { recursive: true, force: true })
    })

    // Rows go in directly: manifest.record(entity, deps) does not take an
    // outputHash — the engine computes that from the file it just wrote and
    // builds the snapshot itself — and outputHash is exactly what verify
    // compares, so a test that cannot set it can only ever reach the
    // `unverifiable` branch.
    const record = (id, destination, bytes) =>
        db.prepare(`
            INSERT OR REPLACE INTO mikser_snapshots
                (id, destination, inputHash, outputHash, refClosure, renderedAt, parent)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, destination, 'input-hash',
            bytes === undefined ? null : sha1(Buffer.from(bytes)),
            null, 1, null,
        )

    it('accepts a page at an output-relative destination', async () => {
        await writeFile(path.join(outputFolder, 'page.html'), 'page bytes')
        record('/documents/page.md', '/page.html', 'page bytes')

        const diff = await manifest.verify({ outputFolder })
        assert.deepEqual(diff.missing, [])
        assert.deepEqual(diff.mismatched, [])
    })

    it('accepts an asset at an ABSOLUTE destination outside outputFolder', async () => {
        const abs = path.join(derivedFolder, 'hero.webp')
        await writeFile(abs, 'webp bytes')
        record('/files/hero.jpg', abs, 'webp bytes')

        const diff = await manifest.verify({ outputFolder })
        assert.deepEqual(
            diff.missing, [],
            'a file that exists at the recorded absolute path is not missing',
        )
    })

    it('still reports a genuinely absent absolute destination', async () => {
        const abs = path.join(derivedFolder, 'gone.webp')
        record('/files/gone.jpg', abs, 'never written')

        const diff = await manifest.verify({ outputFolder })
        assert.equal(diff.missing.length, 1)
        assert.equal(diff.missing[0].destination, abs)
    })

    it('still reports mismatched bytes at an absolute destination', async () => {
        const abs = path.join(derivedFolder, 'changed.webp')
        await writeFile(abs, 'original')
        record('/files/changed.jpg', abs, 'original')
        await writeFile(abs, 'edited outside mikser')

        const diff = await manifest.verify({ outputFolder })
        assert.deepEqual(diff.missing, [])
        assert.equal(diff.mismatched.length, 1)
        assert.equal(diff.mismatched[0].destination, abs)
    })

    it('claims an absolute destination that lives INSIDE outputFolder', async () => {
        // The orphan half: an absolute destination under outputFolder has to
        // enter `claimed` as the relative path a walk produces, or its file
        // is reported as an orphan of itself.
        const abs = path.join(outputFolder, 'assets', 'hero.webp')
        await mkdir(path.dirname(abs), { recursive: true })
        await writeFile(abs, 'webp bytes')
        record('/files/hero.jpg', abs, 'webp bytes')

        const diff = await manifest.verify({ outputFolder })
        assert.deepEqual(diff.missing, [])
        assert.deepEqual(
            diff.orphaned, [],
            'a claimed file must not also be reported as an orphan',
        )
    })

    it('reports a real orphan', async () => {
        await writeFile(path.join(outputFolder, 'stray.html'), 'nobody claims this')
        const diff = await manifest.verify({ outputFolder })
        assert.deepEqual(diff.orphaned.map(o => o.path), ['stray.html'])
    })

    it('mixes both shapes in one run without either interfering', async () => {
        await writeFile(path.join(outputFolder, 'page.html'), 'page bytes')
        const abs = path.join(derivedFolder, 'hero.webp')
        await writeFile(abs, 'webp bytes')
        record('/documents/page.md', '/page.html', 'page bytes')
        record('/files/hero.jpg', abs, 'webp bytes')

        const diff = await manifest.verify({ outputFolder })
        assert.deepEqual(diff.missing, [])
        assert.deepEqual(diff.mismatched, [])
        assert.deepEqual(diff.orphaned, [])
    })
})

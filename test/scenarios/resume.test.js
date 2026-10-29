// Integration tests for --resume behavior.
//
// A journal left by an interrupted cycle is picked up either way. The
// default carries its SOURCE entries and drops the render/postprocess ones,
// which this run derives again; --resume keeps the lot, replaying the
// previous run's render tasks as they were and skipping the scan. To
// simulate an interrupted cycle without killing a subprocess at an
// unpredictable time, we pre-populate the mikser_journal table directly via
// better-sqlite3 — same effect as "previous run died after journaling
// CREATEs but before onFinalized cleared the table."

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
    setupFixture, runMikser, cleanup, readCatalog,
    freshWorkdir,
} from './_harness.js'

const MINIMAL_CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), frontMatter(), yaml(), layouts({ autoLayouts: true }), renderHbs()],
}
`
const POST_LAYOUT = '<html><body>{{{document.content}}}</body></html>'

function doc(content) {
    return `---\nlayout: post\n---\n${content}`
}

// Drop a row into mikser_journal as if a prior cycle had emitted it
// (CREATE for one of the fixture's documents) but never reached
// onFinalized. Requires the schemas to already exist — runMikser the
// fixture once cleanly first.
function injectJournalRow(workdir, { operation, entity, options, context }) {
    const dbPath = path.join(workdir, 'runtime', 'mikser.sqlite')
    const db = new Database(dbPath)
    try {
        db.prepare(`
            INSERT INTO mikser_journal (operation, entity, options, context)
            VALUES (?, ?, ?, ?)
        `).run(operation, JSON.stringify(entity),
            options ? JSON.stringify(options) : null,
            context ? JSON.stringify(context) : null)
    } finally {
        db.close()
    }
}

function readJournalCount(workdir) {
    const dbPath = path.join(workdir, 'runtime', 'mikser.sqlite')
    const db = new Database(dbPath, { readonly: true })
    try {
        return db.prepare('SELECT COUNT(*) AS n FROM mikser_journal').get().n
    } finally {
        db.close()
    }
}

describe('--resume', () => {
    const workdir = freshWorkdir('resume')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': MINIMAL_CONFIG,
            'documents/hello.html': doc('<p>hi</p>'),
            'layouts/post.hbs': POST_LAYOUT,
        })
        // Bootstrap cycle: creates the database, applies schemas,
        // populates the catalog. The journal is cleared at onFinalized
        // so we control the resume scenario from a clean baseline.
        const { code } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.equal(readJournalCount(workdir), 0, 'baseline journal is empty')
    })

    it('non-empty journal + no --resume → carries the source entries, re-derives the rest', async () => {
        // A source entry the previous run never processed, and a render task
        // it had already derived from one. The source entry is the work; the
        // render task is this run's to produce again, from code that may well
        // have just been deployed over the code that produced it.
        injectJournalRow(workdir, {
            operation: 'create',
            entity: {
                id: '/documents/synthetic.html',
                collection: 'documents',
                type: 'document',
                format: 'html',
                name: 'synthetic',
                meta: { layout: 'post' },
                content: '<p>synthetic</p>',
            },
        })
        // A render task the previous run had already derived, complete enough
        // to succeed if it were replayed — so the assertion below is about
        // the task being dropped, not about a half-built row failing.
        injectJournalRow(workdir, {
            operation: 'render',
            entity: {
                id: '/documents/hello.html',
                collection: 'documents',
                type: 'document',
                format: 'html',
                name: 'hello',
                meta: { layout: 'post' },
                layout: { id: '/layouts/post.hbs', name: 'post', format: 'hbs' },
                content: '<p>hi</p>',
                destination: '/stale-destination.html',
            },
            options: { renderer: 'hbs', dispatcher: 'layouts' },
            context: {},
        })
        assert.equal(readJournalCount(workdir), 2, 'precondition: leftover rows inserted')

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.match(combined, /carrying 1 unprocessed source change\(s\) into this cycle/,
            'says what it carried')
        assert.match(combined, /re-deriving the 1 render task\(s\)/,
            'says what it will derive again')
        assert.match(combined, /--resume replays those instead/,
            'mentions --resume')

        const catalog = await readCatalog(workdir)
        assert.ok(catalog.entities.find(e => e.id === '/documents/synthetic.html'),
            'the carried source entry was processed, not dropped')
        assert.equal(existsSync(path.join(workdir, 'out/stale-destination.html')), false,
            'the dropped render task was not replayed')
        assert.equal(readJournalCount(workdir), 0,
            'the journal is drained once this cycle finalizes')
    })

    it('--resume + non-empty journal → continues from leftover, skips initial scan', async () => {
        // Synthetic entity that wasn't on disk during the bootstrap
        // cycle. Inject it as a CREATE journal row, then resume.
        // If --resume works the synthetic entity lands in the catalog
        // even though no file backs it on disk.
        injectJournalRow(workdir, {
            operation: 'create',
            entity: {
                id: '/documents/synthetic.html',
                collection: 'documents',
                type: 'document',
                format: 'html',
                name: 'synthetic',
                meta: { layout: 'post' },
                content: '<p>synthetic</p>',
                stamp: Date.now(),
                time: Date.now(),
            },
        })

        const { code, combined } = await runMikser(workdir, ['--resume'])
        assert.equal(code, 0)
        assert.match(combined, /Resuming from 1 journal entries left by a previous run/,
            'logs resume info')
        assert.match(combined, /scan skipped \(--resume\)/i,
            'skipped initial source scan')

        const catalog = await readCatalog(workdir)
        const synthetic = catalog.entities.find(e => e.id === '/documents/synthetic.html')
        assert.ok(synthetic, 'synthetic entity from leftover journal lands in catalog')
        assert.equal(readJournalCount(workdir), 0,
            'journal drained at onFinalized after the resume cycle')
    })
})

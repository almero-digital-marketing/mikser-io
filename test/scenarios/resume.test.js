// Integration tests for --resume behavior.
//
// Resume picks up a journal left by an interrupted cycle and continues
// from it; without --resume, mikser warns and discards the leftover
// rows. To simulate an interrupted cycle without killing a subprocess
// at an unpredictable time, we pre-populate the mikser_journal table
// directly via better-sqlite3 — same effect as "previous run died
// after journaling CREATEs but before onFinalized cleared the table."

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
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
function injectJournalRow(workdir, { operation, entity }) {
    const dbPath = path.join(workdir, 'runtime', 'mikser.sqlite')
    const db = new Database(dbPath)
    try {
        db.prepare(`
            INSERT INTO mikser_journal (operation, entity)
            VALUES (?, ?)
        `).run(operation, JSON.stringify(entity))
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

    it('non-empty journal + no --resume → warns and discards', async () => {
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
        assert.equal(readJournalCount(workdir), 1, 'precondition: leftover row inserted')

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.match(combined, /Previous run had 1 unfinalized journal entries/,
            'warns about leftover')
        assert.match(combined, /use --resume to keep/,
            'mentions --resume in the warning')
        assert.equal(readJournalCount(workdir), 0,
            'leftover row discarded on the new clean cycle')
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

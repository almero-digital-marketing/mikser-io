// A crash loop must not grow the journal.
//
// Reported from a deployment. A config change wiped the cache, the import
// completed, and the process was restarted before the cycle did. From then on
// every run did the same thing: "The last rebuild did not finish", so it
// journalled the whole catalog again; "Previous run was interrupted", so it
// carried every source entry the last run left as well. Each restart added a
// catalog's worth of rows — 17k, 26k, 35k, 43k, 52k source entries for the
// same 8.8k entities — and each run died in the same place, the finalize
// catalog drain, which read every one of them and every render entry besides.
//
// Two fixes, and the test holds both:
//
//   1. the carry keeps only the latest source entry of each kind per entity,
//      so a run inherits at most one catalog's worth however many died before
//      it (journal.js, the leftover bootstrap)
//   2. the catalog drain reads source operations only and collapses repeats,
//      so render entries — which carry the enriched entity and were 1.6 GB of
//      JSON on that deployment — are never held in memory (catalog.js)
//
// The kill is simulated at onBeforeRender, after the dispatcher has journalled
// this cycle's render tasks: the process dies holding source entries and
// render entries with nothing rendered, which is what an OOM in render or
// finalize leaves too.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs, onBeforeRender } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { existsSync } from 'node:fs'
import path from 'node:path'

const killMidCycle = () => () => {
    onBeforeRender(async () => {
        if (existsSync(path.join(import.meta.dirname, 'KILL'))) process.exit(7)
    })
}

export default {
    plugins: [documents(), frontMatter(), layouts({ autoLayouts: true }), renderHbs(), killMidCycle()],
}
`

const PAGES = ['index', 'one', 'two', 'three']
const doc = (title) => `---\ntitle: ${title}\nlayout: page\n---\n`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs': '<!doctype html><title>{{document.meta.title}}</title>',
    ...Object.fromEntries(PAGES.map(name => [`documents/${name}.md`, doc(name.toUpperCase())])),
}

describe('a crash loop after an interrupted rebuild', () => {
    const workdir = freshWorkdir('crash-loop-journal')
    after(() => cleanup(workdir))

    const cachePath = () => path.join(workdir, 'runtime', 'mikser.sqlite')
    const kill = () => writeFile(path.join(workdir, 'KILL'), '')

    // Source rows per entity id, as the next run will find them.
    function sourceRows() {
        const db = new Database(cachePath(), { readonly: true })
        try {
            return db.prepare(`
                SELECT json_extract(entity, '$.id') AS id, COUNT(*) AS n FROM mikser_journal
                WHERE operation IN ('create', 'update', 'delete') GROUP BY id
            `).all()
        } finally {
            db.close()
        }
    }

    // Every entity the catalog holds — the pages and the layout — since a
    // rebuild journals all of them.
    function catalogSize() {
        const db = new Database(cachePath(), { readonly: true })
        try {
            return db.prepare('SELECT COUNT(*) AS n FROM mikser_entities').get().n
        } finally {
            db.close()
        }
    }

    const carried = (combined) => Number(combined.match(/carrying (\d+) unprocessed source change/)?.[1] ?? NaN)
    const runs = []
    let entities

    before(async () => {
        await setupFixture(workdir, FIXTURE)
        const first = await runMikser(workdir)
        assert.equal(first.code, 0, first.combined)

        // A cache wipe, then a restart mid-cycle — the reported start.
        await rm(cachePath(), { force: true })
        await writeFile(path.join(workdir, 'documents/index.md'), doc('AFTER'))
        await kill()
        for (let attempt = 0; attempt < 4; attempt++) {
            const run = await runMikser(workdir)
            assert.equal(run.code, 7, `attempt ${attempt} died where it meant to\n${run.combined}`)
            runs.push({ combined: run.combined, rows: sourceRows() })
        }
        entities = catalogSize()
        assert.ok(entities > PAGES.length, `the catalog holds the pages and the layout: ${entities}`)
    })

    it('rebuilds everything on every attempt, which is what journals the catalog again', () => {
        for (const { combined } of runs.slice(1)) {
            assert.match(combined, /last rebuild did not finish/)
        }
    })

    it('carries one catalog\'s worth into each run, however many died before it', () => {
        // Without the collapse this grew by a catalog per crash: 5, 10, 15.
        const counts = runs.slice(1).map(run => carried(run.combined))
        assert.deepEqual(counts, counts.map(() => entities),
            `carried per attempt: ${counts.join(', ')}`)
        assert.match(runs.at(-1).combined, /repeated source entries were dropped/,
            'and says it dropped the repeats')
    })

    it('never leaves more than this run\'s entries and one carried copy per entity', () => {
        for (const [attempt, { rows }] of runs.entries()) {
            assert.equal(rows.length, entities, `attempt ${attempt}: every entity, once each`)
            for (const { id, n } of rows) {
                assert.ok(n <= 2, `attempt ${attempt}: ${id} has ${n} source rows`)
            }
        }
    })

    it('recovers once the process stops dying, with the latest content', async () => {
        await rm(path.join(workdir, 'KILL'))
        const recovery = await runMikser(workdir)
        assert.equal(recovery.code, 0, recovery.combined)
        assert.equal(carried(recovery.combined), entities)
        assert.match(await readFile(path.join(workdir, 'out', 'index.html'), 'utf8'), /AFTER/)
        for (const name of PAGES.slice(1)) {
            assert.match(await readFile(path.join(workdir, 'out', name, 'index.html'), 'utf8'),
                new RegExp(name.toUpperCase()))
        }
        assert.deepEqual(sourceRows(), [], 'a completed cycle clears the journal')
    })

    it('then builds incrementally again', async () => {
        const quiet = await runMikser(workdir)
        assert.equal(quiet.code, 0, quiet.combined)
        assert.doesNotMatch(quiet.combined, /last rebuild did not finish|Previous run was interrupted/)
        assert.doesNotMatch(quiet.combined, /Rendered:/, 'nothing changed, so nothing renders')
    })
})

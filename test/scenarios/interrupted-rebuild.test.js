// A rebuild that did not finish is rebuilt, not reported as unchanged.
//
// The worst failure this project has produced, because nothing anywhere said
// so. On a deployment: a version upgrade wiped the cache, the import
// completed, the process restarted mid-cycle, and from then on every build
// read "34 unchanged" and rendered nothing while the site served the previous
// day's pages. Green deploy script, green build log, green promote check,
// stale site, for as long as nobody looked.
//
// It needs three states to disagree at once, which is why no single gate
// could see it:
//
//   catalog    CURRENT     the import finished, so checksums match disk
//   manifest   EMPTY       wiped with the cache, never rewritten
//   journal    DISCARDED   with the interrupted run
//   out/       STALE       a cache wipe unlinks the database, nothing else
//
// Every gate is then correct and the result is wrong. The source gate's
// evidence really does say unchanged. The layouts dispatcher seeds from a
// journal that is empty. The render gate would answer `never-rendered` — the
// right answer — but nothing dispatches to it, so nothing asks.
// missingOutputIds() cannot help either: it walks snapshots, and there are
// none to walk.
//
// Two changes, and both are needed:
//
//   1. the schema stamp is written when a cycle FINISHES, not when the
//      database opens, so it means "this cache was rebuilt" rather than
//      "this cache was opened"
//   2. no stamp beside a populated catalog is declared an invalidation
//      override, which reaches every gate through invalidation.js
//
// Without (1) the interrupted run leaves a current stamp and (2) never
// triggers. Without (2) the absent stamp is not a mismatch either, so
// nothing rebuilds.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), frontMatter(), layouts({ autoLayouts: true }), renderHbs()],
}
`

const doc = (title) => `---\ntitle: ${title}\nlayout: page\n---\n`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs': '<!doctype html><title>{{document.meta.title}}</title>',
    'documents/index.md': doc('FIRST'),
}

describe('an interrupted rebuild', () => {
    const workdir = freshWorkdir('interrupted-rebuild')
    after(() => cleanup(workdir))

    const cachePath = () => path.join(workdir, 'runtime', 'mikser.sqlite')
    const output = () => readFile(path.join(workdir, 'out', 'index.html'), 'utf8')

    const cache = (fn) => {
        const db = new Database(cachePath())
        try { return fn(db) } finally { db.close() }
    }
    const stamp = () => cache(db =>
        db.prepare("SELECT value FROM mikser_meta WHERE key='schema_version'").get()?.value ?? null)

    before(async () => {
        await setupFixture(workdir, FIXTURE)
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(await output(), /FIRST/)
    })

    it('stamps the cache only once a cycle has completed', async () => {
        // The stamp is the record that this cache was REBUILT for this
        // version. A completed build has one.
        assert.ok(stamp(), 'a completed build leaves a stamp')
    })

    it('leaves no stamp when the cycle does not finish', async () => {
        // Simulated rather than raced: the state is what matters, and a real
        // kill lands in a different phase depending on corpus size and disk
        // speed. Verified against a real SIGKILL mid-render separately — it
        // produces exactly this: entities present, snapshots empty, no stamp.
        await writeFile(path.join(workdir, 'documents/index.md'), doc('SECOND'))
        await runMikser(workdir)
        assert.match(await output(), /SECOND/, 'precondition: a normal build applies the edit')

        await writeFile(path.join(workdir, 'documents/index.md'), doc('THIRD'))
        await runMikser(workdir)

        // Now stage the interrupted state: the catalog knows THIRD, nothing
        // has been rendered from it, and the output still holds SECOND.
        await writeFile(path.join(workdir, 'out', 'index.html'),
            (await output()).replace('THIRD', 'SECOND'))
        cache(db => {
            db.prepare('DELETE FROM mikser_snapshots').run()
            db.prepare("DELETE FROM mikser_meta WHERE key='schema_version'").run()
        })
        assert.equal(stamp(), null, 'staged: no stamp')
        assert.ok(cache(db => db.prepare('SELECT count(*) AS c FROM mikser_entities').get().c) > 0,
            'staged: catalog is populated')
        assert.match(await output(), /SECOND/, 'staged: output is stale')
    })

    it('rebuilds instead of reporting unchanged, and says why', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        const log = stripAnsi(combined)
        assert.match(log, /last rebuild did not finish/)
        assert.match(log, /Rendered:\s*1/)
        assert.doesNotMatch(log, /1 unchanged/,
            'the whole bug was that this said unchanged')
        assert.match(await output(), /THIRD/, 'and the output catches up')
    })

    it('stamps the cache again, so the next build is incremental', async () => {
        // The recovery must not be sticky: having rebuilt once, an ordinary
        // build has to go back to skipping. A permanent full rebuild would
        // pass every test above and be its own bug.
        assert.ok(stamp(), 'the recovering cycle stamped the cache')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        const log = stripAnsi(combined)
        assert.doesNotMatch(log, /last rebuild did not finish/)
        assert.doesNotMatch(log, /Rendered:/, 'nothing changed, so nothing renders')
    })

    it('does not fire for a project whose catalog is legitimately empty', async () => {
        // A first run has no stamp either, and must not be reported as an
        // interrupted rebuild. Emptiness already opens every gate.
        const fresh = freshWorkdir('interrupted-rebuild-fresh')
        try {
            await setupFixture(fresh, FIXTURE)
            const { code, combined } = await runMikser(fresh)
            assert.equal(code, 0, combined)
            assert.doesNotMatch(stripAnsi(combined), /last rebuild did not finish/)
            assert.match(stripAnsi(combined), /Rendered:\s*1/)
        } finally {
            await cleanup(fresh)
        }
    })
})

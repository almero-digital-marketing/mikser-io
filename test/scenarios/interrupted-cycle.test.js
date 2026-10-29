// A restart mid-cycle must not lose the renders the cycle had not reached.
//
// Reported from a deployment. A merge landed, the watching instance journalled
// the changed sources and began rendering, and 35 seconds later the deploy
// script restarted pm2 for the code change. The next process discarded the
// 262 unfinalized journal entries, then reported "9 unchanged, 1 unchanged"
// and rendered nothing — the stylesheet bundle among them. The site served
// the previous day's CSS, with no error anywhere.
//
// Three states have to disagree at once, and each layer is individually right:
//
//   catalog    CURRENT   persist runs before render, so the new checksums
//                        were already committed when the process died
//   out/       STALE     nothing had rendered yet
//   journal    DISCARDED with the interrupted run
//
// The source gate then compares a file against a catalog that already matches
// it and emits nothing; the dispatcher gets no seed; no gate further down is
// ever asked. `--force` or touching the file is the only way back, and only
// if somebody notices.
//
// The shape the fixture reproduces is the reported one, not a simpler
// equivalent: the file that changes is a stylesheet NOTHING renders, and the
// page that must come back does so through a query edge recorded by `glob`.
// A test where the changed entity is itself the rendered one passes on a
// narrower fix.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

// The kill plugin stands in for the pm2 restart. onBeforeRender, and declared
// after layouts so it runs after the dispatcher has journalled this cycle's
// render tasks — the process dies holding exactly what the report described:
// source entries and derived render entries, nothing rendered.
const CONFIG = `
import { documents, files, frontMatter, renderHbs, fileHelpers, onBeforeRender } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { existsSync } from 'node:fs'
import path from 'node:path'

const killMidCycle = () => () => {
    onBeforeRender(async () => {
        if (existsSync(path.join(import.meta.dirname, 'KILL'))) process.exit(7)
    })
}

export default {
    plugins: [
        documents(), files(), frontMatter(), layouts(), renderHbs(), fileHelpers(),
        killMidCycle(),
    ],
}
`

const LAYOUT = `<html><head><style>
{{#each (glob "files/styles/*.css")}}{{{readFile this}}}
{{/each}}</style></head><body>{{{document.content}}}</body></html>`

const PAGE = `---\nlayout: page\nhref: /index.html\n---\n<p>hi</p>`

const out = (workdir) => readFile(path.join(workdir, 'out/index.html'), 'utf8')
const rendered = (combined) => Number(combined.match(/Rendered: (\d+)/)?.[1] ?? 0)

function journalRows(workdir) {
    const db = new Database(path.join(workdir, 'runtime', 'mikser.sqlite'), { readonly: true })
    try {
        return db.prepare('SELECT operation, COUNT(*) AS n FROM mikser_journal GROUP BY operation')
            .all().reduce((acc, row) => ({ ...acc, [row.operation]: row.n }), {})
    } finally {
        db.close()
    }
}

describe('a process restarted mid-cycle', () => {
    const workdir = freshWorkdir('interrupted-cycle')
    let recovery, leftovers
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/index.html': PAGE,
            'layouts/page.hbs': LAYOUT,
            'files/styles/hero.css': '.hero{color:red}',
        })
        const first = await runMikser(workdir)
        assert.equal(first.code, 0, first.combined)
        assert.match(await out(workdir), /color:red/, 'baseline build inlined the stylesheet')

        // The change the interrupted cycle was processing.
        await writeFile(path.join(workdir, 'files/styles/hero.css'), '.hero{color:blue}')
        await writeFile(path.join(workdir, 'KILL'), '')
        const killed = await runMikser(workdir)
        assert.equal(killed.code, 7, 'the fixture died where it meant to')
        assert.match(await out(workdir), /color:red/,
            'precondition: the interrupted cycle rendered nothing')
        leftovers = journalRows(workdir)

        // Restart. Nothing on disk changed since the kill, so every gate this
        // run asks on its own evidence answers "unchanged" — which is the
        // whole of the bug.
        await rm(path.join(workdir, 'KILL'))
        recovery = await runMikser(workdir)
    })

    it('leaves the interrupted run its source entries and its render tasks', () => {
        // Asserted from the kill run's own leftovers rather than from the
        // recovery: if the fixture ever stops dying between persist and
        // render, this says so instead of the recovery quietly passing for a
        // different reason.
        assert.ok((leftovers.update ?? 0) + (leftovers.create ?? 0) > 0,
            `no source entries were left behind: ${JSON.stringify(leftovers)}`)
        assert.ok((leftovers.render ?? 0) > 0,
            `no render tasks were left behind: ${JSON.stringify(leftovers)}`)
    })

    it('renders what the interrupted cycle never reached', async () => {
        assert.equal(recovery.code, 0, recovery.combined)
        assert.match(await out(workdir), /color:blue/,
            'the stylesheet change was journalled, persisted and then lost — '
            + 'the site stays on the previous build with every signal green')
    })

    it('says that it did, rather than reporting an ordinary build', () => {
        assert.match(recovery.combined, /Previous run was interrupted with \d+ unfinalized/,
            'an operator reading the log can tell a recovered cycle from a quiet one')
        assert.match(recovery.combined, /carrying \d+ unprocessed source change\(s\)/)
    })

    it('names the carry as what started the build', async () => {
        // `invalidated` exists so a count can never stand alone, and a
        // recovered cycle is the shape that reads worst without it: nothing
        // on disk moved, so `changed` is empty and the honest-looking answer
        // is `nothing` — printed beside a list of pages it just rendered.
        await writeFile(path.join(workdir, 'files/styles/hero.css'), '.hero{color:green}')
        await writeFile(path.join(workdir, 'KILL'), '')
        assert.equal((await runMikser(workdir)).code, 7)
        await rm(path.join(workdir, 'KILL'))

        const { stdout, combined } = await runMikser(workdir, ['--json'])
        const report = JSON.parse(stdout)
        assert.equal(report.invalidated.cause, 'interrupted',
            `a build with renders in it never reports that nothing started it\n${combined}`)
        assert.ok(report.invalidated.carried > 0, 'and says how much it carried')
        assert.ok(report.rendered.length > 0, 'precondition: it did render something')
        assert.match(await out(workdir), /color:green/)
    })

    it('carries the work once, not every cycle after', async () => {
        const quiet = await runMikser(workdir)
        assert.equal(quiet.code, 0, quiet.combined)
        assert.equal(rendered(quiet.combined), 0,
            `a recovered cycle finalizes, so the next one has nothing to carry\n${quiet.combined}`)
        assert.doesNotMatch(quiet.combined, /Previous run was interrupted/)
    })
})

// The same interruption, in the shape that cannot be recovered from the
// catalog: an entity whose source is not a file at all. Nothing rescans it,
// so if its journal entry goes, no later cycle has anything to look at.
describe('an interrupted cycle holding an entity no scan can re-emit', () => {
    const workdir = freshWorkdir('interrupted-cycle-unscanned')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'documents/index.html': PAGE,
            'layouts/page.hbs': LAYOUT,
            'files/styles/hero.css': '.hero{color:red}',
        })
        assert.equal((await runMikser(workdir)).code, 0)
    })

    it('keeps it', async () => {
        // A form submission, a CSV row, an API push: journalled by a plugin,
        // backed by no file, and therefore invisible to every scan. The
        // checksum gate cannot bring this one back however it is written.
        const db = new Database(path.join(workdir, 'runtime', 'mikser.sqlite'))
        db.prepare('INSERT INTO mikser_journal (operation, entity) VALUES (?, ?)').run('create',
            JSON.stringify({
                id: '/documents/submission.html',
                collection: 'documents',
                type: 'document',
                format: 'html',
                name: 'submission',
                uri: '',
                meta: { layout: 'page', href: '/submission.html' },
                content: '<p>from a form</p>',
            }))
        db.close()

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        const page = path.join(workdir, 'out/submission/index.html')
        assert.equal(existsSync(page), true,
            `the page is the only record that the submission was ever received\n${combined}`)
        assert.match(await readFile(page, 'utf8'), /from a form/)
    })
})

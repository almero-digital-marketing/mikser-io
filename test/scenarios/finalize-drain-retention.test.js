// What the finalize drain KEEPS while it hashes the output.
//
// The drain reads every RENDER entry the cycle journalled, and it used to
// keep each one whole — the entity as the pipeline enriched it, its deps,
// the lot — in a list it then carried through an async pass that reads and
// hashes every file written. Six fields per entry were ever used. On a full
// rebuild of 19k renders whose rows averaged 84 KB that list was ~1.6 GB of
// parsed entities held for the length of a filesystem walk, and the process
// died there on a 4 GB heap with `Output: 21001/21520` as its last line
// (gpointpremium.com, 19.11.2026). pm2 restarted it, the restart carried the
// journal, and it died in the same place.
//
// So the drain builds the snapshot as it reads and keeps that instead, and
// this test states the consequence as a number: a run that cannot afford to
// hold the corpus completes anyway.
//
// The shape is a layout paginated far past its source. One document, one
// import, one catalog row — so the ONLY thing that grows with `PAGES` is the
// list of render entries the drain reads, and a heap cap is a statement
// about that list and nothing else. Keeping the entities needs PAGES × the
// document's own weight; keeping the snapshots needs a few hundred bytes
// each.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`

// 2,500 renders of a 100 KB document. Keeping the entities is ~250 MB, which
// the cap below refuses; keeping the snapshots is ~3 MB, which it does not
// notice. The journal reads in chunks of 500, so ~50 MB of row JSON is in
// hand either way and the cap has to clear that — it is the floor the fix
// cannot go under, and the margin is deliberately a factor either side of it
// rather than a tuned number.
const PAGES = 2500
const DOCUMENT_BYTES = 100 * 1024
const HEAP_MB = 200

// Unique per line, because a corpus of repeated literals is one V8 can share
// — and a memory test that measures string interning measures nothing.
const body = Array.from(
    { length: Math.ceil(DOCUMENT_BYTES / 64) },
    (_, i) => `<p>paragraph ${i} of the one document this build has</p>`,
).join('\n')

describe('a cold build with more renders than its heap can hold entities for', () => {
    const workdir = freshWorkdir('finalize-drain-retention')
    after(() => cleanup(workdir))
    let run

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            // Deliberately renders none of the document: the output is what
            // the hash pass reads, and this test is about what is held WHILE
            // it reads, not about how long the reading takes.
            'layouts/paged.html.hbs': '<!doctype html><title>{{document.page}}</title>',
            'layouts/paged.js': `export async function load() { return { pages: ${PAGES} } }\n`,
            'documents/paged.html': `---\nlayout: paged\n---\n${body}`,
        })
        run = await runMikser(workdir, [], {
            env: { NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
            timeout: 180_000,
        })
    })

    it('completes instead of running the heap out', () => {
        assert.doesNotMatch(run.combined, /heap out of memory|Allocation failed/,
            `died in the drain this test exists for\n${run.combined.slice(-2000)}`)
        assert.equal(run.code, 0, run.combined.slice(-2000))
    })

    it('renders every page', () => {
        assert.match(run.combined, new RegExp(`Rendered: ${PAGES}`), run.combined.slice(-2000))
    })

    it('and records them, so the drain did its work rather than skipping it', async () => {
        // A snapshot per page, each verified against the file on disk. The
        // failure this guards is a drain that survives the cap by dropping
        // work: one snapshot short is a page the next cycle re-renders
        // forever, and one hash short is a page nothing checks again.
        const audit = await runMikser(workdir, ['--audit-output', '--json'])
        const report = JSON.parse(audit.stdout)
        assert.equal(report.snapshots, PAGES, JSON.stringify(report).slice(0, 500))
        assert.deepEqual(report.missing, [])
        assert.deepEqual(report.mismatched, [])
    })
})

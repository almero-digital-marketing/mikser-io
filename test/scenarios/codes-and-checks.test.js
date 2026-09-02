// One name for a finding, and a document for every check.
//
// A finding had two names. The report called it `output-drift`; the console
// said "produced different bytes from the same inputs"; and nothing on the
// console contained the string a reader of docs/diagnostics.md would grep for.
// So a script watching a build matched prose — the half that is free to be
// reworded — while the stable identifier lived only in a document that script
// was not reading. Same shape for reference-wrong-base ("Points at the wrong
// place") and reference-no-derivative ("No derivative was produced").
//
// And --audit-output, the check a deploy script most wants, reported through
// the log and wrote no document at all: `--audit-output --json` returned zero
// bytes, so a caller had to parse prose or trust an exit code and lose every
// detail behind it.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`

describe('the code a script greps for is on the line a person reads', () => {
    const workdir = freshWorkdir('codes-console')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.html.hbs': '<!doctype html><body>v1<img src="../nope.svg"></body>',
            'documents/index.html': '---\nlayout: page\n---\n',
        })
        await runMikser(workdir)
        // Change the layout without changing any input the manifest hashes:
        // same inputs, different bytes.
        await writeFile(path.join(workdir, 'layouts/page.html.hbs'),
            '<!doctype html><body>v2<img src="../nope.svg"></body>')
        out = (await runMikser(workdir, ['--force'])).combined
    })

    it('prints output-drift by name, not only as a sentence', () => {
        assert.match(out, /\[output-drift\]/,
            `the documented name has to appear where the build is watched\n${out}`)
        assert.match(out, /\[output-drift-summary\]/, out)
    })

    it('prints the reference codes by name too', () => {
        assert.match(out, /\[reference-broken\]/, out)
        assert.match(out, /\[reference-broken-summary\]/, out)
    })

    it('leaves the sentence intact — the code is added, not substituted', () => {
        // The prose is what a person reads; the code is what a script matches.
        // Replacing one with the other would just move the problem.
        assert.match(out, /produced different bytes from the same inputs/, out)
    })

    it('does not bracket a line that has no code', () => {
        assert.match(out, /Mikser completed/)
        assert.doesNotMatch(out, /\[\] ?Mikser completed/, out)
        assert.doesNotMatch(out, /\[undefined\]/, out)
    })

    it('agrees with the code the report carries, because both read one field', () => {
        // The console and the report cannot disagree if they come from the
        // same place. This is the property, not the formatting.
        const codes = [...out.matchAll(/\[([a-z][a-z0-9-]+)\]/g)].map(m => m[1])
        assert.ok(codes.includes('output-drift'), codes.join(', '))
    })
})

describe('--audit-output as a document', () => {
    const workdir = freshWorkdir('audit-json')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
            'documents/index.html': '---\nlayout: page\n---\n',
        })
        await runMikser(workdir)
    })

    it('writes a parseable document on stdout instead of nothing', async () => {
        const { code, stdout } = await runMikser(workdir, ['--audit-output', '--json'])
        assert.notEqual(stdout.length, 0,
            'this is the check a deploy script wants, and it returned zero bytes')
        const report = JSON.parse(stdout)
        assert.equal(report.verdict, 'OK')
        assert.equal(typeof report.snapshots, 'number')
        assert.equal(code, 0)
    })

    it('carries the counts and the entries behind them', async () => {
        const { stdout } = await runMikser(workdir, ['--audit-output', '--json'])
        const report = JSON.parse(stdout)
        for (const key of ['missing', 'mismatched', 'unverifiable', 'orphaned', 'collisions']) {
            assert.equal(typeof report.summary[key], 'number', key)
            assert.ok(Array.isArray(report[key]), `${key} should list what it counted`)
        }
    })

    it('reports FAIL and exit 2 when the output is not what was written', async () => {
        // The exit code was the only signal before; it must not change now
        // that there is a document beside it.
        await writeFile(path.join(workdir, 'out/index.html'), 'tampered')
        const { code, stdout } = await runMikser(workdir, ['--audit-output', '--json'])
        const report = JSON.parse(stdout)
        assert.equal(report.verdict, 'FAIL', stdout)
        assert.equal(report.summary.mismatched, 1)
        assert.equal(report.mismatched[0].destination, '/index.html')
        assert.equal(code, 2)
    })

    it('keeps the human rendering when --json is absent', async () => {
        const { combined } = await runMikser(workdir, ['--audit-output'])
        assert.match(combined, /Audit /, combined)
        assert.doesNotMatch(combined, /"verdict"/, 'the document belongs on stdout, under --json only')
    })
})

describe('which check answers which question', () => {
    it('is on --help, where the question is being asked', async () => {
        const workdir = freshWorkdir('help-map')
        try {
            await setupFixture(workdir, { 'mikser.config.js': CONFIG })
            const { combined } = await runMikser(workdir, ['--help'])
            assert.match(combined, /Which check answers which question/, combined)
            // Each check named with the boundary that makes it distinct —
            // knowledge that lived only in commit messages, which nobody reads
            // before they need the answer.
            assert.match(combined, /--audit-output/, combined)
            assert.match(combined, /CANNOT catch/, combined)
            assert.match(combined, /--force/, combined)
            assert.match(combined, /docs\/diagnostics\.md/, combined)
        } finally {
            await cleanup(workdir)
        }
    })
})

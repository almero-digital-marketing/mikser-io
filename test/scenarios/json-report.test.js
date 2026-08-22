// `--json` — a build report a program can assert on.
//
// "Rendered: 16" is a number nobody can assert on; verifying "did my change
// land" otherwise means diffing the output folder against a snapshot taken
// beforehand. The valuable field is `reason`, and a stable `code` on a
// warning matters more than its prose — it lets a caller assert "this build
// produced no preset-no-match" instead of grepping a sentence someone may
// reword.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { setupFixture, cleanup, freshWorkdir, stripAnsi, MIKSER_ROOT } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ autoLayouts: false, match: { '@/*/aparati/*': 'device', '@/nonesuch/*': 'ghost' } }),
        renderHbs(),
    ],
}
`

const workdir = freshWorkdir('json-report')
const build = () => new Promise(resolve => {
    let stdout = '', stderr = ''
    const p = spawn('node', ['--no-warnings', 'app.js', '--working-folder', workdir, '--json'], {
        cwd: MIKSER_ROOT,
        env: { ...process.env, NO_COLOR: '1', NODE_PATH: path.dirname(MIKSER_ROOT) },
    })
    p.stdout.on('data', d => stdout += d)
    p.stderr.on('data', d => stderr += d)
    p.on('close', code => resolve({ code, stdout, stderr }))
})

before(() => setupFixture(workdir, {
    'mikser.config.js': CONFIG,
    'documents/bg/aparati/hera.md': '---\ntitle: Hera\n---\nbody\n',
    'documents/bg/aparati/onix.md': '---\ntitle: Onix\n---\nbody\n',
    'layouts/device.hbs': '<h1>{{document.meta.title}}</h1>',
    'layouts/ghost.hbs': '<p>x</p>',
}))
after(() => cleanup(workdir))

describe('--json build report', () => {
    it('stdout is ONLY the document; logs go to stderr', async () => {
        const { code, stdout, stderr } = await build()
        assert.equal(code, 0)
        const report = JSON.parse(stdout)      // throws if anything leaked
        assert.ok(report.summary)
        assert.match(stripAnsi(stderr), /Mikser completed/, 'the human-readable log is still there')
    })

    it('every render carries a reason from a stable vocabulary', async () => {
        // Reasons are the point. The vocabulary is a contract: renaming one is
        // a breaking change to anyone asserting on it.
        const KNOWN = new Set(['unchanged', 'never-rendered', 'inputs-changed',
                               'ref-changed', 'query-matched', 'cache-disabled',
                               'postprocessor', 'no-manifest'])
        const report = JSON.parse((await build()).stdout)
        for (const r of [...report.rendered, ...report.skipped]) {
            assert.ok(KNOWN.has(r.reason), `unexpected reason ${JSON.stringify(r.reason)}`)
            assert.ok(r.id, 'every entry names its entity')
        }
    })

    it('a warning carries a machine-readable code plus its fields', async () => {
        // Touch a file first: the no-match warnings are silent when nothing
        // was evaluated, so a fully cached build legitimately reports none.
        await writeFile(path.join(workdir, 'documents', 'bg', 'aparati', 'onix.md'),
                        '---\ntitle: Onix v2\n---\nbody\n')
        const report = JSON.parse((await build()).stdout)
        const warning = report.warnings.find(w => w.code === 'layout-pattern-no-match')
        assert.ok(warning, `expected layout-pattern-no-match, got ${JSON.stringify(report.warnings)}`)
        assert.equal(warning.pattern, '@/nonesuch/*')
        assert.equal(warning.layout, 'ghost')
        assert.equal(typeof warning.evaluated, 'number')
    })

    it('reports no warnings on a fully cached build — a CI assertion must account for that', async () => {
        // Consequence of the above, and a trap for "assert the build produced
        // no preset-no-match": on a cached build that passes trivially,
        // because nothing was evaluated to match against. Assert it on a
        // build that did work, or after --force.
        const report = JSON.parse((await build()).stdout)
        assert.equal(report.summary.rendered, 0)
        assert.deepEqual(report.warnings, [])
    })

    it('names exactly what re-rendered after a one-document edit', async () => {
        // The question the report exists for. Before this it was a count.
        await writeFile(path.join(workdir, 'documents', 'bg', 'aparati', 'hera.md'),
                        '---\ntitle: Hera EDITED\n---\nbody\n')
        const report = JSON.parse((await build()).stdout)
        assert.equal(report.rendered.length, 1, JSON.stringify(report.rendered))
        assert.match(report.rendered[0].id, /hera\.md$/)
        assert.equal(report.rendered[0].reason, 'inputs-changed')
        assert.equal(report.rendered[0].destination, '/bg/aparati/hera/index.html')
    })

    it('counts import-gated entities separately from skipped renders', async () => {
        // An unchanged source never becomes a render task, so it is in
        // neither list — the two would not reconcile with the corpus without
        // saying so. Counted rather than listed: on a large site the list
        // would be almost the whole catalog on almost every build.
        const report = JSON.parse((await build()).stdout)
        assert.equal(typeof report.summary.gated, 'number')
        assert.ok(report.summary.gated >= 1, 'the untouched document was gated at import')
        assert.equal(report.rendered.length, 0, 'and nothing re-rendered this time')
    })
})

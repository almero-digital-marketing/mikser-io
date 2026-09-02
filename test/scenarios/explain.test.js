// `--explain <entity>` — what happened to one entity, and why.
//
// The question it exists for is "why did this NOT change?", which until now
// could only be answered by reading plugin source and hand-querying
// runtime/mikser.sqlite. Every field is assembled from state the engine
// already keeps; the tests below are about whether the answers are correct
// and whether the output is usable by a program.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi, MIKSER_ROOT } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), yaml(),
        layouts({ autoLayouts: false, match: { '@/*/aparati/*': 'device', '@/*/index': 'page' } }),
        renderHbs(),
    ],
}
`

const FILES = {
    'mikser.config.js': CONFIG,
    'documents/bg/aparati/hera.md': '---\ntitle: Hera\nlang: bg\nhref: /aparati/hera\n---\nbody\n',
    'documents/bg/index.md': '---\ntitle: Home\nlang: bg\n---\nhome\n',
    'layouts/device.hbs': '<h1>{{document.meta.title}}</h1>',
    'layouts/page.hbs': '<h1>{{document.meta.title}}</h1>',
    'layouts/device.js': "import { chrome } from './lib/context.js'\nexport async function load(){ return { chrome } }",
    'layouts/lib/context.js': 'export const chrome = 1',
}

const workdir = freshWorkdir('explain')
const explain = (args) => new Promise(resolve => {
    let stdout = '', stderr = ''
    const p = spawn('node', ['--no-warnings', 'app.js', '--working-folder', workdir, '--explain', ...args], {
        cwd: MIKSER_ROOT,
        env: { ...process.env, NO_COLOR: '1', NODE_PATH: path.dirname(MIKSER_ROOT) },
    })
    p.stdout.on('data', d => stdout += d)
    p.stderr.on('data', d => stderr += d)
    p.on('close', code => resolve({ code, stdout, stderr }))
})

before(async () => {
    await setupFixture(workdir, FILES)
    const build = await runMikser(workdir)
    assert.equal(build.code, 0, stripAnsi(build.stderr))
})
after(() => cleanup(workdir))

describe('--explain', () => {
    it('names the layout AND the pattern that claimed the entity', async () => {
        // "which of two patterns claimed this" was previously only answerable
        // by re-running the matcher by hand.
        const { code, stdout } = await explain(['/documents/bg/aparati/hera.md'])
        assert.equal(code, 0)
        const text = stripAnsi(stdout)
        assert.match(text, /layout\s+device\s+\(matched "@\/\*\/aparati\/\*"\)/)
    })

    it('surfaces the LAYOUT\'s inputs on the page\'s report', async () => {
        // Where "does editing this helper invalidate my page" gets answered.
        // Not seeing it is what makes people build a workaround for something
        // already handled.
        const { stdout } = await explain(['/documents/bg/aparati/hera.md'])
        assert.match(stripAnsi(stdout), /inputs\s+sidecar [0-9a-f]{8}, shared [0-9a-f]{8}/)
    })

    it('reports the destination and whether a build would re-render', async () => {
        const { stdout } = await explain(['/documents/bg/aparati/hera.md'])
        const text = stripAnsi(stdout)
        assert.match(text, /destination \/bg\/aparati\/hera\/index\.html/)
        assert.match(text, /\[current\]/)
        assert.match(text, /would be SKIPPED/)
    })

    it('notices a file edited since the last build, which the catalog cannot', async () => {
        // explain reads the CATALOG, which is as of the last build. Without
        // checking the file too, every hash would agree and the verdict would
        // say "skipped" — true of the catalog, misleading about the next
        // build. This is the case that made that distinction necessary.
        await writeFile(path.join(workdir, 'documents', 'bg', 'index.md'),
                        '---\ntitle: Home EDITED\nlang: bg\n---\nhome\n')
        const { stdout } = await explain(['/documents/bg/index.md'])
        const text = stripAnsi(stdout)
        assert.match(text, /DIFFERS from the catalog — not yet re-imported/)
        assert.match(text, /would re-import it first, then re-render/)
    })

    it('then reports it as current once a build has run', async () => {
        const build = await runMikser(workdir)
        assert.equal(build.code, 0, stripAnsi(build.stderr))
        const { stdout } = await explain(['/documents/bg/index.md', '--json'])
        const report = JSON.parse(stdout)
        assert.equal(report.source.differs, false)
        assert.match(report.verdict, /SKIPPED/)
    })

    it('resolves by meta.href and by id-without-extension', async () => {
        for (const ref of ['/aparati/hera', '/documents/bg/aparati/hera']) {
            const { code, stdout } = await explain([ref])
            assert.equal(code, 0, `${ref} should resolve`)
            assert.match(stripAnsi(stdout), /entity\s+\/documents\/bg\/aparati\/hera\.md/)
        }
    })

    it('exits 3 with a hint when the entity is not in the catalog', async () => {
        // Distinct from --audit-output's 1/2: "no such entity" is neither a clean
        // build nor a corrupt one, it is a question that could not be answered.
        const { code, stdout } = await explain(['/documents/nope'])
        assert.equal(code, 3)
        assert.match(stripAnsi(stdout), /not found/)
        assert.match(stripAnsi(stdout), /junk|extensions|meta\.href/)
    })

    it('--json puts ONLY the document on stdout', async () => {
        // The whole point of the flag. Logs and the banner go to stderr, or
        // `mikser --explain x --json | jq` cannot work.
        const { stdout, stderr } = await explain(['/documents/bg/aparati/hera.md', '--json'])
        const report = JSON.parse(stdout)   // throws if anything else leaked
        assert.equal(report.found, true)
        assert.equal(report.id, '/documents/bg/aparati/hera.md')
        assert.equal(report.layouts[0].matchedBy, '@/*/aparati/*')
        assert.ok(report.layouts[0].inputs.shared, 'the shared sidecar digest is machine-readable too')
        assert.equal(report.renders[0].stale, false)
        assert.match(report.verdict, /SKIPPED/)
        assert.ok(report.renders[0].refClosure.some(e => e.kind === 'layout'))
        // And the logs are still visible to a human, just elsewhere.
        assert.match(stripAnsi(stderr), /Working folder/)
    })
})

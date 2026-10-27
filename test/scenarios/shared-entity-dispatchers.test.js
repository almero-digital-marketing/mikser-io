// One entity, two dispatchers: a page AND the source of preset derivatives.
//
// mikser-io-layouts renders the page, mikser-io-assets renders the
// derivatives, and both carry the entity's own id. They gate on different
// evidence — layouts drops a seed whose input hash is unchanged, assets
// schedules every journaled source and every source of a preset whose revision
// moved — so a cycle that schedules the derivatives and not the page is
// ordinary.
//
// The manifest's cleanup compared this cycle's claims with every earlier row
// for the id, whoever had written it. The preset tasks were the only claims,
// the page's destination was not among them, and it was unlinked as
// "Destination moved" together with its snapshot. Found on a clinic site: a
// sheet edit re-derived every report to the same meta and every report page
// went to 404. Nothing brought it back — the snapshot was gone, so the audit
// counted nothing missing, and the source gate saw nothing to do.
//
// The same overlap had layouts writing each preset's RESULT into the output
// folder: its onComplete claimed any task whose entity has a layout, and a
// preset task clones its source, layout and all. Hence the audit checks below.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, utimes, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup, freshWorkdir, readManifest, stripAnsi, MIKSER_ROOT,
} from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { assets, renderPreset } from 'mikser-io-assets'
export default {
    plugins: [documents(), frontMatter(), layouts({ layoutsFolder: 'layouts' }),
        assets({ presets: { marks: { match: ['/documents/**'] } } }), renderPreset(), renderHbs()],
}
`

// Output that is a fixed string, so "did it re-render" is read, not inferred.
const preset = (revision, body) => [
    "import { mkdir, writeFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    `export const revision = ${revision}`,
    "export default async function marks({ entity }) {",
    "    await mkdir(path.dirname(entity.destination), { recursive: true })",
    `    await writeFile(entity.destination, '${body}')`,
    "}",
].join('\n')

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'presets/marks.js': preset(1, 'FIRST'),
    'layouts/page.hbs': '<i>{{entity.meta.title}}</i>',
    'documents/thing.md': '---\nlayout: page\ntitle: Thing\n---\nbody\n',
}

const page = (workdir) => path.join(workdir, 'out', 'thing', 'index.html')
const derivative = (workdir) => path.join(workdir, 'assets', 'marks', 'thing')
const claims = async (workdir) =>
    (await readManifest(workdir)).map(s => s.destination.replace(workdir, '<wd>')).sort()
const BOTH = ['/thing/index.html', '<wd>/assets/marks/thing']

async function assertAuditClean(workdir) {
    // Only the page and the link to the assets tree belong in the output. A
    // preset's result written there lands under the derivative's absolute
    // path, which starts at the filesystem root.
    assert.deepEqual((await readdir(path.join(workdir, 'out'))).sort(), ['assets', 'thing'])
    const audit = await runMikser(workdir, ['--audit-output'])
    assert.equal(audit.code, 0, audit.combined)
    assert.match(stripAnsi(audit.combined), /Audit OK: 2 snapshots, 0 missing, .*0 orphaned/,
        stripAnsi(audit.combined))
}

describe('an entity that is a page and a preset source', () => {
    it('keeps its page when only the preset re-renders', async () => {
        const workdir = freshWorkdir('shared-entity-revision')
        try {
            await setupFixture(workdir, FIXTURE)
            let build = await runMikser(workdir)
            assert.equal(build.code, 0, build.combined)
            assert.deepEqual(await claims(workdir), BOTH)
            await assertAuditClean(workdir)

            // The documented way to rebuild derivatives. The document itself
            // did not change, so layouts has nothing to do.
            await writeFile(path.join(workdir, 'presets/marks.js'), preset(2, 'SECOND'))
            build = await runMikser(workdir)
            assert.equal(build.code, 0, build.combined)
            assert.match(stripAnsi(build.combined), /Rendered: 1\b/,
                'precondition: the preset alone rendered, or this asserts nothing')

            assert.ok(existsSync(page(workdir)), 'the page is still on disk')
            assert.deepEqual(await claims(workdir), BOTH,
                'and still claimed, so a later loss of the file would be noticed')
            await assertAuditClean(workdir)
        } finally {
            await cleanup(workdir)
        }
    })

    describe('under --watch, when the source is re-journaled unchanged', () => {
        // The shape it was found in: a plugin touches the source files when an
        // upstream table changes, the watcher journals them again, the derived
        // meta comes out the same — so layouts skips them — and assets
        // schedules their presets, reused from their markers.
        const workdir = freshWorkdir('shared-entity-watch')
        let instance
        let log = ''
        after(async () => { instance?.kill(); await cleanup(workdir) })

        // A barrier on what the instance says, not a settle time.
        const completed = () => (stripAnsi(log).match(/Mikser completed/g) ?? []).length
        async function cycles(n) {
            for (let i = 0; i < 300 && completed() < n; i++) {
                await new Promise(r => setTimeout(r, 100))
            }
            assert.ok(completed() >= n, `cycle ${n} never completed:\n${stripAnsi(log)}`)
        }

        it('keeps the page and its claim', async () => {
            await setupFixture(workdir, FIXTURE)
            instance = spawn(process.execPath,
                [path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir, '--watch'],
                { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'] })
            instance.stdout.on('data', chunk => { log += chunk })
            instance.stderr.on('data', chunk => { log += chunk })
            await cycles(1)
            assert.deepEqual(await claims(workdir), BOTH)

            const at = log.length
            const now = new Date()
            await utimes(path.join(workdir, 'documents', 'thing.md'), now, now)
            await cycles(2)
            const second = stripAnsi(log.slice(at))
            assert.match(second, /Rendering finished: 1 /,
                'precondition: one render task — the preset — and no page task')

            assert.ok(existsSync(page(workdir)), 'the page is still on disk')
            assert.ok(existsSync(derivative(workdir)), 'and so is the derivative')
            assert.deepEqual(await claims(workdir), BOTH, 'both still claimed')
        })
    })
})

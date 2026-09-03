// --render-presets, and the gate that makes it necessary.
//
// The preset fan-out — "this preset moved, so re-evaluate everything it could
// claim" — is a full catalog scan. onImport writes every preset entity on
// every build, so gating it on "a preset is in the journal" ran that scan
// every cycle, including a no-op watch rebuild. It is gated now on the
// preset's effective definition actually moving: its `revision`, its module,
// or its match patterns.
//
// The patterns are half of that definition and they live in CONFIG, not in
// the module, so the preset entity carries them. Widening one used to be a
// silent no-op — match is evaluated as a file ENTERS the catalog, so a wider
// pattern left everything already in it alone.
//
// The gate costs one thing: a derivative can no longer be recovered by
// deleting its marker and rebuilding, because nothing schedules an entity
// whose source and preset both stand still. --render-presets is that, made
// explicit — and it covers the cases no bookkeeping can see: a preset edited
// without bumping revision, an image library upgraded under the build.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

// The preset as the catalog holds it — the record the next build compares
// against to decide whether the preset moved.
async function readPresetEntity(workdir) {
    const db = new Database(path.join(workdir, 'runtime', 'mikser.sqlite'), { readonly: true })
    try {
        const row = db.prepare("SELECT data FROM mikser_entities WHERE id = '/presets/web'").get()
        return JSON.parse(row.data)
    } finally {
        db.close()
    }
}

const config = (match) => `
import { documents, files, assets, frontMatter, renderHbs } from 'mikser-io'
export default {
    plugins: [documents(), files(), frontMatter(),
        assets({ presets: { web: { match: ${JSON.stringify(match)} } } }), renderHbs()],
}
`

const preset = (revision, body) => [
    "import { mkdir, writeFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    `export const revision = ${revision}`,
    "export default async function web({ entity }) {",
    "    await mkdir(path.dirname(entity.destination), { recursive: true })",
    `    await writeFile(entity.destination, '${body}')`,
    "}",
].join('\n')

describe('--render-presets', () => {
    const workdir = freshWorkdir('render-presets')
    after(() => cleanup(workdir))

    const derivative = () => path.join(workdir, 'assets', 'web', 'media', 'hero.jpg')
    const writePreset = (rev, body) =>
        writeFile(path.join(workdir, 'presets/web.js'), preset(rev, body))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': config(['/files/media/**']),
            'presets/web.js': preset(1, 'FIRST'),
            'files/media/hero.jpg': 'source',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'FIRST')
    })

    it('an edit without a revision bump does NOT re-derive on its own', async () => {
        // The behaviour the flag exists to override. If this ever starts
        // re-deriving by itself, the flag is pointless and the gate is gone.
        await writePreset(1, 'EDITED')
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'FIRST',
            `an unbumped preset must not rebuild by itself\n${combined}`)
    })

    it('--render-presets re-derives it', async () => {
        const { code, combined } = await runMikser(workdir, ['--render-presets'])
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'EDITED',
            `the flag must disregard the marker at the current revision\n${combined}`)
        assert.match(combined, /Presets re-rendering: web/)
    })

    it('takes a preset name', async () => {
        await writePreset(1, 'NAMED')
        const { code, combined } = await runMikser(workdir, ['--render-presets', 'web'])
        assert.equal(code, 0, combined)
        assert.equal(await readFile(derivative(), 'utf8'), 'NAMED', combined)
    })

    it('names what it does not know rather than doing nothing', async () => {
        const { combined } = await runMikser(workdir, ['--render-presets', 'nosuch'])
        assert.match(combined, /asked for 'nosuch', which is not configured/, combined)
        assert.match(combined, /Known: web/, combined)
    })

    it('records the match patterns on the preset entity', async () => {
        // The mechanism behind the widened-match fix: the patterns are part of
        // the preset's identity, so changing them moves the entity and the
        // fan-out re-evaluates every candidate. Read from the catalog, because
        // that is where the comparison against the next build happens.
        const preset = await readPresetEntity(workdir)
        assert.deepEqual(preset.matches, ['/files/media/**'],
            `the preset must carry the patterns it selects by: ${JSON.stringify(preset)}`)
    })

    it('a widened pattern moves the entity, which is what re-evaluates the corpus', async () => {
        await writeFile(path.join(workdir, 'mikser.config.js'), config(['/files/**']))
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        const preset = await readPresetEntity(workdir)
        assert.deepEqual(preset.matches, ['/files/**'],
            'the recorded patterns must follow the config')
    })
})

describe('--render-presets with no assets plugin', () => {
    const workdir = freshWorkdir('render-presets-unloaded')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`,
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
            'documents/index.html': '---\nlayout: page\n---\n',
        })
    })

    it('is refused as unknown, before anything is built', async () => {
        // A flag nothing consumes is the silent no-op this engine keeps
        // finding, and this used to be caught after the fact: core declared
        // the option, the build ran, and a `render-presets-unhandled` fault
        // explained afterwards that nothing had acted on it.
        //
        // The assets plugin declares the option itself now, so a config
        // without assets() does not have the flag at all — the mistake is
        // refused by name before a single entity is rendered, which is what
        // every other misspelled flag already gets.
        const { code, combined } = await runMikser(workdir, ['--render-presets'])
        assert.equal(code, 1, `an unconsumed flag must not report success\n${combined}`)
        assert.match(combined, /unknown option '--render-presets'/, combined)
        assert.doesNotMatch(combined, /Rendered:/, 'and it must not have built first')
    })
})

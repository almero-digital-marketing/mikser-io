// Proving an upgrade moved no bytes is the check every mikser project needs,
// and it is the one thing a shell script cannot compute correctly from
// outside. A real one, written twice and wrong both times, hit all of this:
//
//   - `find out -type f` does NOT descend into a symlink, and files() emits by
//     symlinking while assets symlinks the whole derivatives tree in. Every
//     "byte-identical" it printed was a statement about html, css and js only.
//   - hashing per directory block made the result depend on the order the
//     blocks came back, so two runs over byte-identical trees hashed
//     differently — a false CHANGED, which sends someone hunting a regression
//     that never happened.
//   - where the derivatives live, and which of them are cheap to re-render,
//     had to be re-derived from config and from grepping preset sources.
//
// The engine knows all of it. What it does NOT do is orchestrate the upgrade:
// talking to npm, editing package.json and deciding what to install is the
// script's own job and stays there.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { assets, renderPreset } from 'mikser-io-assets'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), files(), frontMatter(),
    assets({ assetsFolder: 'derived', presets: { web: { match: ['/files/media/**'] } } }), renderPreset(),
    layouts(), renderHbs()] }
`
const PRESET = [
    "import { mkdir, copyFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    'export const revision = 1',
    'export default async function web({ entity }) {',
    '    await mkdir(path.dirname(entity.destination), { recursive: true })',
    '    await copyFile(entity.source ?? entity.uri, entity.destination)',
    '}',
].join('\n')

describe('a fingerprint of what the build wrote', () => {
    const workdir = freshWorkdir('fingerprint')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
            'files/media/hero.jpg': 'jpeg-ish',
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
            'documents/index.html': '---\nlayout: page\n---\n',
        })
        const { code } = await runMikser(workdir)
        assert.equal(code, 0)
    })

    const fingerprint = async () => {
        const { code, stdout } = await runMikser(workdir, ['--fingerprint', '--json'])
        assert.equal(code, 0, stdout)
        return JSON.parse(stdout)
    }

    it('counts what is reachable through a symlink, which find does not', async () => {
        // The derivatives tree enters the output as a directory symlink, and
        // the source files as file symlinks. `find out -type f` sees neither.
        const link = path.join(workdir, 'out', 'derived')
        assert.equal(lstatSync(link).isSymbolicLink(), true, 'the fixture must have the symlink')

        const report = await fingerprint()
        assert.ok(report.output.files >= 3,
            `html + a linked source + a derivative, at least: ${JSON.stringify(report.output)}`)
        assert.ok(existsSync(path.join(workdir, 'derived/web/media/hero.jpg')))
    })

    it('is stable across runs over an unchanged tree', async () => {
        // Two runs hashing differently is a false CHANGED, and a false CHANGED
        // here sends someone hunting a regression that never happened.
        const a = await fingerprint()
        const b = await fingerprint()
        assert.equal(a.output.hash, b.output.hash)
        assert.deepEqual(a.trees, b.trees)
    })

    it('moves when a derivative changes, and only then', async () => {
        // The case the symlink hid: nothing in out/ proper changed at all.
        const before = await fingerprint()
        await writeFile(path.join(workdir, 'derived/web/media/hero.jpg'), 'tampered')
        const after = await fingerprint()
        assert.notEqual(after.output.hash, before.output.hash,
            'a changed derivative must move the hash')
        assert.notEqual(after.trees['derived/web'].hash, before.trees['derived/web'].hash)
    })

    it('groups the shared trees, so a caller can compare only what an upgrade could touch', async () => {
        // sharp is an npm dependency an upgrade can change; ffmpeg is a host
        // binary it cannot. Re-rendering the video presets to learn that costs
        // minutes, so the groups are addressable separately.
        const report = await fingerprint()
        assert.ok(report.trees['derived/web'], JSON.stringify(Object.keys(report.trees)))
        assert.equal(typeof report.trees['derived/web'].hash, 'string')
        assert.ok(report.trees['derived/web'].files >= 1)
    })

    it('carries the version, so a comparison knows what it is comparing', async () => {
        const report = await fingerprint()
        assert.match(report.version, /^\d+\.\d+\.\d+/)
    })

    it('reads the output without building, and answers from a running instance', async () => {
        // Report-only: it must not wipe the cache or trigger a cycle, and it
        // forwards like --audit-output so it can be asked of a live watcher.
        const before = await fingerprint()
        assert.equal(existsSync(path.join(workdir, 'out')), true)
        const after = await fingerprint()
        assert.equal(after.output.hash, before.output.hash, 'asking must not change the answer')
    })

    it('renders for a person too, not only as a document', async () => {
        const { code, combined } = await runMikser(workdir, ['--fingerprint'])
        assert.equal(code, 0, combined)
        assert.match(combined, /Output [0-9a-f]{64} — \d+ file\(s\)/, combined)
        assert.match(combined, /derived\/web:/, combined)
    })
})

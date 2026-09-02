// A derivative has to go when its source does.
//
// Deleting a source removed its catalog row and its published file and left
// the derivative behind. The assets delete handler dropped the in-memory
// mapping and touched nothing on disk, so the only cleanup was `--clear` or
// removing the file by hand — and a stale derivative is worse than a missing
// one, because every check passes: the url resolves, the bytes are there, and
// they are the bytes of a file that no longer exists.
//
// Narrowing a preset's `match` left one the same way and said nothing.
//
// It is answered from the CATALOG, not from the delete event. A delete entry
// is sparse — `{ id, type, collection }` by convention in every source plugin
// — so it cannot say where the derivative went. "Does this derivative still
// have a source that a preset still covers" is a question the catalog answers
// whatever route the orphan arrived by, including one that predates the fix.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const config = (match) => `
import { documents, files, assets, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), files(), frontMatter(),
    assets({ assetsFolder: 'derived', presets: { web: { match: ['${match}'] } } }),
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

const BASE = {
    'presets/web.js': PRESET,
    'documents/index.html': '---\nlayout: page\n---\n',
    'layouts/page.html.hbs': '<!doctype html><body>x</body>',
}
const derived = (workdir, p) => existsSync(path.join(workdir, 'derived', p))

describe('a derivative whose source was deleted', () => {
    const workdir = freshWorkdir('derivative-orphan-deleted')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            ...BASE,
            'mikser.config.js': config('/files/media/**'),
            'files/media/keep.jpg': 'kept',
            'files/media/gone.jpg': 'about to go',
        })
        assert.equal((await runMikser(workdir)).code, 0)
        assert.equal(derived(workdir, 'web/media/gone.jpg'), true, 'it should be derived first')

        await rm(path.join(workdir, 'files/media/gone.jpg'))
        out = (await runMikser(workdir)).combined
    })

    it('removes the derivative, not just the source', () => {
        assert.equal(derived(workdir, 'web/media/gone.jpg'), false,
            `a stale derivative passes every check — the url resolves and the bytes are there\n${out}`)
    })

    it('removes its revision marker too, so it cannot be counted as current', () => {
        assert.equal(existsSync(path.join(workdir, 'derived/web/media/gone.jpg.1.md5')), false, out)
    })

    it('leaves the derivative whose source is still there', () => {
        assert.equal(derived(workdir, 'web/media/keep.jpg'), true,
            `a sweep that takes live derivatives with it is worse than no sweep\n${out}`)
    })

    it('says what it removed and why', () => {
        assert.match(out, /Assets removed: 1 derivative\(s\) with no source/, out)
        assert.match(out, /its source is gone/, out)
    })

    it('stays quiet on a build with nothing to remove', async () => {
        const { combined } = await runMikser(workdir)
        assert.doesNotMatch(combined, /Assets removed:/, combined)
    })
})

describe('a derivative whose preset no longer covers it', () => {
    const workdir = freshWorkdir('derivative-orphan-narrowed')
    after(() => cleanup(workdir))

    it('goes too, and names the entity the match stopped covering', async () => {
        await setupFixture(workdir, {
            ...BASE,
            'mikser.config.js': config('/files/media/**'),
            'files/media/a/one.jpg': 'a',
            'files/media/b/two.jpg': 'b',
        })
        await runMikser(workdir)
        assert.equal(derived(workdir, 'web/media/b/two.jpg'), true)

        // Narrowing the match. The source still exists; this preset simply
        // stopped owning it, which used to leave the derivative forever.
        await writeFile(path.join(workdir, 'mikser.config.js'), config('/files/media/a/**'))
        const { combined } = await runMikser(workdir)

        assert.equal(derived(workdir, 'web/media/b/two.jpg'), false, combined)
        assert.equal(derived(workdir, 'web/media/a/one.jpg'), true,
            'the half still covered must survive')
        assert.match(combined, /no longer covers \/files\/media\/b\/two\.jpg/, combined)
    })
})

describe('an empty catalog', () => {
    const workdir = freshWorkdir('derivative-orphan-guard')
    after(() => cleanup(workdir))

    it('removes nothing, because everything would qualify', async () => {
        // The failure this guard exists to prevent. Every check concludes "no
        // source, therefore orphan", and an empty catalog answers that for
        // every derivative on the site — so a failed import would delete the
        // whole assets folder, at best a full re-derive and at worst on the
        // machine serving them.
        //
        // No documents, no layouts and no files: nothing puts a row in the
        // catalog, and derivatives are planted by hand as an earlier run would
        // have left them.
        await setupFixture(workdir, {
            'mikser.config.js': `
import { assets } from 'mikser-io'
export default { plugins: [assets({ assetsFolder: 'derived', presets: { web: { match: ['/files/**'] } } })] }
`,
            'presets/web.js': PRESET,
        })
        await mkdir(path.join(workdir, 'derived/web/media'), { recursive: true })
        await writeFile(path.join(workdir, 'derived/web/media/planted.jpg'), 'from an earlier run')
        await writeFile(path.join(workdir, 'derived/web/media/planted.jpg.1.md5'), 'x')

        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.equal(derived(workdir, 'web/media/planted.jpg'), true,
            `an empty catalog must not be read as "every derivative is an orphan"\n${combined}`)
        assert.doesNotMatch(combined, /Assets removed:/, combined)
    })
})

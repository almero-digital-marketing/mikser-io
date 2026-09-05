// A derivative that was never produced has to say why.
//
// `asset()` BUILDS a url from a naming convention — it takes a path, not an
// entity, so nothing it returns has been checked and a mistake produces a
// perfectly well-formed link to a file that does not exist. The consequence is
// caught at the end of the cycle. The CAUSE was not reported at all, and there
// are four of them with one symptom:
//
//   the preset name is a typo
//   the preset exists but its `match` does not cover this file
//   it does cover it, and the derivative still is not there
//   there is no source file under that name at all
//
// Only the second is fixed in the config rather than the template, and it is
// the one a reader is least likely to guess — "asked for a preset the file's
// folder didn't have" looks exactly like a broken build.
//
// Worse, the wrong-base check made a confident WRONG guess at it: files()
// copies the source into the output, so searching for the same filename finds
// it and reports "the file is at media/icons/logo.svg", which reads as a base
// off by a folder. The base is right. The derivative does not exist.
//
// The helper still looks nothing up. This is answered once per missing
// destination, after the cycle, by the plugin that owns `match`.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const config = (presets) => `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { assets, assetUrlHelper, renderPreset } from 'mikser-io-assets'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), files(), frontMatter(),
        assets({ assetsFolder: 'derived', presets: ${presets} }), renderPreset(),
        layouts(), renderHbs(), assetUrlHelper(),
    ],
}
`

const PRESET = [
    "import { mkdir, copyFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    'export const revision = 1',
    'export default async function preset({ entity }) {',
    '    await mkdir(path.dirname(entity.destination), { recursive: true })',
    '    await copyFile(entity.source ?? entity.uri, entity.destination)',
    '}',
].join('\n')

const layout = (...urls) => '<!doctype html><body>'
    + urls.map(u => `<img src="{{url ${u}}}">`).join('')
    + '</body>'

const BASE = {
    'presets/web.js': PRESET,
    'presets/thumb.js': PRESET,
    'files/media/photos/hero.jpg': 'jpeg-ish',
    'files/media/icons/logo.svg': 'svg-ish',
    'documents/index.html': '---\nlayout: page\n---\n',
}

describe('a linked derivative that is not in the output', () => {
    const workdir = freshWorkdir('no-derivative')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            ...BASE,
            'mikser.config.js': config(
                "{ web: { match: ['/files/media/photos/**'] }, thumb: { match: ['/files/media/icons/**'] } }"),
            'layouts/page.html.hbs': layout(
                '(asset "web" "/media/photos/hero.jpg")',   // covered — must stay quiet
                '(asset "web" "/media/icons/logo.svg")',    // the reported case
                '(asset "wibble" "/media/photos/hero.jpg")',
                '(asset "web" "/media/photos/absent.jpg")',
            ),
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, `a missing derivative must warn, not fail\n${combined}`)
        out = combined
    })

    it('names the preset and the file it does not cover', () => {
        assert.match(out, /preset 'web' does not cover \/files\/media\/icons\/logo\.svg/,
            `the cause has to be stated, not left to be guessed\n${out}`)
    })

    it('quotes the match that decided it, since that is what gets edited', () => {
        assert.match(out, /its match is \/files\/media\/photos\/\*\*/, out)
    })

    it('says which preset does cover the file, so the fix may be in the template', () => {
        assert.match(out, /Presets that do cover it: thumb/, out)
    })

    it('does not call it a wrong base — the source is in the output, and that is not the problem', () => {
        // The regression this closes. The same-name search finds the source
        // copy and would otherwise report a misplaced file with total
        // confidence, sending the reader to look for a base that is correct.
        assert.doesNotMatch(out, /Points at the wrong place:.*logo\.svg/,
            `a never-produced derivative is not a wrong base\n${out}`)
    })

    it('separates a preset name nothing declares', () => {
        assert.match(out, /no preset named 'wibble' is configured \(configured: thumb, web\)/, out)
    })

    it('separates a source file that does not exist', () => {
        assert.match(out, /no source file is named 'media\/photos\/absent'/, out)
    })

    it('stays silent about the derivative that was produced', () => {
        assert.doesNotMatch(out, /hero\.jpg.*does not cover/, out)
        // The web derivative of hero.jpg is the one that WAS produced. The
        // wibble line names the same source under a preset that does not
        // exist, so the path alone does not distinguish them — the preset
        // segment is what says which url is being complained about.
        assert.doesNotMatch(out, /No derivative was produced: derived\/web\/media\/photos\/hero\.jpg/, out)
    })

    it('counts the explained ones apart from the guesses', async () => {
        const { stdout } = await runMikser(workdir, ['--force', '--json'])
        const report = JSON.parse(stdout)
        const summary = report.warnings.find(w => w.code === 'reference-broken-summary')
        assert.ok(summary, 'expected a summary line')
        assert.equal(summary.noDerivative, 3, JSON.stringify(summary))
        assert.equal(summary.wrongBase, 0, 'none of these is a base problem')

        const explained = report.warnings.filter(w => w.code === 'reference-no-derivative')
        assert.equal(explained.length, 3)
        // The reason travels into --json as its own field, so a deploy script
        // can tell a config mistake from a failed render without parsing prose.
        assert.ok(explained.every(w => typeof w.reason === 'string' && w.reason.length))
    })
})

describe('a preset that covers the file but produced nothing', () => {
    const workdir = freshWorkdir('no-derivative-failed')
    after(() => cleanup(workdir))

    it('says the preset does cover it, rather than blaming the match', async () => {
        // A preset module that throws: the file IS selected, so "does not
        // cover" would be a lie and would send the reader to edit a pattern
        // that is already right.
        await setupFixture(workdir, {
            ...BASE,
            'presets/web.js': [
                'export const revision = 1',
                'export default async function web() { throw new Error("preset exploded") }',
            ].join('\n'),
            'mikser.config.js': config("{ web: { match: ['/files/media/photos/**'] } }"),
            'layouts/page.html.hbs': layout('(asset "web" "/media/photos/hero.jpg")'),
        })
        const { combined } = await runMikser(workdir)
        assert.match(combined, /preset 'web' does cover \/files\/media\/photos\/hero\.jpg/,
            `expected the match to be exonerated\n${combined}`)
        assert.doesNotMatch(combined, /does not cover \/files\/media\/photos\/hero\.jpg/, combined)
    })
})

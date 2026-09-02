// Where a url is read from decides whether it is broken.
//
// Three ways this check answered confidently and wrongly, all reported from a
// real site whose pages load correctly in a browser:
//
//   1. A `url()` inside a CUSTOM PROPERTY was resolved against the page. It is
//      substituted where it is USED, so it resolves against the stylesheet
//      doing the substituting — a bundle at styles/, not the page three
//      directories down. Fifteen correct references reported as a wrong base
//      is how a reader learns to skim past the whole check.
//
//   2. The output scan did not follow symlinks. files() emits by symlinking
//      the source into the output, so a stylesheet is a link rather than a
//      copy — and no symlinked html or css was ever read. Every `url()` in
//      every bundle went unchecked while the summary reported a confident
//      total. The same-name index HAS always followed links, which is how a
//      file could be found somewhere the scan would not read.
//
//   3. The cause of a missing derivative was only asked for within the ten
//      entries that get printed, so ten unrelated broken urls hid the
//      eleventh's answer and the summary said "No derivative produced: 0"
//      while holding it.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), files(), frontMatter(), layouts(), renderHbs()] }
`

// The bundle sits at styles/. `../media/icons/arrow.svg` is correct FROM THE
// BUNDLE and wrong from the page, which is three directories deep.
const LAYOUT = [
    '<!doctype html><head><link rel="stylesheet" href="/styles/bundle.css"></head><body>',
    '<span style="--icon-btn-src:url(&quot;../media/icons/arrow.svg&quot;)"></span>',
    '<span style="--gone-src:url(&quot;../media/icons/nowhere.svg&quot;)"></span>',
    '</body>',
].join('')

describe('a url() inside a custom property', () => {
    const workdir = freshWorkdir('custom-property-base')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'files/media/icons/arrow.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'files/styles/bundle.css': 'icon-btn .icon-btn__icon{mask:var(--icon-btn-src) no-repeat}',
            'documents/a/b/page.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': LAYOUT,
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        out = combined
    })

    it('is not a wrong base when it resolves from the stylesheet', () => {
        assert.doesNotMatch(out, /wrong place:.*arrow\.svg/,
            `this reference ships and works; reporting it buries the real ones\n${out}`)
        assert.doesNotMatch(out, /nothing produced it:.*arrow\.svg/, out)
    })

    it('is still broken when it resolves from neither', () => {
        // The check is not being switched off for custom properties — a url
        // missing wherever it is read from is still missing.
        assert.match(out, /nothing produced it: \.\.\/media\/icons\/nowhere\.svg/,
            `a custom property pointing at nothing must still be reported\n${out}`)
    })

    it('reads symlinked stylesheets, which is most of them', async () => {
        // files() symlinks rather than copies, so a scan that skipped links
        // read no stylesheet at all. Proven by putting a broken url inside
        // one: it can only be found by reading the file.
        const workdir2 = freshWorkdir('symlinked-css')
        try {
            await setupFixture(workdir2, {
                'mikser.config.js': CONFIG,
                'files/styles/bundle.css': '.x{background:url("../media/absent.png")}',
                'documents/index.html': '---\nlayout: page\n---\n',
                'layouts/page.html.hbs': '<!doctype html><body>x</body>',
            })
            const { combined } = await runMikser(workdir2)
            assert.match(combined, /absent\.png/,
                `a url inside a symlinked stylesheet has to be checked\n${combined}`)
        } finally {
            await cleanup(workdir2)
        }
    })
})

const ASSETS_CONFIG = `
import { documents, files, assets, frontMatter, renderHbs, assetUrlHelper } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), files(), frontMatter(),
        assets({ assetsFolder: 'derived', presets: {
            web:   { match: ['/files/media/web/**'] },
            strip: { match: ['/files/media/strip/**'] },
        } }),
        layouts(), renderHbs(), assetUrlHelper()],
}
`

const PRESET = [
    "import { mkdir, copyFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    'export const revision = 1',
    "export const format = 'webp'",
    'export default async function preset({ entity }) {',
    '    await mkdir(path.dirname(entity.destination), { recursive: true })',
    '    await copyFile(entity.source ?? entity.uri, entity.destination)',
    '}',
].join('\n')

describe('a stated cause behind a crowd of guesses', () => {
    const workdir = freshWorkdir('cause-ordering')
    after(() => cleanup(workdir))
    let out, report

    before(async () => {
        // Twelve unrelated broken urls whose basename exists elsewhere, so
        // each is a wrong-base guess, plus one derivative whose cause IS
        // known. The known one sorts last.
        const noise = Array.from({ length: 12 }, (_, i) => `<img src="ghost/noise${i}.svg">`).join('')
        const files = Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [`files/other/noise${i}.svg`, '<svg/>']))
        await setupFixture(workdir, {
            ...files,
            'mikser.config.js': ASSETS_CONFIG,
            'presets/web.js': PRESET,
            'presets/strip.js': PRESET,
            'files/media/web/devices/hera/specs.jpg': 'jpeg-ish',
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>' + noise
                + '<img src="{{url (asset "strip" "/media/web/devices/hera/specs.jpg")}}">'
                + '</body>',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        out = combined
        report = JSON.parse((await runMikser(workdir, ['--force', '--json'])).stdout)
    })

    it('counts the cause even though it sorts past the printed ten', () => {
        assert.match(out, /No derivative produced: 1/,
            `the count must cover every broken entry, not the printed ones\n${out}`)
    })

    it('prints it, rather than ten guesses instead of the one answer', () => {
        assert.match(out, /No derivative was produced:.*specs\.webp.*preset 'strip' does not cover/,
            `an answer outranks a guess in what gets shown\n${out}`)
    })

    it('does not call the answered one a wrong base', () => {
        assert.doesNotMatch(out, /wrong place:.*specs\.webp/, out)
        const summary = report.warnings.find(w => w.code === 'reference-broken-summary')
        assert.equal(summary.noDerivative, 1, JSON.stringify(summary))
        assert.equal(summary.wrongBase, 12, JSON.stringify(summary))
    })
})

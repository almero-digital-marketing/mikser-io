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

// The climb check is the sibling of the broken check, and it was left behind.
//
// The first fix only replaced the verdict where the page-relative target was
// MISSING. Where the discarded `..` happened to land on a real file, the
// reference fell through to the over-deep bucket and was reported as climbing
// above the site root — with an explanation that had become false: "they load,
// a browser discards the extra `..`". They load because they are correct where
// they are actually read from. A wrong reason attached to a correct reference
// is worse than the original false positive, because it sends the reader to
// fix a base that is right.
//
// It shows up on a page at its SITE ROOT, where pageDir is empty and a single
// `..` has nothing to pop.

const SITE_CONFIG = `
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    siteRoots: ['bg'],
    plugins: [documents(), files(), frontMatter(), layouts(), renderHbs()],
}
`

describe('a custom property on a page at its site root', () => {
    const workdir = freshWorkdir('custom-property-climb')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': SITE_CONFIG,
            'files/bg/media/raw/icons/social-fb.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'files/bg/media/raw/icons/social-ig.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'files/bg/media/raw/icons/social-li.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'files/bg/styles/bundle.css': 'icon{mask:var(--icon-btn-src)}',
            'documents/bg/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': [
                '<!doctype html><head><link rel="stylesheet" href="/styles/bundle.css"></head><body>',
                // Correct from the bundle at bg/styles/. From the page — which
                // IS the site root — the `..` has nothing to pop and floors
                // onto a file that exists.
                '<span style="--a:url(&quot;../media/raw/icons/social-fb.svg&quot;)"></span>',
                // Resolves from neither.
                '<span style="--b:url(&quot;../media/raw/icons/nowhere.svg&quot;)"></span>',
                // One `..` too many even from the bundle: genuinely over-deep.
                '<span style="--c:url(&quot;../../media/raw/icons/social-ig.svg&quot;)"></span>',
                // Not a custom property: the page IS its base, unchanged.
                '<img src="../media/raw/icons/social-li.svg">',
                '</body>',
            ].join(''),
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        out = combined
    })

    it('does not report a climb for one that resolves cleanly from the bundle', () => {
        assert.doesNotMatch(out, /social-fb\.svg/,
            `correct where it is read from, so there is no climb to report\n${out}`)
    })

    it('still reports one that resolves from neither base', () => {
        assert.match(out, /nothing produced it: \.\.\/media\/raw\/icons\/nowhere\.svg/, out)
    })

    it('still reports one that is over-deep from the bundle itself', () => {
        // The check is not switched off for custom properties — it is asked
        // against the right base.
        assert.match(out, /climb 1 level/, out)
        assert.match(out, /social-ig\.svg/, out)
    })

    it('leaves an ordinary reference judged against the page', () => {
        assert.match(out, /social-li\.svg/,
            `an <img> src really is page-relative, and that has not changed\n${out}`)
    })
})

describe('two stylesheets at different depths', () => {
    const workdir = freshWorkdir('custom-property-precedence')
    after(() => cleanup(workdir))

    it('takes the base that resolves cleanly over one that only floors', async () => {
        // Which stylesheet substitutes the variable is not knowable from the
        // bytes, so every emitted one is a candidate — and they do not agree.
        // `bg/a.css` sits at the site root, so `../media/...` from it has
        // nothing to pop and floors onto a file that exists; `bg/styles/b.css`
        // resolves the same url cleanly.
        //
        // Scanned in path order, the flooring one comes first. Taking the
        // first match that resolves would report a climb for a reference some
        // other stylesheet reads correctly — so a clean resolution ends the
        // search and a floored one is only ever a fallback.
        await setupFixture(workdir, {
            'mikser.config.js': SITE_CONFIG,
            'files/bg/media/raw/icons/social-fb.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
            'files/bg/a.css': 'icon{mask:var(--icon-btn-src)}',
            'files/bg/styles/b.css': 'icon{mask:var(--icon-btn-src)}',
            'documents/bg/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>'
                + '<span style="--icon-btn-src:url(&quot;../media/raw/icons/social-fb.svg&quot;)"></span>'
                + '</body>',
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.doesNotMatch(combined, /climb \d+ level/,
            `one stylesheet reads it correctly, so there is no climb to report\n${combined}`)
        assert.doesNotMatch(combined, /social-fb\.svg/, combined)
    })
})

// The same markup has to get the same verdict on both build shapes.
//
// `path.dirname('index.html')` is '.', and resolveUrl counted that lone '.'
// as a real directory segment while dropping it from the url's own segments.
// So on a SINGLE-root build a `..` from the page at the output root popped the
// '.' instead of flooring: the target came out right and the climb came out
// zero, and the reference was silently exempt. On a MULTI-site build the site
// root makes pageDir genuinely empty, the same `..` floors, and the same
// markup was reported.
//
// Nothing looked wrong because the resolved path was correct either way. Only
// the verdict differed, and only for the one page on a site that sits at its
// root.

describe('a root page climbing above the output root', () => {
    const single = freshWorkdir('root-climb-single')
    const multi = freshWorkdir('root-climb-multi')
    after(async () => { await cleanup(single); await cleanup(multi) })

    const LAYOUT = '<!doctype html><body>'
        + '<img src="../media/logo.svg">'   // one `..` too many, floors onto a real file
        + '<img src="media/logo.svg">'      // the same file, addressed correctly
        + '</body>'
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>'

    it('is reported on a single-root build, as it always was on a multi-site one', async () => {
        await setupFixture(single, {
            'mikser.config.js': CONFIG,
            'files/media/logo.svg': SVG,
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': LAYOUT,
        })
        const { code, combined } = await runMikser(single)
        assert.equal(code, 0, combined)
        assert.match(combined, /climb 1 level/,
            `a root page's over-deep url was silently exempt here\n${combined}`)
        assert.match(combined, /\.\.\/media\/logo\.svg/, combined)
    })

    it('gets the same answer when the same page sits at a declared site root', async () => {
        await setupFixture(multi, {
            'mikser.config.js': SITE_CONFIG,
            'files/bg/media/logo.svg': SVG,
            'documents/bg/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': LAYOUT,
        })
        const { code, combined } = await runMikser(multi)
        assert.equal(code, 0, combined)
        assert.match(combined, /climb 1 level/,
            `the shape that always reported it must keep reporting it\n${combined}`)
    })

    it('does not invent a climb for the correctly addressed one', async () => {
        const { combined } = await runMikser(single, ['--force'])
        // Two references, one of them fine: the count is what says the fix
        // did not simply start flagging everything at the root.
        assert.match(combined, /1 of 2 reference\(s\) resolve above the site root/, combined)
    })
})

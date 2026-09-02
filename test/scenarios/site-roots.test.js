// A build that emits several sites resolves urls against the site, not the
// output folder.
//
// `asset`, `href` and `resource` build an output-root absolute destination and
// relativise it from the page. With one site per build the output folder IS
// the deployed root and that is right. With several it is not: out/a is the
// domain root, so a url computed against out/ carries one extra `..` for the
// site segment. A browser discards that climb rather than failing, so the page
// works and nothing says the base is wrong — until the same markup is used
// somewhere the flooring does not save it.
//
// `siteRoots` is what the engine cannot derive: it is a fact about where the
// bytes get deployed, not about the bytes. Declaring it used to change only
// the diagnostics, which made it a confusing thing for a config key to be. It
// now shapes the urls too, and the check reports what is left.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const CONFIG = `
import { documents, files, assets, frontMatter, renderHbs, assetUrlHelper, shares } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    siteRoots: ['a', 'b'],
    plugins: [
        documents(), files(), frontMatter(),
        assets({ assetsFolder: 'derived', presets: { web: { match: ['/files/media/**'] } } }),
        // A site root is a DEPLOYABLE unit: out/a is served alone, so anything
        // its pages reference has to exist under it. Sharing the derivatives
        // into each root is what makes that true, and it is what the url change
        // now assumes rather than relies on a browser to paper over.
        shares({ locations: [
            { source: 'derived', destination: 'a/derived' },
            { source: 'derived', destination: 'b/derived' },
        ] }),
        layouts(), renderHbs(), assetUrlHelper(),
    ],
}
`

const PRESET = [
    "import { mkdir, copyFile } from 'node:fs/promises'",
    "import path from 'node:path'",
    "export const revision = 1",
    "export default async function web({ entity }) {",
    "    await mkdir(path.dirname(entity.destination), { recursive: true })",
    "    await copyFile(entity.source ?? entity.uri, entity.destination)",
    "}",
].join('\n')

const LAYOUT =
    '<!doctype html><body>'
    + '<img id="real" src="{{url (asset "web" "/media/real.jpg")}}">'
    + '<img id="ghost" src="{{url (asset "web" "/media/ghost.jpg")}}">'
    + '</body>'

const PAGE = '---\nlayout: page\n---\n'

const srcOf = (html, id) => html.match(new RegExp(`id="${id}" src="([^"]*)"`))?.[1]
const climbs = (url) => (url.match(/\.\.\//g) ?? []).length

describe('several site roots in one build', () => {
    const workdir = freshWorkdir('site-roots')
    after(() => cleanup(workdir))
    let out

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'presets/web.js': PRESET,
            'files/media/real.jpg': 'not a jpeg; the preset only copies it',
            // shares() stats its source at onLoaded, before any derivative has
            // been rendered into it.
            'derived/.keep': '',
            'documents/a/index.html': PAGE,
            'documents/a/x/y/deep.html': PAGE,
            'documents/b/index.html': PAGE,
            'layouts/page.html.hbs': LAYOUT,
        })
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        out = combined
    })

    const read = (p) => readFile(path.join(workdir, 'out', p), 'utf8')

    it('urls differ by exactly the depth between the two pages', async () => {
        const shallow = srcOf(await read('a/index.html'), 'real')
        const deep = srcOf(await read('a/x/y/deep/index.html'), 'real')

        // out/a/index.html sits at the root of its site, so it climbs nothing.
        assert.equal(climbs(shallow), 0, `shallow page should not climb: ${shallow}`)
        // out/a/x/y/deep/index.html is three directories below it.
        assert.equal(climbs(deep) - climbs(shallow), 3,
            `expected exactly the depth difference\n  shallow ${shallow}\n  deep    ${deep}`)
        assert.ok(deep.endsWith(shallow), 'both should address the same derivative')
    })

    it('reports nothing over-deep — the base is right, so there is no climb to floor', () => {
        assert.doesNotMatch(out, /climb \d+ level/,
            `resolving against the site root should leave no over-deep url\n${out}`)
        assert.doesNotMatch(out, /resolve above the site root/, out)
    })

    it('each site addresses its own copy, not the other one', async () => {
        const a = srcOf(await read('a/index.html'), 'real')
        const b = srcOf(await read('b/index.html'), 'real')
        assert.equal(a, b, 'the url is the same string in both sites')
        // And it resolves inside each, which is what makes them separately
        // deployable — neither reaches across into the other.
        assert.doesNotMatch(a, /\.\.\//, `a page at a site root must not climb out of it: ${a}`)
    })

    it('a target nothing produced is still broken, from both depths', () => {
        // And it says WHY. The site root is stripped before the assets plugin
        // is asked, or the answer is lost on exactly the multi-site builds
        // where derivatives are shared into each root — the target resolves to
        // `a/derived/...` and nothing recognises the assets folder in it.
        assert.match(out, /No derivative was produced:.*ghost\.jpg.*from a\/index\.html.*no source file/,
            `expected the missing derivative reported, with its cause, from the shallow page\n${out}`)
        assert.match(out, /No derivative was produced:.*ghost\.jpg.*from a\/x\/y\/deep\/index\.html/,
            `expected it reported from the deep page too\n${out}`)
    })

    it('single-root builds are untouched: no declaration, no change', async () => {
        // The compatibility claim, exercised rather than asserted. siteRootFor
        // returns '' with nothing declared, and the url is a plain relative
        // path exactly as before.
        const solo = freshWorkdir('site-roots-solo')
        try {
            await setupFixture(solo, {
                'mikser.config.js': CONFIG.replace("    siteRoots: ['a', 'b'],\n", ''),
                'presets/web.js': PRESET,
                'files/media/real.jpg': 'x',
                'derived/.keep': '',
                'documents/a/x/y/deep.html': PAGE,
                'layouts/page.html.hbs': LAYOUT,
            })
            const { code } = await runMikser(solo)
            assert.equal(code, 0)
            const url = srcOf(await readFile(path.join(solo, 'out/a/x/y/deep/index.html'), 'utf8'), 'real')
            // Four directories below the OUTPUT root now, since that is the
            // root again: a, x, y, deep.
            assert.equal(climbs(url), 4, `expected output-root relative: ${url}`)
        } finally {
            await cleanup(solo)
        }
    })
})

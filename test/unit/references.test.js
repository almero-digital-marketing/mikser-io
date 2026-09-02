// Unit coverage for the emitted-output reference check.
//
// The interesting part is not "does the file exist" — it is resolving a url
// the way a BROWSER does, because that is the only way to tell apart the two
// outcomes that matter:
//
//   BROKEN     resolves to no file
//   OVER-DEEP  resolves only because a `..` run was floored at the site root
//
// The second is the early warning for the first: it loads today and breaks the
// moment the same markup renders one level deeper.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { extractReferences, resolveUrl, siteRootFor } from '../../src/references.js'

// extractReferences reports where each url's base is, not just the url:
// a `url()` in a custom property does not resolve against the page.
const urls = (source) => extractReferences(source).map(r => r.url)

describe('extractReferences', () => {
    it('takes src, href, poster and css url()', () => {
        const refs = urls(
            '<img src="a.jpg"><a href="/b/"><video poster="c.png">'
            + '<div style="background-image:url(\'d.webp\')">')
        assert.deepEqual(refs.sort(), ['/b/', 'a.jpg', 'c.png', 'd.webp'].sort())
    })

    it('splits srcset into its candidate urls, dropping descriptors', () => {
        const refs = urls('<img srcset="a.jpg 1x, b.jpg 2x, c.jpg 640w">')
        assert.deepEqual(refs.sort(), ['a.jpg', 'b.jpg', 'c.jpg'])
    })

    it('skips other origins, inline payloads, fragments and actions', () => {
        const refs = urls(
            '<a href="https://x.test/y"><a href="//cdn.test/z"><a href="#top">'
            + '<a href="mailto:a@b.c"><a href="tel:+123"><img src="data:image/gif;base64,AAA">')
        assert.deepEqual(refs, [])
    })

    it('skips an external url that arrives percent-encoded', () => {
        // How a maps link is built when the target is a query parameter: it has
        // no scheme until decoded, so a naive check resolves the whole encoded
        // string as a path segment.
        const refs = urls(
            '<a href="https%3A%2F%2Fmaps.test%2F%3Fq%3D10%20Silistra%20St.">')
        assert.deepEqual(refs, [])
    })

    it('decodes entity-encoded quotes inside an inline style', () => {
        // A CSS custom property in a style attribute is the common source. Left
        // encoded, the captured url is the entity text, which resolves nowhere
        // and reports as broken — false positives that bury the real ones.
        const refs = urls(
            '<i style="--icon-src:url(&quot;../media/raw/icons/x.svg&quot;)"></i>')
        assert.deepEqual(refs, ['../media/raw/icons/x.svg'])
    })

    it('marks a url that came from a custom property', () => {
        // Its base is the stylesheet that substitutes the variable, not the
        // page that declared it — so the caller has to be able to tell.
        const refs = extractReferences(
            '<i style="--icon-btn-src:url(&quot;../media/icons/x.svg&quot;)"></i>')
        assert.deepEqual(refs, [{ url: '../media/icons/x.svg', customProperty: true }])
    })

    it('does not mark an ordinary url() as one', () => {
        const refs = extractReferences('<div style="background-image:url(\'d.webp\')">')
        assert.deepEqual(refs, [{ url: 'd.webp', customProperty: false }])
    })

    it('marks it in a stylesheet too, not only in a style attribute', () => {
        const refs = extractReferences(':root{--icon-btn-src:url("../media/icons/x.svg")}')
        assert.deepEqual(refs, [{ url: '../media/icons/x.svg', customProperty: true }])
    })
})

describe('resolveUrl', () => {
    it('resolves a relative url against the page directory', () => {
        assert.deepEqual(
            resolveUrl('aparati/hera', '../../derived/web/x.webp', { root: 'bg' }),
            { target: 'bg/derived/web/x.webp', overDeep: false, floored: 0 })
    })

    it('resolves a root-absolute url against the site root, ignoring the page', () => {
        assert.deepEqual(
            resolveUrl('aparati/hera', '/derived/web/x.webp', { root: 'bg' }),
            { target: 'bg/derived/web/x.webp', overDeep: false, floored: 0 })
    })

    it('reports how far it climbed, not merely that it did', () => {
        // The distance is what lets N urls with one cause collapse into one
        // warning instead of N — which is the difference between a signal and
        // a channel someone mutes.
        assert.equal(resolveUrl('a', '../../../x.svg', { root: 'r' }).floored, 2)
        assert.equal(resolveUrl('a/b/c', '../../../x.svg', { root: 'r' }).floored, 0)
    })

    it('floors a climb above the root and says so', () => {
        // Three `..` from one level down: a browser pops one, discards the rest,
        // and loads the file. It works, and it is one level from not working.
        assert.deepEqual(
            resolveUrl('aparati', '../../../derived/web/x.webp', { root: 'bg' }),
            { target: 'bg/derived/web/x.webp', overDeep: true, floored: 2 })
    })

    it('does not flag an exact climb to the root', () => {
        assert.deepEqual(
            resolveUrl('aparati', '../derived/x.webp', { root: 'bg' }),
            { target: 'bg/derived/x.webp', overDeep: false, floored: 0 })
    })

    it('drops the query and fragment before resolving', () => {
        assert.deepEqual(
            resolveUrl('', 'x.css?v=2#top', { root: '' }),
            { target: 'x.css', overDeep: false, floored: 0 })
    })

    it("does not count a root page's `.` as a directory to climb out of", () => {
        // path.dirname('index.html') is '.', and that lone '.' used to count
        // as a real segment: a `..` popped it instead of flooring, so the
        // target came out right and the verdict came out wrong. A root page's
        // over-deep url was silently exempt on a single-root build and
        // reported on a multi-site one, where the site root makes pageDir
        // genuinely empty. Same markup, two answers.
        const dot = resolveUrl('.', '../media/logo.svg')
        assert.equal(dot.target, 'media/logo.svg', 'the target was never wrong')
        assert.equal(dot.floored, 1, 'but the climb was not counted')
        assert.equal(dot.overDeep, true)

        // An empty pageDir has always said this — the two now agree.
        assert.deepEqual(resolveUrl('', '../media/logo.svg'), dot)
    })

    it("still resolves a root page's ordinary url without climbing", () => {
        assert.deepEqual(
            resolveUrl('.', 'media/logo.svg'),
            { target: 'media/logo.svg', overDeep: false, floored: 0 })
    })
})

describe('siteRootFor', () => {
    // A build emitting one subtree per language, each deployed to its own
    // domain, makes out/bg the site root — so every url carries one extra `..`
    // for the language segment. Resolving against the output root would miss
    // the over-escape entirely and call the working urls broken.
    const roots = ['bg', 'en', 'mk']

    it('picks the declared root containing the file', () => {
        assert.equal(siteRootFor('bg/aparati/index.html', roots), 'bg')
        assert.equal(siteRootFor('en/devices/hera/index.html', roots), 'en')
    })

    it('falls back to the output root for a file outside every declared root', () => {
        assert.equal(siteRootFor('shared/index.html', roots), '')
    })

    it('treats no declaration as one root at the output folder', () => {
        assert.equal(siteRootFor('bg/aparati/index.html', []), '')
    })

    it('prefers the longest match when roots nest', () => {
        assert.equal(siteRootFor('a/b/page.html', ['a', 'a/b']), 'a/b')
    })
})

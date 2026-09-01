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

describe('extractReferences', () => {
    it('takes src, href, poster and css url()', () => {
        const refs = extractReferences(
            '<img src="a.jpg"><a href="/b/"><video poster="c.png">'
            + '<div style="background-image:url(\'d.webp\')">')
        assert.deepEqual(refs.sort(), ['/b/', 'a.jpg', 'c.png', 'd.webp'].sort())
    })

    it('splits srcset into its candidate urls, dropping descriptors', () => {
        const refs = extractReferences('<img srcset="a.jpg 1x, b.jpg 2x, c.jpg 640w">')
        assert.deepEqual(refs.sort(), ['a.jpg', 'b.jpg', 'c.jpg'])
    })

    it('skips other origins, inline payloads, fragments and actions', () => {
        const refs = extractReferences(
            '<a href="https://x.test/y"><a href="//cdn.test/z"><a href="#top">'
            + '<a href="mailto:a@b.c"><a href="tel:+123"><img src="data:image/gif;base64,AAA">')
        assert.deepEqual(refs, [])
    })

    it('skips an external url that arrives percent-encoded', () => {
        // How a maps link is built when the target is a query parameter: it has
        // no scheme until decoded, so a naive check resolves the whole encoded
        // string as a path segment.
        const refs = extractReferences(
            '<a href="https%3A%2F%2Fmaps.test%2F%3Fq%3D10%20Silistra%20St.">')
        assert.deepEqual(refs, [])
    })

    it('decodes entity-encoded quotes inside an inline style', () => {
        // A CSS custom property in a style attribute is the common source. Left
        // encoded, the captured url is the entity text, which resolves nowhere
        // and reports as broken — false positives that bury the real ones.
        const refs = extractReferences(
            '<i style="--icon-src:url(&quot;../media/raw/icons/x.svg&quot;)"></i>')
        assert.deepEqual(refs, ['../media/raw/icons/x.svg'])
    })
})

describe('resolveUrl', () => {
    it('resolves a relative url against the page directory', () => {
        assert.deepEqual(
            resolveUrl('aparati/hera', '../../derived/web/x.webp', { root: 'bg' }),
            { target: 'bg/derived/web/x.webp', overDeep: false })
    })

    it('resolves a root-absolute url against the site root, ignoring the page', () => {
        assert.deepEqual(
            resolveUrl('aparati/hera', '/derived/web/x.webp', { root: 'bg' }),
            { target: 'bg/derived/web/x.webp', overDeep: false })
    })

    it('floors a climb above the root and says so', () => {
        // Three `..` from one level down: a browser pops one, discards the rest,
        // and loads the file. It works, and it is one level from not working.
        assert.deepEqual(
            resolveUrl('aparati', '../../../derived/web/x.webp', { root: 'bg' }),
            { target: 'bg/derived/web/x.webp', overDeep: true })
    })

    it('does not flag an exact climb to the root', () => {
        assert.deepEqual(
            resolveUrl('aparati', '../derived/x.webp', { root: 'bg' }),
            { target: 'bg/derived/x.webp', overDeep: false })
    })

    it('drops the query and fragment before resolving', () => {
        assert.deepEqual(
            resolveUrl('', 'x.css?v=2#top', { root: '' }),
            { target: 'x.css', overDeep: false })
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

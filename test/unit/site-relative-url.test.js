// The url every helper builds, resolved against the site the page belongs to.
//
// `asset`, `href` and `resource` all have the same shape: an output-root
// absolute destination, relativised from the page. With one site per build the
// output folder IS the deployed root and that is correct. With several it is
// not — out/a is the domain root, so a url computed against out/ carries one
// extra `..` for the site segment, which a browser discards rather than
// failing on. The page works and nothing says the base is wrong.
//
// One function so the three helpers cannot disagree, and so the cross-site
// case is decided once.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { siteRelativeUrl, siteRootFor } from '../../src/utils/index.js'

const ROOTS = ['a', 'b']

describe('siteRelativeUrl', () => {
    it('addresses a shared asset inside the page own site', () => {
        // The case that was wrong. /derived is outside every root, so it has to
        // be reached from within the site — out/a/derived, not out/derived,
        // which is not even served when out/a is deployed alone.
        assert.equal(siteRelativeUrl('/a/index.html', '/derived/x.webp', ROOTS), 'derived/x.webp')
        assert.equal(siteRelativeUrl('/a/p/index.html', '/derived/x.webp', ROOTS), '../derived/x.webp')
        assert.equal(siteRelativeUrl('/a/p/q/index.html', '/derived/x.webp', ROOTS), '../../derived/x.webp')
    })

    it('climbs exactly the page depth and never past the site root', () => {
        for (const [page, expected] of [
            ['/a/index.html', 0],
            ['/a/p/index.html', 1],
            ['/a/p/q/index.html', 2],
            ['/a/p/q/r/index.html', 3],
        ]) {
            const url = siteRelativeUrl(page, '/derived/x.webp', ROOTS)
            assert.equal((url.match(/\.\.\//g) ?? []).length, expected,
                `${page} should climb ${expected}: ${url}`)
        }
    })

    it('leaves a link within the same site as an ordinary relative path', () => {
        assert.equal(siteRelativeUrl('/a/p/index.html', '/a/q/index.html', ROOTS), '../q/index.html')
    })

    it('does not invent a path to another site', () => {
        // On a per-domain deploy the other root is a different origin and no
        // relative path reaches it. Rewriting it into this site would produce a
        // url that looks right and points at nothing; left alone, the reference
        // check reports it broken, which is the truth.
        const url = siteRelativeUrl('/a/p/index.html', '/b/q/index.html', ROOTS)
        assert.equal(url, '../../b/q/index.html')
        assert.doesNotMatch(url, /^\.\.\/a\//, 'must not be re-rooted into the page own site')
    })

    it('is byte-identical to a plain relative path when nothing is declared', () => {
        // The compatibility guarantee: a single-site build cannot move.
        for (const page of ['/index.html', '/a/index.html', '/a/p/q/index.html']) {
            for (const target of ['/derived/x.webp', '/a/q/index.html', '/styles/site.css']) {
                assert.equal(siteRelativeUrl(page, target, []),
                    siteRelativeUrl(page, target, undefined),
                    'undefined and empty must behave alike')
            }
        }
        assert.equal(siteRelativeUrl('/a/p/q/index.html', '/derived/x.webp', []), '../../../derived/x.webp')
    })

    it('leaves a page outside every declared root alone', () => {
        // Not every file has to belong to a site: a shared 404 page, a feed at
        // the output root. There is no site to resolve against, so it keeps the
        // output-root behaviour.
        assert.equal(siteRelativeUrl('/shared/index.html', '/derived/x.webp', ROOTS), '../derived/x.webp')
    })

    it('tolerates an entity with no destination', () => {
        assert.doesNotThrow(() => siteRelativeUrl(undefined, '/derived/x.webp', ROOTS))
    })
})

describe('siteRootFor', () => {
    it('accepts a path with or without a leading slash', () => {
        // Entity destinations carry one; output-relative file paths do not.
        assert.equal(siteRootFor('/a/p/index.html', ROOTS), 'a')
        assert.equal(siteRootFor('a/p/index.html', ROOTS), 'a')
    })

    it('does not match a root that is only a name prefix', () => {
        assert.equal(siteRootFor('/about/index.html', ['a']), '',
            '"a" must not swallow "about"')
    })
})

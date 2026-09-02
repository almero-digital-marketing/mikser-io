// What the build actually shipped, checked against what it actually wrote.
//
// The URL helpers BUILD paths from a naming convention rather than resolving
// an entity, so they cannot fail — `asset` composes
// `<assetsFolder>/<preset>/<path>` with whatever extension it was handed and
// never asks whether that file exists. A wrong preset name, a wrong extension,
// or a source whose derivative silently failed to render all produce a
// well-formed url pointing at nothing, and every existing surface stays green:
// nothing threw, --audit-output compares snapshots against what was rendered rather
// than against what those renders point at, and mikser_refs_broken tracks
// document-to-document refs, not urls.
//
// This reads the emitted bytes instead. Everything it needs is on disk at the
// end of a cycle and nothing has to be inferred.
//
// It is deliberately NOT the same check as `asset-missing` in engine.js. That
// one records helper CALLS on the render track and tests the output-root
// absolute destination each one built; it knows the referencing entity, and it
// sees urls that never reach an html file at all (a sitemap, a feed). This one
// sees everything that shipped, including paths written by hand, and resolves
// them the way a browser would — which is the only way to catch a url that
// resolves solely because the browser floored a `..` run at the site root.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { globby } from 'globby'
import { siteRootFor } from './utils.js'

// Documents that can carry a reference. Anything else in the output is either
// an asset itself or something whose internal structure this has no business
// guessing at.
const SCANNED = ['**/*.html', '**/*.htm', '**/*.css']

// Attributes whose value is a single url.
const ATTR = /(?:src|href|poster|data-bg)\s*=\s*["']([^"']*)["']/gi
// srcset / imagesrcset: a comma-separated list of `url [descriptor]`.
const SRCSET = /(?:img|image)?srcset\s*=\s*["']([^"']*)["']/gi
// css url(), in a stylesheet and in an inline style attribute alike.
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi

// A url this check has nothing to say about: another origin, an inline
// payload, a fragment or an in-page action. `//host/path` is protocol-relative
// and therefore external too.
function isExternal(url) {
    if (!url) return true
    const u = url.trim()
    if (!u) return true
    if (u.startsWith('#') || u.startsWith('//')) return true
    // Template syntax that reached the output unrendered — `{{link}}`,
    // `${x}`, `<%= y %>`. It is not a path, so "resolves to nothing" says
    // nothing useful about it; the real problem is that it did not render,
    // which is a different question than this one is asking. Documentation
    // pages showing escaped template syntax are the common source, and they
    // are not broken at all.
    if (/\{\{|\}\}|\$\{|<%/.test(u)) return true
    // A scheme — http:, data:, mailto:, tel:, javascript:.
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return true
    // The same thing percent-encoded, which is how an external url arrives
    // when it was built as a query parameter — `https%3A%2F%2F...` in a maps
    // link. It has no scheme until it is decoded, so the test above misses it
    // and the whole encoded string gets resolved as a path segment.
    try {
        if (/^[a-z][a-z0-9+.-]*:/i.test(decodeURIComponent(u))) return true
    } catch { /* malformed escape — treat as a path and let it resolve */ }
    return false
}

// Quotes inside an attribute value arrive encoded, and a CSS custom property
// in an inline style is the common way that happens:
//
//     style="--icon-src:url(&quot;../media/raw/icons/x.svg&quot;)"
//
// Without decoding, the captured url is the entity text itself, which resolves
// nowhere and reports as broken — a false positive that would have buried the
// real ones. Only the quote and ampersand forms are decoded; turning &lt; back
// into a bracket could invent markup that was deliberately escaped.
function decodeEntities(source) {
    return source
        .replace(/&quot;|&#34;/g, '"')
        .replace(/&apos;|&#39;/g, "'")
        .replace(/&amp;/g, '&')
}

// Everything a page points at, as raw url strings.
export { siteRootFor }

export function extractReferences(rawSource) {
    const source = decodeEntities(rawSource)
    const found = new Set()
    for (const [, url] of source.matchAll(ATTR)) found.add(url)
    for (const [, , url] of source.matchAll(CSS_URL)) found.add(url)
    for (const [, list] of source.matchAll(SRCSET)) {
        for (const candidate of list.split(',')) {
            const url = candidate.trim().split(/\s+/)[0]
            if (url) found.add(url)
        }
    }
    return [...found].filter(u => !isExternal(u))
}

// Resolve the way a browser does, which is the whole point.
//
// A browser walks the page's directory segments, pops one per `..`, and
// DISCARDS a `..` that would climb above the origin root — it does not error
// and it does not escape. So a url with one `..` too many still loads, and the
// page looks correct while carrying a path that breaks the moment the same
// markup is used one level deeper. That flooring is what `overDeep` records.
//
// `pageDir` and the result are both relative to `root`.
export function resolveUrl(pageDir, url, { root = '' } = {}) {
    const clean = url.split('#')[0].split('?')[0]
    const absolute = clean.startsWith('/')
    const segments = clean.split('/').filter(s => s !== '' && s !== '.')

    const parts = absolute ? [] : pageDir.split('/').filter(Boolean)
    // How FAR above the root it climbed, not merely that it did. When every
    // over-deep url on a site climbs the same distance, that is one base
    // mismatch reported once — not N findings, which is how a real signal gets
    // filtered.
    let floored = 0
    for (const segment of segments) {
        if (segment !== '..') { parts.push(segment); continue }
        if (parts.length) parts.pop()
        else floored++            // a climb above the root, discarded
    }
    return { target: path.join(root, ...parts), overDeep: floored > 0, floored }
}

// Everything the output points at that is not there.
//
// Returns { broken, overDeep, checked }, where each entry is
// { url, target, files } — the target with the pages that named it, because
// "this is missing" is only actionable next to "and these link it".
export async function checkReferences(outputFolder, { siteRoots = [] } = {}) {
    const files = await globby(SCANNED, {
        cwd: outputFolder,
        followSymbolicLinks: false,
        suppressErrors: true,
    })

    const broken = new Map()
    const overDeepRefs = new Map()
    let checked = 0
    // Existence is the expensive part and the same target repeats across a
    // site — one lookup each.
    const exists = new Map()

    for (const file of files) {
        let source
        try { source = await readFile(path.join(outputFolder, file), 'utf8') }
        catch { continue }

        const root = siteRootFor(file, siteRoots)
        // The page's directory, relative to its own site root.
        const pageDir = path.dirname(file).slice(root.length).replace(/^\/+/, '')

        for (const url of extractReferences(source)) {
            const { target, overDeep, floored } = resolveUrl(pageDir, url, { root })
            checked++

            if (!exists.has(target)) {
                exists.set(target, existsSync(path.join(outputFolder, target)))
            }
            // Broken outranks over-deep: a url that resolves nowhere is the
            // failure, and adding that it is also one level too deep is noise.
            const bucket = !exists.get(target) ? broken : (overDeep ? overDeepRefs : null)
            if (!bucket) continue

            const key = `${target} ${url}`
            if (!bucket.has(key)) bucket.set(key, { url, target, floored, files: [] })
            bucket.get(key).files.push(file)
        }
    }

    // "It was never written" and "it is written somewhere else" are different
    // problems with one symptom, and they were reported with one sentence.
    //
    // A missing target whose FILE exists elsewhere in the output is almost
    // always a base problem: the url was built from the wrong root, or with a
    // segment too many. Naming where the file actually is turns "resolves to
    // nothing" into the answer. A target that exists nowhere really was never
    // produced — a preset that did not run, an extension nothing emits.
    //
    // Indexed only when something is broken, so a clean build pays nothing.
    if (broken.size) {
        const byName = new Map()
        for (const file of await globby('**/*', {
            cwd: outputFolder, followSymbolicLinks: true, onlyFiles: true, suppressErrors: true,
        })) {
            const name = path.basename(file)
            if (!byName.has(name)) byName.set(name, [])
            byName.get(name).push(file)
        }
        for (const entry of broken.values()) {
            const elsewhere = (byName.get(path.basename(entry.target)) ?? [])
                .filter(f => f !== entry.target)
            if (elsewhere.length) entry.elsewhere = elsewhere.slice(0, 3)
        }
    }

    return { broken: [...broken.values()], overDeep: [...overDeepRefs.values()], checked }
}

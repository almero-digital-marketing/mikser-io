// Resolving a $-ref inside the asking document's language.
//
// A multilingual catalog is one catalog. A $-ref from a Bulgarian page has to
// find the Bulgarian target, so the site scopes the lookup:
//
//     findEntity({ ...refFilter(ref), 'meta.lang': lang })
//
// That scoping is load-bearing. Without it a page referencing an untranslated
// document silently resolves to another language's copy, and "unresolved ref"
// is the signal that a translation is missing.
//
// It also makes shared data unreachable. Data imported ONCE because it has no
// language — a price list, a specification table, a taxonomy — carries no
// `meta.lang`, so a scoped filter excludes it on every build and every page.
// Importing it per language instead means maintaining the same rows three
// times, which is what the sheet's owner would have to do.
//
// `findRef(ref, scope)` is the supported resolution: the scope first, then a
// target OUTSIDE the scope entirely. The narrowing is the whole point — an
// untranslated document HAS a language, just the wrong one, so it still fails
// to resolve and still warns.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), yaml(), layouts(), renderHbs()] }
`

// The sidecar the site writes: resolve this page's refs in this page's
// language. It imports findRef rather than re-deriving the filter, which is
// the point of the export.
const SIDECAR = `
import { findRef } from 'mikser-io'
export async function load({ entity }) {
    const scope = entity.meta?.lang ? { 'meta.lang': entity.meta.lang } : undefined
    const price = await findRef(entity.meta?.$price, scope)
    const shared = await findRef('/shared', scope)
    const about = await findRef('/about', scope)
    const absent = await findRef('/en-only', scope)
    return {
        price: price?.meta?.price ?? 'unresolved',
        about: about?.id ?? 'unresolved',
        shared: shared?.id ?? 'unresolved',
        absent: absent?.id ?? 'unresolved',
    }
}
`
const LAYOUT = '<p>price:{{data.price}}|about:{{data.about}}|absent:{{data.absent}}|shared:{{data.shared}}</p>'
const device = (lang) => `---\nlang: ${lang}\nlayout: device\nhref: /${lang}/device\n---\n`

describe('a $-ref resolved within the asking document language', () => {
    const workdir = freshWorkdir('scoped-ref')
    const page = (lang) => readFile(path.join(workdir, `out/${lang}/device/index.html`), 'utf8')
    const rendered = (combined) => Number((combined.match(/Rendered: (\d+)/) ?? [0, 0])[1])
    const build = async (args) => {
        const { code, combined } = await runMikser(workdir, args)
        assert.equal(code, 0, combined)
        return rendered(combined)
    }

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/device.hbs': LAYOUT,
            'layouts/device.js': SIDECAR,
            // Language-neutral: imported once, no meta.lang at all. This is
            // the shape a sheet of prices or specifications arrives in.
            'documents/prices/sku-1.yml': 'href: /prices/sku-1\nprice: 42\n',
            // The same href in two languages, which is what the scope is for.
            'documents/bg/about.md': '---\nlang: bg\nhref: /about\n---\n',
            'documents/en/about.md': '---\nlang: en\nhref: /about\n---\n',
            // Exists in ENGLISH only — an untranslated document.
            'documents/en/en-only.md': '---\nlang: en\nhref: /en-only\n---\n',
            // One ref, two candidates: a neutral row AND an English page.
            // The English id sorts first, so a fallback that fetches ANY
            // match and then inspects it gets the English one and gives up.
            'documents/shared.yml': 'href: /shared\nkind: neutral\n',
            'documents/en/shared.md': '---\nlang: en\nhref: /shared\n---\n',
            'documents/bg/device.md': device('bg') + '',
            'documents/en/device.md': device('en') + '',
        })
        await writeFile(path.join(workdir, 'documents/bg/device.md'),
            '---\nlang: bg\nlayout: device\nhref: /bg/device\n$price: /prices/sku-1\n---\n')
        await writeFile(path.join(workdir, 'documents/en/device.md'),
            '---\nlang: en\nlayout: device\nhref: /en/device\n$price: /prices/sku-1\n---\n')
        await build()
    })
    after(async () => { await cleanup(workdir) })

    it('reaches a language-neutral target from a scoped page', async () => {
        assert.match(await page('bg'), /price:42/,
            'the Bulgarian page could not see a row that has no language')
        assert.match(await page('en'), /price:42/)
    })

    it('still prefers the target in the page language', async () => {
        // The reason the scope exists. A blanket unscoped fallback would make
        // this resolve to whichever copy the catalog returned first.
        assert.match(await page('bg'), /about:\/documents\/bg\/about\.md/)
        assert.match(await page('en'), /about:\/documents\/en\/about\.md/)
    })

    it('still refuses a target in ANOTHER language', async () => {
        // The guard. An untranslated document has a language — the wrong one
        // — so it must stay unresolved and keep warning. Only a target with
        // no language at all is reachable by fallback.
        assert.match(await page('bg'), /absent:unresolved/,
            'a Bulgarian page resolved an English-only document')
        assert.match(await page('en'), /absent:\/documents\/en\/en-only\.md/,
            'and the English page must still find it')
    })

    it('finds the neutral target even when another language also matches', async () => {
        // The shape that separates asking for the absent key from fetching
        // any match and inspecting it. With both a neutral row and an
        // English page answering to /shared, "take the first match, keep it
        // only if it has no language" returns the English one and therefore
        // nothing — so the neutral target is unreachable, and which one wins
        // is row order rather than a decision.
        assert.match(await page('bg'), /shared:\/documents\/shared\.yml/,
            'the fallback did not ask for a target with no language')
        assert.match(await page('en'), /shared:\/documents\/en\/shared\.md/,
            'and a language that HAS a target must still prefer it')
    })

    it('re-renders the pages when the neutral row changes', async () => {
        // The dependency is recorded by the $-ref edge, which core resolves
        // language-blind, so it reaches the neutral row whatever the site's
        // resolver does. Worth asserting rather than assuming: it is the
        // reason a $-ref beats looking the row up by SKU in a sidecar.
        await writeFile(path.join(workdir, 'documents/prices/sku-1.yml'),
            'href: /prices/sku-1\nprice: 99\n')
        assert.ok(await build() >= 2, 'editing the neutral row rendered nothing')
        assert.match(await page('bg'), /price:99/)
        assert.match(await page('en'), /price:99/)
    })

    it('settles when nothing changes', async () => {
        assert.equal(await build(), 0)
    })
})

// index.js re-exports eighteen modules with `export *`. When two of them export
// the same name, ESM does not error and does not pick a winner — the spec makes
// the name AMBIGUOUS and excludes it from the namespace entirely. The export
// silently ceases to exist.
//
// That is exactly what happened when catalog.js gained a `deleteEntity`
// alongside lifecycle.js's: `import { deleteEntity } from 'mikser-io'` became
// undefined, and useSource's `core` destructure handed every file source an
// undefined delete. The unit suite stayed green the whole time — unit tests
// import from `src/` directly, where no ambiguity exists. Only a spawned
// process importing the package index could see it.
//
// So this asserts on the package surface itself: no two star-re-exported
// modules may claim the same name.

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const ROOT = new URL('../../', import.meta.url)

describe('package exports are unambiguous', () => {
    let modules

    before(async () => {
        const index = await readFile(new URL('index.js', ROOT), 'utf8')
        // Only bare `export * from` participates in ambiguity. `export * as ns`
        // binds a single name and cannot collide this way.
        const specifiers = [...index.matchAll(/^export \* from '(.+?)'/gm)].map((m) => m[1])
        assert.ok(specifiers.length > 5, 'expected index.js to star-re-export the engine modules')

        modules = await Promise.all(
            specifiers.map(async (specifier) => {
                const ns = await import(new URL(specifier, ROOT).href)
                // `export *` never forwards `default` — excluding it here keeps
                // render.js's and postprocess.js's worker entries from reading
                // as clashes.
                const names = Object.keys(ns).filter((n) => n !== 'default')
                return { specifier, ns, names }
            }),
        )
    })

    it('no name is exported by two star-re-exported modules', () => {
        const owners = new Map()
        for (const { specifier, ns, names } of modules) {
            for (const name of names) {
                if (!owners.has(name)) owners.set(name, [])
                owners.get(name).push({ specifier, value: ns[name] })
            }
        }

        const clashes = [...owners]
            .filter(([, from]) =>
                // Ambiguity is about BINDINGS, not names. manifest.js re-exports
                // utils.js's `inputHashOf` — one binding reached two ways, which
                // the spec resolves happily. Only distinct values are a clash.
                from.length > 1 && new Set(from.map((f) => f.value)).size > 1,
            )
            .map(([name, from]) => `${name} — exported by ${from.map((f) => f.specifier).join(' and ')}`)

        assert.deepEqual(
            clashes,
            [],
            'these names are silently absent from the mikser-io namespace:\n  ' + clashes.join('\n  '),
        )
    })

    it('every name a module exports survives into the package namespace', async () => {
        // The complementary check. The clash test above reasons about sources;
        // this one reads the actual namespace, so a collision arriving through
        // any other route still fails here.
        const index = await import(new URL('index.js', ROOT).href)
        const missing = []
        for (const { specifier, names } of modules) {
            for (const name of names) {
                if (!(name in index)) missing.push(`${name} (from ${specifier})`)
            }
        }
        assert.deepEqual(missing, [], 'names dropped from the namespace:\n  ' + missing.join('\n  '))
    })
})

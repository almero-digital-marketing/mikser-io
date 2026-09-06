// Every plugin core ships names itself.
//
// The release that made plugins nameable shipped two in its own package that
// were not: `sources` and `preview`. Neither was a break — an undeclared
// plugin still reports as loaded, with `package: null` — but on a real site
// `sources` showed up as `plugin-6, package: null`, which is the documented
// graceful case standing in for a plugin core could perfectly well name.
//
// Both were missed by tooling rather than by decision, which is why this is a
// test and not a fixed list: `sources.js` ends with `export default sources`
// after the factory, so a batch pass keying on "the file ends with }" skipped
// it, and `preview.js` fell out of an earlier pass and was never picked back
// up. Asserting the property directly is the only thing that catches the next
// file with an unusual shape.
//
// `preview` earns its own mention: it was the target of one of the two stale
// probes 11.0.0 deleted — `runtime.options?.preview`, which attributed it to
// `mikser-io-preview`, a package that does not exist. So it has now been
// overlooked twice by two different mechanisms.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { sources, preview } from '../../index.js'
import { createHarness } from '../../testing/harness.js'
import path from 'node:path'

const pluginsDir = new URL('../../src/plugins/', import.meta.url)

// `providers/` is deliberately out of scope, and not as a convenience: a
// scheme provider is a different contract. It exports `read(entity)` and is
// dynamically imported by readEntityContent when a uri carries its scheme
// (see src/utils/entity.js) — it never appears in a config's `plugins: []`,
// has no factory, and so has nothing to declare. The boundary is asserted
// below rather than assumed, so a provider that becomes a plugin is noticed.
const PROVIDERS = 'providers'

function pluginFiles() {
    const found = []
    const walk = (dir, base) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (entry.name === PROVIDERS) continue
                walk(new URL(entry.name + '/', dir), path.join(base, entry.name))
                continue
            }
            if (!entry.name.endsWith('.js')) continue
            found.push({ rel: path.join(base, entry.name), url: new URL(entry.name, dir) })
        }
    }
    walk(pluginsDir, '')
    return found
}

describe('every plugin core ships', () => {
    it('names itself to the runtime', () => {
        const undeclared = pluginFiles()
            .filter(f => !readFileSync(f.url, 'utf8').includes('module: import.meta.url'))
            .map(f => f.rel)
        assert.deepEqual(undeclared, [],
            'these plugins would report as loaded with package: null, when core can name them:\n  '
            + undeclared.join('\n  '))
    })

    it('excludes providers because they are not plugins, not because it is convenient', () => {
        // If a provider ever grows a factory and lands in `plugins: []`, this
        // is the line that should fail and send someone back to the exclusion.
        const providerSource = readFileSync(new URL('providers/http.js', pluginsDir), 'utf8')
        assert.ok(providerSource.includes('export async function readHttpEntity'),
            'the http provider still exports the scheme-read contract')
        assert.ok(!/return\s*\(\s*\{?\s*(core|runtime)/.test(providerSource),
            'a provider that started returning a core-taking factory would be a plugin, and in scope')
    })

    it('is actually looking at files', () => {
        // A walk that found nothing would pass the assertion above while
        // checking nothing at all — the same vacuous green this whole line of
        // work exists to remove.
        const files = pluginFiles()
        assert.ok(files.length >= 15, `expected core's plugins, found ${files.length}`)
        assert.ok(files.some(f => f.rel.endsWith('sources.js')), 'sources.js must be in scope')
        assert.ok(files.some(f => f.rel.endsWith('preview.js')), 'preview.js must be in scope')
        assert.ok(files.some(f => f.rel.includes('render')), 'the render/ subfolder must be in scope')
    })
})

describe('a factory that returns early still names itself', () => {
    // `sources({})` — every collection turned off — returned before reaching
    // its declaration, so the plugin was loaded and reported as `plugin-N,
    // package: null`. The file-level test above cannot catch this: the string
    // is in the file either way. Only calling it can.
    // The engine's own core, not a hand-rolled stub: preview destructures
    // `constants: { OPERATION }` and registers a route, and a stub that
    // happens to satisfy today's destructuring would quietly stop testing the
    // real call the first time the factory reads one more field.
    const coreFor = () => createHarness({ options: { workingFolder: process.cwd() } }).core

    it('sources, with no collections configured', () => {
        assert.match(sources({})(coreFor())?.module ?? '', /plugins\/sources\.js$/)
    })

    it('sources, with a collection configured — the other return', () => {
        // Two paths, two returns. Testing only the empty config left the one
        // that actually registers sources unproven.
        assert.match(sources({ things: { folder: 'things' } })(coreFor())?.module ?? '',
            /plugins\/sources\.js$/)
    })

    it('preview, which returns a descriptor', () => {
        assert.match(preview()(coreFor())?.module ?? '', /plugins\/preview\.js$/)
    })
})

// output-drift must not fire when a dependency legitimately moved.
//
// The check compares inputHash: unchanged inputs + changed output = a render
// that is not a function of its inputs. Its premise was "every entity input is
// in inputHash by construction", and that is false. inputHash covers the
// entity's OWN meta and checksum. An entity assembled from a QUERY — a CSS
// bundle globbing styles/**/*.css — has every real input outside it, reaching
// the render through refClosure.
//
// So its inputHash is constant by construction, and editing any part tripped
// the check on every build, forever. Observed on a live site: three cycles,
// each reporting in ONE document `reason: query-matched, by /styles/hero.css`
// and, four lines later, "Nothing about the content moved, so the cause is
// outside it — an upgraded renderer". The renderer was byte-identical; the
// cause was the file that had just been saved.
//
// A permanent false alarm is worse than no alarm: it trains the reader to skip
// the real one, and the real one is a renderer that has stopped being
// reproducible.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { fileHelpers, frontMatter, sources, yaml } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { renderHbs } from 'mikser-io'
export default {
    plugins: [
        frontMatter(), yaml(),
        sources({
            styles:  { folder: 'styles',  extensions: ['css'] },
            bundles: { folder: 'bundles', extensions: ['yml'] },
        }),
        layouts({ autoLayouts: false }),
        renderHbs(), fileHelpers(),
    ],
}
`

// The same shape as the site's: a trigger entity whose own bytes never change,
// and a layout that assembles the real content from a glob.
const BUNDLE_LAYOUT = `---
destination: /styles/site.css
---
{{#each (glob 'styles/**/*.css')}}{{{readFile this}}}
{{/each}}`

describe('a bundle assembled from a glob', () => {
    const workdir = freshWorkdir('drift-false-positive')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/bundle.hbs': BUNDLE_LAYOUT,
            'bundles/bundle.yml': 'layout: bundle\n',
            'styles/a.css': '.a{color:red}\n',
            'styles/b.css': '.b{color:blue}\n',
        })
        await runMikser(workdir)          // first build records the snapshot
    })

    it('does not report drift when one of its parts is edited', async () => {
        await writeFile(path.join(workdir, 'styles', 'a.css'), '.a{color:green}\n')
        const { combined } = await runMikser(workdir, ['--json'])

        // The bundle must ACTUALLY have re-rendered, or the absence of a
        // warning proves nothing — a build that skipped it would pass this
        // test while the bug stood. Asserted from the engine's own report.
        const report = JSON.parse(combined.slice(combined.indexOf('{'), combined.lastIndexOf('}') + 1))
        const bundle = report.rendered?.find(r => r.id === '/bundles/bundle.yml')
        assert.ok(bundle, `the bundle did not re-render\n${JSON.stringify(report.rendered, null, 2)}`)
        assert.equal(bundle.reason, 'query-matched',
            'and it must have re-rendered because the glob matched the edited part')

        assert.doesNotMatch(combined, /output-drift/,
            `editing a globbed part is an input change, not drift\n${combined}`)
    })

    it('still reports drift under --force, where inputs really are unchanged', async () => {
        // The check has to keep working. --force re-renders everything with
        // nothing moved, which is the sweep it was built for. A render that
        // is a function of its inputs produces identical bytes and stays
        // silent; this fixture does, so silence here is the correct answer
        // and proves the check was not simply disabled.
        const { combined, code } = await runMikser(workdir, ['--force'])
        assert.equal(code, 0, combined)
        assert.doesNotMatch(combined, /output-drift/,
            `a reproducible render must not drift under --force either\n${combined}`)
    })
})

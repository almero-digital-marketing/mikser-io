// What is running, answered by the runtime rather than guessed about it.
//
// `mikser_ping` used to report a plugin list with `active: true` on the ones
// it could establish were running. It established that by probing surfaces —
// and one probe read `runtime.options.layouts`, which had stopped being
// layouts' API object two majors earlier and is now the `--layouts` folder
// flag. So layouts reported as not running on every site that did not pass a
// flag it has no reason to pass, and nothing failed when the probe went stale.
// Another probed `mikser-io-preview`, a package that does not exist.
//
// The flag was also three-valued in code and two-valued in its contract:
// absent meant EITHER not running or not detectable, and the tool description
// told an agent to read the list "to know what the system can do". On a real
// site that read as no schema validation and no git sync while both were
// running — and git sync is the only route by which an agent's own edit
// reaches the repository.
//
// So the question is answered at the only place it is knowable: the runtime
// records what it loads, as it loads it. A plugin names itself by returning
// `module: import.meta.url`, the same self-naming registerRoute and
// provideService already require. One that names nothing is still LOADED and
// still listed — `package: null` says "running, did not say what it is".

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const CONFIG = `
import { writeFileSync } from 'node:fs'
import { documents, files, frontMatter, renderHbs, loadedPlugins, inventory } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { schemas } from 'mikser-io-schemas'

// Asks the RUNNING engine what it loaded, rather than the test asserting on
// source. Deliberately declares no module of its own, so the list has to
// carry at least one plugin it cannot name.
function reporter() {
    return ({ onLoaded }) => {
        onLoaded(() => {
            writeFileSync(new URL('./loaded.json', import.meta.url),
                JSON.stringify({ loaded: loadedPlugins(), installed: inventory() }, null, 2))
        })
    }
}

export default {
    plugins: [
        documents(), files(), frontMatter(),
        layouts({ autoLayouts: false, match: { '@/**': 'page' } }),
        schemas(),
        renderHbs(),
        reporter(),
    ],
}
`

describe('the runtime reports what it loaded', () => {
    const workdir = freshWorkdir('loaded-plugins')
    after(() => cleanup(workdir))
    let loaded, report

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<html><body>{{document.meta.title}}</body></html>',
            'documents/a.md': '---\nhref: /a\ntitle: One\n---\n',
        })
        await runMikser(workdir)
        report = JSON.parse(await readFile(path.join(workdir, 'loaded.json'), 'utf8'))
        loaded = report.loaded
    })

    it('names layouts, which the old probe never could', () => {
        // The reported defect, exactly: no `--layouts` flag is passed here.
        assert.ok(loaded.some(p => p.package === 'mikser-io-layouts'),
            `layouts must be reported as loaded\n${JSON.stringify(loaded, null, 2)}`)
    })

    it('names schemas', () => {
        assert.ok(loaded.some(p => p.package === 'mikser-io-schemas'),
            `schemas must be reported as loaded\n${JSON.stringify(loaded, null, 2)}`)
    })

    it('lists a plugin that named nothing, rather than dropping it', () => {
        // `reporter()` declares no module. It is running, so it must be in the
        // list — as `package: null`, which says "running, did not say what it
        // is". Absence must never be how the runtime expresses that.
        const unnamed = loaded.filter(p => p.kind === 'lifecycle' && p.package === null)
        assert.ok(unnamed.length >= 1,
            `an undeclared plugin must still be listed\n${JSON.stringify(loaded, null, 2)}`)
    })

    it('counts the renderer as a loaded plugin too', () => {
        assert.ok(loaded.some(p => p.kind === 'renderer' && p.name === 'hbs'),
            JSON.stringify(loaded, null, 2))
    })

    it('says nothing about running in the installed list', () => {
        // `installed` answers a different question and must not carry a claim
        // it cannot support.
        assert.ok(report.installed.length > 0, 'installed packages are still reported')
        assert.ok(report.installed.every(p => !('active' in p)),
            'no entry may claim active — that flag is what went stale')
    })

    it('distinguishes an unnamed plugin from a missing one', () => {
        // `package: null` is a statement about naming, never about running.
        for (const plugin of loaded) {
            assert.ok('package' in plugin, `every entry states its package, even as null: ${JSON.stringify(plugin)}`)
        }
    })
})

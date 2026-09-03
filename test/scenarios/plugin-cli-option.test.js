// A plugin can add a CLI option, and the option table is complete before
// anything reads it.
//
// It could not before, and the reason was an ordering fact rather than a
// decision: the engine parses argv in onInitialize, and the CONFIG — which is
// where the plugins are named — is not read until onLoad. At the moment of the
// first parse the engine genuinely does not know what options exist, so
// `mikser --anything-a-plugin-defines` was refused before the plugin that
// defines it had been constructed.
//
// The alternatives a downstream project reached for instead — an environment
// variable, a config key meaning "do the expensive thing", a wrapper script —
// are all worse in the same way: invisible to --help, unrefusable when
// misspelled, and nowhere near the checks they belong beside.
//
// So the parse happens in two stages and the second is authoritative. The
// refusal from 9.81.0 is not weakened; it moves to the point where "unknown"
// can actually be decided.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

// A plugin that declares an option and reports what it received.
const PLUGIN = `
import { cliOption } from 'mikser-io'
export function probe() {
    return ({ runtime, onFinalized, useLogger }) => {
        cliOption('--probe-deep [name]', 'a flag a plugin added')
        onFinalized(async () => {
            useLogger().warn({ code: 'probe-cli', value: runtime.options.probeDeep ?? null },
                'probe-deep is %j', runtime.options.probeDeep ?? null)
        })
        return { collection: 'probe', type: 'probe' }
    }
}
`
const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { probe } from './probe.js'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs(), probe()] }
`
const FILES = {
    'mikser.config.js': CONFIG,
    'probe.js': PLUGIN,
    'layouts/page.html.hbs': '<!doctype html><body>x</body>',
    'documents/index.html': '---\nlayout: page\n---\n',
}

describe('an option a plugin declared', () => {
    const workdir = freshWorkdir('plugin-cli')
    after(() => cleanup(workdir))
    before(async () => { await setupFixture(workdir, FILES) })

    it('is accepted, where it used to be refused as unknown', async () => {
        const { code, combined } = await runMikser(workdir, ['--force', '--probe-deep'])
        assert.equal(code, 0, `a plugin's own flag must not be an unknown option\n${combined}`)
        assert.match(combined, /probe-deep is true/, combined)
    })

    it('carries its value', async () => {
        const { combined } = await runMikser(workdir, ['--force', '--probe-deep', 'hera'])
        // Quote-agnostic: pino renders %j with single quotes, and the
        // assertion is about the VALUE arriving, not about its formatting.
        assert.match(combined, /probe-deep is ['"]hera['"]/, combined)
    })

    it('is absent when not passed, rather than defaulting to on', async () => {
        const { combined } = await runMikser(workdir, ['--force'])
        assert.match(combined, /probe-deep is null/, combined)
    })

    it('appears in --help, which is why help waits for the config', async () => {
        // Commander prints help and exits the moment it sees the flag, which
        // in stage one is before any plugin exists — so the help would list
        // core's options and silently omit the project's own. A help text
        // missing the flag you are looking for is worse than a slower one.
        const { code, combined } = await runMikser(workdir, ['--help'])
        assert.equal(code, 0, combined)
        assert.match(combined, /--probe-deep/, `a plugin's option belongs in this project's help\n${combined}`)
        assert.match(combined, /--fingerprint/, 'and core\'s options are still there')
    })

    it('still refuses a flag nothing declared, by name', async () => {
        // The refusal this must not lose. Stage one tolerates an unknown
        // option AND the excess argument it then looks like, so it cannot be
        // the stage that judges argv — left to it, the message was "too many
        // arguments. Expected 0 arguments but got 1", which describes
        // commander's reading rather than the mistake a person made.
        const { code, combined } = await runMikser(workdir, ['--force', '--bogus-flag'])
        assert.equal(code, 1, combined)
        assert.match(combined, /unknown option '--bogus-flag'/, combined)
    })

    it('refuses one that is close to a plugin option, not silently ignores it', async () => {
        const { code, combined } = await runMikser(workdir, ['--force', '--probe-dep'])
        assert.equal(code, 1, combined)
        assert.match(combined, /unknown option/, combined)
    })
})

describe('a project with no plugin options', () => {
    const workdir = freshWorkdir('plugin-cli-none')
    after(() => cleanup(workdir))

    it('still refuses an unknown flag by name', async () => {
        // Stage two runs even when nothing was declared, or most builds would
        // be left with stage one's much worse message.
        await setupFixture(workdir, {
            'mikser.config.js': `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`,
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
            'documents/index.html': '---\nlayout: page\n---\n',
        })
        const { code, combined } = await runMikser(workdir, ['--bogus-flag'])
        assert.equal(code, 1, combined)
        assert.match(combined, /unknown option '--bogus-flag'/, combined)
    })
})

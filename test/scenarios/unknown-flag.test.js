// An unknown flag has to be rejected whether or not something is listening.
//
// app.js pre-parses argv for the few options it needs and forwards the rest,
// so commander never runs on a forwarded invocation. `mikser --bogus` against
// a running watcher therefore built normally and exited 0, while the same
// command with nothing listening was rejected outright — the same words, two
// answers, and the quiet one is the one that looks like it worked.
//
// The client cannot judge this: the option table lives in the engine, and
// plugins add to it. So the argv travels with the request and the INSTANCE
// decides, using commander's parseOptions, which reports unknowns without
// applying anything.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import {
    setupFixture, runMikser, cleanup,
    freshWorkdir,
} from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`

describe('an unknown flag, with nothing listening', () => {
    const workdir = freshWorkdir('unknown-flag')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
            'documents/index.html': '---\nlayout: page\n---\n',
        })
    })

    it('is rejected by commander', async () => {
        const { code, combined } = await runMikser(workdir, ['--bogus-flag'])
        assert.equal(code, 1, `an unknown option must not be ignored\n${combined}`)
        assert.match(combined, /unknown option/)
    })

    it('and a known one still builds', async () => {
        const { code, combined } = await runMikser(workdir, ['--force'])
        assert.equal(code, 0, combined)
        assert.match(combined, /Mikser completed/)
    })
})

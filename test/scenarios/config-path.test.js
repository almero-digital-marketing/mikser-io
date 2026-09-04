// A --config that is not there stops the build.
//
// Two absences look identical to the loader and mean opposite things. A
// project without a mikser.config.js is a project that wants defaults, and
// running is correct. A --config the caller NAMED and that is not on disk is
// a wrong path, and running is the worst available answer: the build prints
// the path it did not find, reports "No plugins loaded", writes nothing and
// exits 0. Green build, empty output folder, and the one line that could have
// said so said the opposite.
//
// The wrong path is easy to produce because a relative --config resolves
// against the WORKING FOLDER, not the folder the command was run in. That is
// deliberate — it is what makes the default './mikser.config.js' follow
// --working-folder, and what makes `-c prod.js` read as "the prod config of
// the site I am pointing at" — but it means repeating the working folder in
// the path silently doubles it. So the error says which folder the path was
// resolved against, because that is the sentence that ends the confusion.
//
// The resolution itself is NOT changed here: instance-forwarding.test.js
// passes `-c mikser.config.prod.js` and means the file in the working folder.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, stripAnsi } from './_harness.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [documents(), frontMatter(), layouts({ autoLayouts: true }), renderHbs()],
}
`

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs': '<!doctype html><title>{{document.meta.title}}</title>',
    'documents/one.md': '---\ntitle: One\nlayout: page\n---\nbody\n',
}

describe('a --config path that is not there', () => {
    const workdir = freshWorkdir('config-path')
    after(() => cleanup(workdir))

    it('builds normally with the default config', async () => {
        await setupFixture(workdir, FIXTURE)
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), /Rendered:\s*1/)
    })

    it('accepts a relative --config, resolved against the working folder', async () => {
        // The shape instance-forwarding relies on: a bare filename means the
        // file in the working folder, not in the caller's shell.
        const { code, combined } = await runMikser(workdir, ['--config', 'mikser.config.js'])
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), new RegExp(`Config: ${path.join(workdir, 'mikser.config.js')}`))
    })

    it('fails instead of building on defaults when the named config is missing', async () => {
        const { code, combined } = await runMikser(workdir, ['--config', 'nope.config.js'])
        assert.equal(code, 1, `a named config that is absent must not build\n${combined}`)
        assert.match(stripAnsi(combined), /No config file at/)
        assert.doesNotMatch(stripAnsi(combined), /No plugins loaded/,
            'and must not get far enough to report an empty plugin list')
    })

    it('names the folder the path was resolved against', async () => {
        // The whole point. Repeating the working folder in the path is the
        // easy mistake, and "resolved against <workdir>" is what makes the
        // doubled path in the line above make sense.
        const doubled = path.join(path.basename(workdir), 'mikser.config.js')
        const { code, combined } = await runMikser(workdir, ['--config', doubled])
        assert.equal(code, 1, combined)
        assert.match(stripAnsi(combined), /resolves against the working folder/)
        assert.match(stripAnsi(combined), new RegExp(workdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })

    it('still runs on defaults when a project simply has no config', async () => {
        // The case that must NOT become an error: absence by default is a
        // project that wants defaults.
        const bare = freshWorkdir('config-path-bare')
        try {
            await setupFixture(bare, { 'documents/.keep': '' })
            const { code, combined } = await runMikser(bare)
            assert.equal(code, 0, combined)
            assert.match(stripAnsi(combined), /No plugins loaded/)
        } finally {
            await cleanup(bare)
        }
    })
})

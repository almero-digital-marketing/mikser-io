// A tool a plugin registers is reachable from the CLI, wherever the plugin
// sits in the array.
//
// Two separate faults made that false, and each hid the other.
//
// The first was coupling: a plugin registered its tools by reaching into
// runtime.options.mcp, so the mcp plugin had to be constructed first. Nothing
// enforced it and nothing reported it — move mcp down the array and the tools
// were simply gone from a build that stayed green.
//
// The second was ordering inside the engine. --tools and --tool are dispatched
// at `import` precisely because the registry is not complete until every
// plugin's onLoaded has run, and that dispatch was documented as load-bearing.
// But the engine's own onLoaded called runReportOnly() unconditionally, reached
// the same branch first and exited — so the import dispatch never ran, and the
// CLI listed only the tools core registers for itself. A short list, no error.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

// Registers in onLoaded, which is where a plugin's tools realistically land.
const PROBE = `
import { registerTool } from 'mikser-io'
export function probe(name) {
    return ({ onLoaded }) => {
        onLoaded(() => {
            registerTool(name, { description: 'registered by a plugin' },
                async ({ echo }) => ({ echoed: echo ?? null }))
        })
        return { collection: name, type: name }
    }
}
`
const files = (order) => ({
    'mikser.config.js': `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { probe } from './probe.js'
export default { plugins: [${order}] }
`,
    'probe.js': PROBE,
    'layouts/page.html.hbs': '<!doctype html><body>x</body>',
    'documents/index.html': '---\nlayout: page\n---\n',
})

const LATE  = "documents(), frontMatter(), layouts(), renderHbs(), probe('probe_late')"
const EARLY = "probe('probe_early'), documents(), frontMatter(), layouts(), renderHbs()"

describe('a tool registered by a plugin', () => {
    const workdir = freshWorkdir('plugintools')
    after(() => cleanup(workdir))
    before(async () => { await setupFixture(workdir, files(LATE)) })

    it('is listed by --tools', async () => {
        const { combined } = await runMikser(workdir, ['--tools'])
        assert.match(combined, /probe_late/,
            `the CLI listed only what core registers for itself\n${combined}`)
    })

    it('is invokable by --tool, and answers', async () => {
        const { code, combined } = await runMikser(workdir,
            ['--tool', 'probe_late', '--tool-args', '{"echo":"hello"}'])
        assert.equal(code, 0, combined)
        assert.match(combined, /hello/, `the tool did not run\n${combined}`)
    })
})

describe('the same tool with the plugin listed first', () => {
    const workdir = freshWorkdir('plugintools-early')
    after(() => cleanup(workdir))
    before(async () => { await setupFixture(workdir, files(EARLY)) })

    it('is reachable there too, so position carries no meaning', async () => {
        const { combined } = await runMikser(workdir, ['--tools'])
        assert.match(combined, /probe_early/, combined)
    })
})

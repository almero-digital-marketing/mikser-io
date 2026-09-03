// A finding a plugin raises has to reach the report, not only the console.
//
// `emitReport()` used to run from the engine's own onFinalized — registered
// when the engine module is imported, so it fired FIRST among finalized hooks
// and every plugin's findings landed after the document was already written. A
// plugin could print a warning to the console and have it absent from --json,
// with nothing anywhere to suggest the two disagreed.
//
// That is not one plugin's bug. It is an ordering bug every plugin inherits,
// which is why the fix is here and not in each of them: the report is a VIEW
// of the logger.warn stream, and a view has to be taken after the writing
// stops. It reached lint and schemas alike, and would have reached the next
// plugin to raise anything in finalize.
//
// The rule it settles, which was worth stating: a plugin reports a finding
// through logger.warn with a code, exactly as core does, and gets the console
// line and the report entry from that one call. There is no second channel.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'
import { socketPath } from '../../src/instance.js'

// A plugin that raises a coded warning in onFinalized, which is where a
// finding about the finished build belongs and where both real ones live.
const PLUGIN = `
export function probe() {
    return ({ onFinalized, useLogger }) => {
        onFinalized(async () => {
            useLogger().warn({ code: 'probe-finding', detail: 'x' },
                'a finding raised by a plugin after the build')
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

async function startInstance(workdir) {
    const child = spawn(process.execPath, [
        path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir, '--watch',
    ], { cwd: MIKSER_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
         env: { ...process.env, NO_COLOR: '1', NODE_PATH: path.dirname(MIKSER_ROOT) } })
    const endpoint = socketPath(workdir)
    for (let i = 0; i < 200; i++) {
        if (existsSync(endpoint)) return child
        await new Promise(r => setTimeout(r, 100))
    }
    child.kill()
    throw new Error('instance never opened its socket')
}

describe("a plugin's finding, raised in finalize", () => {
    const workdir = freshWorkdir('plugin-findings')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, FILES)
    })

    it('reaches the console', async () => {
        const { combined } = await runMikser(workdir, ['--force'])
        assert.match(combined, /\[probe-finding\]/, combined)
    })

    it('reaches the report, which is the half that was missing', async () => {
        const { stdout } = await runMikser(workdir, ['--force', '--json'])
        const report = JSON.parse(stdout)
        const codes = (report.warnings ?? []).map(w => w.code)
        assert.ok(codes.includes('probe-finding'),
            `the console said it and the document did not\n${codes.join(', ')}`)
    })

    it('carries the fields it was raised with, not just the sentence', async () => {
        const { stdout } = await runMikser(workdir, ['--force', '--json'])
        const finding = JSON.parse(stdout).warnings.find(w => w.code === 'probe-finding')
        assert.equal(finding.detail, 'x',
            'a script matching on a code needs the fields beside it')
    })

    it('does not displace the engine\'s own findings', async () => {
        // The engine's finalized hook still runs first; moving the emit must
        // not drop what it raised.
        const { stdout } = await runMikser(workdir, ['--force', '--json'])
        const report = JSON.parse(stdout)
        assert.equal(typeof report.summary, 'object')
        assert.ok(Array.isArray(report.warnings))
        assert.equal(report.summary.warnings, report.warnings.length,
            'the summary counts what the array holds')
    })
})

describe("a plugin's finding, through a forwarding client", () => {
    const workdir = freshWorkdir('plugin-findings-fwd')
    let instance
    after(async () => { instance?.kill(); await cleanup(workdir) })

    before(async () => {
        await setupFixture(workdir, FILES)
        await runMikser(workdir)
        instance = await startInstance(workdir)
    })

    it('reaches the caller, not only the instance', async () => {
        const { combined } = await runMikser(workdir, ['--force'])
        assert.match(combined, /\[probe-finding\]/,
            `a build that prints nothing is indistinguishable from a clean one\n${combined}`)
    })

    it('reaches the forwarded document too', async () => {
        const { stdout } = await runMikser(workdir, ['--force', '--json'])
        const codes = (JSON.parse(stdout).warnings ?? []).map(w => w.code)
        assert.ok(codes.includes('probe-finding'), codes.join(', '))
    })
})

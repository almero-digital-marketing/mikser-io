// What the build COST, not only what it did.
//
// The preset fan-out shipped scanning the whole catalog every cycle and ran
// for four releases before anyone happened to time a rebuild by hand. Output
// was byte-identical, --audit-output passed, the drift sweep passed, and the
// build was twice as slow. An upgrade check could prove no bytes moved and
// could not prove the speed had not halved, because the report says what was
// done and never what it took.
//
// The console's progress lines are not this. They are per-collection, rounded
// to whole seconds — a phase that doubled from 400ms to 800ms prints "0s" both
// times — and they are suppressed off a TTY, which is every CI run and every
// --json invocation. So the numbers did not exist where a script could read
// them.
//
// `finishedAt - startedAt` is not this either: it spans the processing cycle
// only. Measured on a small site it covered 12ms of a 443ms run, leaving boot,
// the config graph, the plugin load and the import scan — most of where a
// regression lands — with no number anywhere.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'
import { socketPath } from '../../src/instance.js'

async function startInstance(workdir) {
    const child = spawn(process.execPath, [
        path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir, '--watch',
    ], {
        cwd: MIKSER_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', NODE_PATH: path.dirname(MIKSER_ROOT) },
    })
    const endpoint = socketPath(workdir)
    for (let i = 0; i < 200; i++) {
        if (existsSync(endpoint)) return child
        await new Promise(r => setTimeout(r, 100))
    }
    child.kill()
    throw new Error('instance never opened its socket')
}

// A plugin that costs a known amount of time in a known phase. The point is
// attribution: not that the build took time, but that the report says WHERE.
const SLOW_PLUGIN = `
export function slow(ms) {
    return ({ onImport }) => {
        onImport(async () => { await new Promise(r => setTimeout(r, ms)) })
        return { collection: 'slow', type: 'slow' }
    }
}
`

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { slow } from './slow.js'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs(), slow(300)] }
`

describe('what each phase cost', () => {
    const workdir = freshWorkdir('phase-timings')
    after(() => cleanup(workdir))
    let timings

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'slow.js': SLOW_PLUGIN,
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
        })
        const { code, stdout } = await runMikser(workdir, ['--json'])
        assert.equal(code, 0)
        timings = JSON.parse(stdout).timings
    })

    it('reports timings at all, in --json, where a script can read them', () => {
        assert.ok(timings, 'the whole point is that this is machine-readable')
        assert.equal(typeof timings.total, 'number')
        assert.ok(Array.isArray(timings.phases))
    })

    it('attributes the cost to the phase that spent it', () => {
        const imp = timings.phases.find(p => p.phase === 'import')
        assert.ok(imp, `expected an import phase\n${JSON.stringify(timings.phases, null, 2)}`)
        assert.ok(imp.ms >= 250,
            `the 300ms this plugin spends in onImport has to land on 'import', got ${imp.ms}ms`)
    })

    it('resolves finer than a second, or a doubled phase reads as 0s twice', () => {
        // The console rounds to whole seconds. Every phase here is under one,
        // and they must still be distinguishable from each other and from zero.
        const fast = timings.phases.filter(p => p.ms > 0 && p.ms < 1000)
        assert.ok(fast.length >= 2,
            `sub-second phases must carry real numbers\n${JSON.stringify(timings.phases, null, 2)}`)
    })

    it('orders slowest first, so a diff leads with what moved', () => {
        const ms = timings.phases.map(p => p.ms)
        assert.deepEqual(ms, [...ms].sort((a, b) => b - a))
    })

    it('separates the process clock from the phases, and says which is which', () => {
        // The phases are not the whole run: module loading and engine
        // construction happen before any hook, and on a small site that is
        // most of the elapsed time. For a ONE-SHOT the difference is exactly
        // that, which is why the two numbers are reported separately rather
        // than as one "elapsed".
        assert.ok(timings.processUptime > timings.total,
            'the process outlives its phases; startup is real time')
        assert.ok(timings.processUptime >= 300,
            `${timings.processUptime}ms should cover the slow plugin`)
    })

    it('attributes a phase to the plugin that spent it', () => {
        // `finalized` alone is where the reference check, schemas, lint and an
        // audit all live, so one number for the phase says nothing about which
        // of them cost it — attributing a 465ms lint pass took three separate
        // measurements downstream.
        //
        // A plugin's identity is not knowable until its factory RETURNS: the
        // entry in the plugins array is already the factory's result. So hooks
        // are diffed across the call and tagged with what the call produced.
        assert.ok(Array.isArray(timings.plugins), JSON.stringify(timings))
        const slow = timings.plugins.find(p => p.plugin === 'slow')
        assert.ok(slow, `the slow plugin should be named\n${JSON.stringify(timings.plugins, null, 2)}`)
        assert.equal(slow.phase, 'import', JSON.stringify(slow))
        assert.ok(slow.ms >= 250, `its 300ms must land on it, got ${slow.ms}ms`)
    })

    it('keeps a plugin\'s time INSIDE its phase, not beside it', () => {
        // Otherwise the phase totals stop adding up to `total` and every
        // comparison between two releases double-counts.
        const imp = timings.phases.find(p => p.phase === 'import')
        const slow = timings.plugins.find(p => p.plugin === 'slow')
        assert.ok(slow.ms <= imp.ms + 1, `${slow.ms} must be within ${imp.ms}`)
        const summed = timings.phases.reduce((a, p) => a + p.ms, 0)
        assert.ok(Math.abs(summed - timings.total) < 1, `${summed} vs ${timings.total}`)
    })

    it('covers the boot phases on the build that actually paid for them', () => {
        // A one-shot pays for initialize/load/import, so they belong in its
        // report. A later cycle in a watch process does not, and must not
        // inherit them — see the forwarded case below.
        const names = timings.phases.map(p => p.phase)
        assert.ok(names.includes('import'), names.join(', '))
        assert.ok(names.includes('load'), names.join(', '))
    })
})

describe('what a single cycle cost, inside a long-lived process', () => {
    const workdir = freshWorkdir('phase-timings-cycle')
    let instance
    after(async () => { instance?.kill(); await cleanup(workdir) })

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'slow.js': SLOW_PLUGIN,
            'documents/index.html': '---\nlayout: page\n---\n',
            'layouts/page.html.hbs': '<!doctype html><body>x</body>',
        })
        await runMikser(workdir)
        instance = await startInstance(workdir)
    })

    it('reports the cycle, not everything the instance has spent since boot', async () => {
        // Accumulating for the life of the process gives a number that only
        // grows and never answers "what did this build cost" — the question
        // someone comparing two runs is asking. Two forwarded builds in a row
        // must therefore be comparable to each other, not to a running total.
        const first = JSON.parse((await runMikser(workdir, ['--json'])).stdout).timings
        const second = JSON.parse((await runMikser(workdir, ['--json'])).stdout).timings

        assert.ok(first && second, 'both forwarded builds report timings')
        assert.ok(second.phases.map(p => p.phase).includes('process'))

        // The second is not the first plus the first. This is the whole
        // property: two builds of the same tree are comparable to each other,
        // rather than each being a running total that only grows.
        assert.ok(second.total < first.total * 1.9,
            `totals must be per cycle, not cumulative: ${first.total} then ${second.total}`)

        // processUptime is the INSTANCE's age here, not this build's, and it
        // does grow — which is why it is named for what it measures. A caller
        // must not read it as the cost of the build.
        assert.ok(second.processUptime > second.total,
            `${second.processUptime} vs ${second.total}`)
    })
})

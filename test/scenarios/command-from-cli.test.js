// A one-off side effect without editing the config.
//
// Trying a build-time side effect meant adding it to the config, and a config
// edit wipes the cache — so evaluating one idea cost four full rebuilds
// (add it, build, revert it, build) at ~18s each against ~900ms for a no-op.
// The tax fell hardest on the cheapest experiments, which is why they stopped
// happening inside the build and started happening by hand outside it.
//
// Three properties, and the last two matter more than the feature:
//
//   1. it runs, from argv, at the named hook
//   2. it is REPORTED under `command-from-cli` with the command string,
//      because a build is otherwise a function of the repository alone and
//      this makes it a function of how it was invoked as well
//   3. forwarded to a running instance it REPLACES the previous request's
//      command rather than accumulating, and the instance's own rebuilds run
//      neither
//
// (3) is a property of where the value is read, not of extra bookkeeping: one
// hook is registered at load and reads runtime.options at hook time, which the
// instance swaps per request and restores after. Registering a hook per
// request would make two clients' commands add up — that is the failure this
// pins.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT, stripAnsi,
} from './_harness.js'
import { socketPath } from '../../src/instance.js'

const CONFIG = `
import { documents, frontMatter, renderHbs, commands } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
    plugins: [
        documents(), frontMatter(), layouts({ autoLayouts: true }), renderHbs(),
        commands(),
    ],
}
`

// Appends its argument, so accumulation is visible rather than inferred.
const MARK = [
    "import { appendFileSync } from 'node:fs'",
    "import path from 'node:path'",
    "appendFileSync(path.join(process.cwd(), 'marks.txt'), process.argv[2] + '\\n')",
].join('\n')

const FIXTURE = {
    'mikser.config.js': CONFIG,
    'layouts/page.hbs': '<!doctype html><title>{{document.meta.title}}</title>',
    'documents/index.md': '---\ntitle: One\nlayout: page\n---\n',
    'mark.mjs': MARK,
}

const marks = async (workdir) => {
    const file = path.join(workdir, 'marks.txt')
    if (!existsSync(file)) return []
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean)
}

describe('a command from the command line', () => {
    const workdir = freshWorkdir('command-from-cli')
    before(() => setupFixture(workdir, FIXTURE))
    after(() => cleanup(workdir))

    it('runs at the named hook, with no config edit', async () => {
        const { code, combined } = await runMikser(workdir, ['--finalized', 'node mark.mjs once'])
        assert.equal(code, 0, combined)
        assert.deepEqual(await marks(workdir), ['once'])
        await rm(path.join(workdir, 'marks.txt'))
    })

    it('is reported under command-from-cli, with the command', async () => {
        // The condition that makes the feature honest: a fingerprint taken
        // from this build has to stay interpretable.
        const { stdout } = await runMikser(workdir, ['--json', '--finalized', 'node mark.mjs reported'])
        const report = JSON.parse(stdout)
        const entry = report.warnings?.find(w => w.code === 'command-from-cli')
        assert.ok(entry, `expected a command-from-cli warning in:\n${JSON.stringify(report.warnings)}`)
        assert.equal(entry.hook, 'finalized')
        assert.equal(entry.command, 'node mark.mjs reported')
        await rm(path.join(workdir, 'marks.txt'))
    })

    it('says nothing when no command was given', async () => {
        const { stdout } = await runMikser(workdir, ['--json'])
        const report = JSON.parse(stdout)
        assert.equal(report.warnings?.some(w => w.code === 'command-from-cli'), false)
        assert.deepEqual(await marks(workdir), [], 'and runs nothing')
    })

    it('leaves the output folder verifiable', async () => {
        // A command that does NOT touch out/ must keep the audit clean — the
        // counterpart to the documented failure when one does.
        await runMikser(workdir, ['--finalized', 'node mark.mjs audit'])
        const { code, combined } = await runMikser(workdir, ['--audit-output'])
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), /Audit OK/)
        await rm(path.join(workdir, 'marks.txt'))
    })
})

describe('a forwarded command replaces rather than accumulates', () => {
    const workdir = freshWorkdir('command-from-cli-forwarded')
    let instance

    before(async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir)
        instance = spawn(process.execPath, [
            path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir,
            '--watch', '--server', '3773',
        ], { stdio: ['ignore', 'pipe', 'pipe'] })
        const endpoint = socketPath(workdir)
        let listening = false
        for (let i = 0; i < 200; i++) {
            if (existsSync(endpoint)) { listening = true; break }
            await new Promise(r => setTimeout(r, 100))
        }
        if (!listening) { instance.kill(); throw new Error('instance never opened its socket') }
        // Settle the instance's own startup build before measuring, so its
        // cycle cannot be mistaken for a forwarded one.
        await runMikser(workdir)
        await writeFile(path.join(workdir, 'marks.txt'), '')
    })
    after(async () => { instance?.kill(); await cleanup(workdir) })

    it('runs only the command the current request asked for', async () => {
        await runMikser(workdir, ['--finalized', 'node mark.mjs A'])
        assert.deepEqual(await marks(workdir), ['A'])

        await runMikser(workdir, ['--finalized', 'node mark.mjs B'])
        assert.deepEqual(await marks(workdir), ['A', 'B'],
            'B only — an accumulating instance would have run A again and given A,B,A')

        await runMikser(workdir, ['--finalized', 'node mark.mjs C'])
        assert.deepEqual(await marks(workdir), ['A', 'B', 'C'])
    })

    it('runs nothing for a request that asked for nothing', async () => {
        const before = await marks(workdir)
        await runMikser(workdir)
        assert.deepEqual(await marks(workdir), before,
            'the previous request must not leak into this one')
    })
})

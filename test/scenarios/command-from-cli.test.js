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
        const { code, combined } = await runMikser(workdir, ['--command', 'finalized=node mark.mjs once'])
        assert.equal(code, 0, combined)
        assert.deepEqual(await marks(workdir), ['once'])
        await rm(path.join(workdir, 'marks.txt'))
    })

    it('is reported under command-from-cli, with the command', async () => {
        // The condition that makes the feature honest: a fingerprint taken
        // from this build has to stay interpretable.
        const { stdout } = await runMikser(workdir, ['--json', '--command', 'finalized=node mark.mjs reported'])
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

    it('is repeatable, driving several hooks in one invocation', async () => {
        // The reason it is one flag naming a hook rather than a flag per
        // hook: the set stays open, and several can be given at once.
        const { code, combined } = await runMikser(workdir, [
            '--command', 'loaded=node mark.mjs early',
            '--command', 'finalized=node mark.mjs late',
        ])
        assert.equal(code, 0, combined)
        assert.deepEqual(await marks(workdir), ['early', 'late'],
            'both hooks ran, in lifecycle order')
        await rm(path.join(workdir, 'marks.txt'))
    })

    it('refuses an unknown hook before building anything', async () => {
        const { code, combined } = await runMikser(workdir, ['--command', 'nope=node mark.mjs x'])
        assert.notEqual(code, 0, combined)
        assert.match(stripAnsi(combined), /no hook named/)
        assert.deepEqual(await marks(workdir), [], 'and ran nothing')
    })

    it('splits on the first = so a command may contain its own', async () => {
        const { code } = await runMikser(workdir, ['--command', 'finalized=node mark.mjs a=b'])
        assert.equal(code, 0)
        assert.deepEqual(await marks(workdir), ['a=b'])
        await rm(path.join(workdir, 'marks.txt'))
    })

    it('refuses a hook the CLI structurally cannot reach', async () => {
        // Options are declared DURING the load phase and the table is parsed
        // after it, so runtime.options is empty when onLoad fires. Accepting
        // `load` would mean accepting a flag that silently does nothing.
        const { code, combined } = await runMikser(workdir, ['--command', 'load=node mark.mjs x'])
        assert.notEqual(code, 0, combined)
        assert.match(stripAnsi(combined), /could never fire/)
        assert.deepEqual(await marks(workdir), [])
    })

    it('leaves the output folder verifiable', async () => {
        // A command that does NOT touch out/ must keep the audit clean — the
        // counterpart to the documented failure when one does.
        await runMikser(workdir, ['--command', 'finalized=node mark.mjs audit'])
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
        await runMikser(workdir, ['--command', 'finalized=node mark.mjs A'])
        assert.deepEqual(await marks(workdir), ['A'])

        await runMikser(workdir, ['--command', 'finalized=node mark.mjs B'])
        assert.deepEqual(await marks(workdir), ['A', 'B'],
            'B only — an accumulating instance would have run A again and given A,B,A')

        await runMikser(workdir, ['--command', 'finalized=node mark.mjs C'])
        assert.deepEqual(await marks(workdir), ['A', 'B', 'C'])
    })

    it('carries a repeated flag across the wire as a set, not a last-one-wins string', async () => {
        // The instance re-parses a client's argv with a throwaway parser, and
        // a collector left out of that rebuild would hand back one value where
        // the local run got an array — the forwarded path quietly behaving
        // differently from the local one.
        const before = await marks(workdir)
        // Both per-CYCLE hooks. A forwarded build reuses an instance that
        // loaded long ago, so a startup-phase hook like `loaded` cannot fire
        // for it — see the test below.
        await runMikser(workdir, [
            '--command', 'processed=node mark.mjs fwd-early',
            '--command', 'finalized=node mark.mjs fwd-late',
        ])
        assert.deepEqual(await marks(workdir), [...before, 'fwd-early', 'fwd-late'])
    })

    it('says so when a requested hook cannot fire for a forwarded build', async () => {
        // `loaded` fires for a LOCAL build and not for a forwarded one: the
        // instance loaded at startup and a rebuild does not repeat the load
        // phase. Same flag, different behaviour depending on whether a watcher
        // happens to be up — which was silent until it was not.
        const before = await marks(workdir)
        const { code, combined } = await runMikser(workdir, [
            '--command', 'loaded=node mark.mjs never',
            '--command', 'finalized=node mark.mjs ran',
        ])
        assert.equal(code, 0, combined)
        assert.match(stripAnsi(combined), /command-hook-not-reached/)
        assert.match(stripAnsi(combined), /did not fire this cycle/)
        assert.deepEqual(await marks(workdir), [...before, 'ran'],
            'the reachable hook still ran; the unreachable one did not pretend to')
    })

    it('runs nothing for a request that asked for nothing', async () => {
        const before = await marks(workdir)
        await runMikser(workdir)
        assert.deepEqual(await marks(workdir), before,
            'the previous request must not leak into this one')
    })
})

// --command spends itself on one request. --command-install puts it ON the
// instance, so the watcher's OWN rebuilds run it too — the case --command
// cannot serve, because a file save triggers a cycle nobody forwarded.
describe('a command installed on the instance', () => {
    const workdir = freshWorkdir('command-install')
    let instance

    before(async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir)
        instance = spawn(process.execPath, [
            path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir,
            '--watch', '--server', '3774',
        ], { stdio: ['ignore', 'pipe', 'pipe'] })
        const endpoint = socketPath(workdir)
        let listening = false
        for (let i = 0; i < 200; i++) {
            if (existsSync(endpoint)) { listening = true; break }
            await new Promise(r => setTimeout(r, 100))
        }
        if (!listening) { instance.kill(); throw new Error('instance never opened its socket') }
        await runMikser(workdir)
        await writeFile(path.join(workdir, 'marks.txt'), '')
    })
    after(async () => { instance?.kill(); await cleanup(workdir) })

    // A file save, and time for the watcher to see it and finish a cycle.
    const edit = async (title) => {
        await writeFile(path.join(workdir, 'documents/index.md'),
            `---\ntitle: ${title}\nlayout: page\n---\n`)
        await new Promise(r => setTimeout(r, 4000))
    }

    it('runs on the instance own rebuilds, not just forwarded ones', async () => {
        await runMikser(workdir, ['--command-install', 'finalized=node mark.mjs P'])
        assert.deepEqual(await marks(workdir), ['P'], 'the installing request runs it too')

        await edit('One')
        assert.deepEqual(await marks(workdir), ['P', 'P'],
            'a file save the watcher picked up must run it — the whole point')

        await edit('Two')
        assert.deepEqual(await marks(workdir), ['P', 'P', 'P'], 'and it stays installed')
    })

    it('is cleared by --command-reset', async () => {
        await runMikser(workdir, ['--command-reset'])
        const before = await marks(workdir)
        await edit('Three')
        assert.deepEqual(await marks(workdir), before, 'nothing runs after a reset')
    })

    it('clears one hook when named, leaving the others', async () => {
        await runMikser(workdir, [
            '--command-install', 'processed=node mark.mjs EARLY',
            '--command-install', 'finalized=node mark.mjs LATE',
        ])
        await writeFile(path.join(workdir, 'marks.txt'), '')

        await runMikser(workdir, ['--command-reset', 'processed'])
        await writeFile(path.join(workdir, 'marks.txt'), '')
        await edit('Four')
        assert.deepEqual(await marks(workdir), ['LATE'],
            'only the named hook was cleared')

        await runMikser(workdir, ['--command-reset'])
    })

    it('says so when there is no instance to install on', async () => {
        // A one-shot exits with the process, so installing is the same as
        // --command. Saying nothing would let someone believe it persisted.
        const solo = freshWorkdir('command-install-solo')
        try {
            await setupFixture(solo, FIXTURE)
            const { code, combined } = await runMikser(solo, ['--command-install', 'finalized=node mark.mjs S'])
            assert.equal(code, 0, combined)
            assert.match(stripAnsi(combined), /command-install-without-instance/)
            assert.deepEqual(await marks(solo), ['S'], 'and it still ran, once')
        } finally {
            await cleanup(solo)
        }
    })
})

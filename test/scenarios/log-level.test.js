// --log <level>, and setting it on a running instance.
//
// `--debug` did nothing. It set runtime.engine.logger.level and stopped there,
// while the terminal stream kept the level it was CONSTRUCTED with, so debug
// records were accepted by the logger and discarded by the stream. Measured on
// 10.4.0: identical output with and without the flag, down to the line count.
// It only ever worked when a logging transport happened to be configured,
// because that is the one path that rebuilt the logger — which is why it could
// look wired from the inside and be inert from the outside.
//
// A boolean also could not say "warnings only on this build" or "trace this
// one thing", so the flag is a level now and both booleans are gone rather
// than aliased: a flag that lies is worse than a flag that is missing.
//
// The installed half is the point. Restarting is the expensive operation on a
// deployment — it drops every connected MCP and drive session, and it is the
// incident path — so raising the level on a misbehaving instance must not
// require performing the risky act you are trying to diagnose.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
    setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT, stripAnsi,
} from './_harness.js'
import { socketPath } from '../../src/instance.js'

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
    'documents/index.md': '---\ntitle: One\nlayout: page\n---\n',
}

const lines = (text) => stripAnsi(text).split('\n').filter(l => l.trim()).length

describe('--log sets a level that is actually in force', () => {
    const workdir = freshWorkdir('log-level')
    before(async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir)
    })
    after(() => cleanup(workdir))

    it('shows more at debug than at the default', async () => {
        const plain = await runMikser(workdir, ['--force'])
        const debug = await runMikser(workdir, ['--force', '--log', 'debug'])
        assert.equal(plain.code, 0, plain.combined)
        assert.equal(debug.code, 0, debug.combined)
        assert.ok(lines(debug.combined) > lines(plain.combined),
            `debug must show more than default — got ${lines(debug.combined)} vs ${lines(plain.combined)}`)
    })

    it('shows less at warn, which a boolean could never express', async () => {
        const plain = await runMikser(workdir, ['--force'])
        const warn = await runMikser(workdir, ['--force', '--log', 'warn'])
        assert.ok(lines(warn.combined) < lines(plain.combined),
            `warn must show less than default — got ${lines(warn.combined)} vs ${lines(plain.combined)}`)
    })

    it('refuses a level that does not exist, rather than ignoring it', async () => {
        const { code, combined } = await runMikser(workdir, ['--log', 'chatty'])
        assert.notEqual(code, 0, combined)
        assert.match(stripAnsi(combined), /no such level/)
    })

    it('has no --debug or --trace left to mislead anyone', async () => {
        for (const flag of ['--debug', '--trace']) {
            const { code, combined } = await runMikser(workdir, [flag])
            assert.notEqual(code, 0, `${flag} should be gone: ${combined}`)
            assert.match(stripAnsi(combined), /unknown option/)
        }
    })
})

describe('a log level installed on a running instance', () => {
    const workdir = freshWorkdir('log-level-install')
    let instance

    const logFile = () => path.join(workdir, 'instance.log')
    const logLines = async () => existsSync(logFile())
        ? (await readFile(logFile(), 'utf8')).split('\n').length
        : 0

    // A file save, and time for the watcher to finish a cycle.
    const edit = async (title) => {
        const before = await logLines()
        await writeFile(path.join(workdir, 'documents/index.md'),
            `---\ntitle: ${title}\nlayout: page\n---\n`)
        await new Promise(r => setTimeout(r, 3500))
        return (await logLines()) - before
    }

    const report = async () => JSON.parse((await runMikser(workdir, ['--json'])).stdout)

    before(async () => {
        await setupFixture(workdir, FIXTURE)
        await runMikser(workdir)
        const out = (await import('node:fs')).createWriteStream(logFile())
        await new Promise(r => out.on('open', r))
        instance = spawn(process.execPath, [
            path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir,
            '--watch', '--server', '3775',
        ], { stdio: ['ignore', out, out] })
        const endpoint = socketPath(workdir)
        let listening = false
        for (let i = 0; i < 200; i++) {
            if (existsSync(endpoint)) { listening = true; break }
            await new Promise(r => setTimeout(r, 100))
        }
        if (!listening) { instance.kill(); throw new Error('instance never opened its socket') }
        await runMikser(workdir)
    })
    after(async () => { instance?.kill(); await cleanup(workdir) })

    it('makes the instance own rebuilds verbose, without restarting it', async () => {
        // The case a per-request flag structurally cannot serve: nobody
        // forwards the cycle a file save triggers.
        const quiet = await edit('A')
        await runMikser(workdir, ['--log-install', 'debug'])
        const loud = await edit('B')
        assert.ok(loud > quiet,
            `installed debug must make the watcher's own rebuild verbose — ${loud} vs ${quiet} lines`)
    })

    it('is disclosed in the build report, with its expiry', async () => {
        // Left on a live instance it changes what the process does, and the
        // person who finds it weeks later is not the person who set it.
        const { logLevel } = await report()
        assert.ok(logLevel, 'expected the report to disclose the installed level')
        assert.equal(logLevel.level, 'debug')
        assert.equal(logLevel.installed, true)
        assert.ok(logLevel.expiresInMinutes > 0, 'and say when it lapses')
    })

    it('goes back to the configured level on --log-reset', async () => {
        await runMikser(workdir, ['--log-reset'])
        assert.equal((await report()).logLevel, null, 'no longer disclosed')
        const after = await edit('C')
        await runMikser(workdir, ['--log-install', 'debug'])
        const loud = await edit('D')
        assert.ok(loud > after, 'and the level really moved back and forth')
        await runMikser(workdir, ['--log-reset'])
    })

    it('refuses an unknown level forwarded, exactly as it does locally', async () => {
        // The forwarded/local split --json and --force each had. The argv path
        // threw and the socket path called setLogLevel and ignored the false
        // it returns, so --log chatty exited 1 alone and built normally with a
        // watcher up. A flag that lies is worse than a flag that is missing.
        for (const flag of ['--log', '--log-install']) {
            const { code, combined } = await runMikser(workdir, [flag, 'chatty'])
            assert.notEqual(code, 0, `${flag} chatty must be refused: ${combined}`)
            assert.match(stripAnsi(combined), /no such level/)
        }
    })

    it('is silent when asked, forwarded, and does not leave the instance mute', async () => {
        // `runtime.options.info` is written by applyLogRequest and restored
        // with the rest of the request contract — captured BEFORE the call,
        // since capturing after would record the value the call just wrote.
        const silent = await runMikser(workdir, ['--force', '--log', 'silent'])
        assert.equal(silent.code, 0, silent.combined)
        assert.equal(stripAnsi(silent.combined).trim(), '', 'silent means silent')

        const after = await runMikser(workdir, ['--force'])
        assert.ok(lines(after.combined) > 0,
            'and the next request gets its output back')
    })

    it('does not let a per-request --log stick to the instance', async () => {
        // --log is a contract for one request. Only --log-install outlives it.
        const before = await edit('E')
        await runMikser(workdir, ['--log', 'debug'])
        const after = await edit('F')
        assert.ok(Math.abs(after - before) <= 2,
            `a per-request level must not persist — ${before} then ${after} lines`)
        assert.equal((await report()).logLevel, null)
    })
})

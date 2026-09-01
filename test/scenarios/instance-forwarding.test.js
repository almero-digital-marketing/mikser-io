// One engine per working folder.
//
// A second `mikser` next to a live `mikser --watch` used to start a second
// engine: two writers, one sqlite catalogue, one output tree, no lock and no
// warning. It forwards now and wears the instance's answer.
//
// A scenario rather than a unit test because every part that can be wrong is
// between processes — the socket, the streaming, the exit code, and whether
// the instance rescans or merely drains what its watcher happened to see.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'
import { socketPath } from '../../src/instance.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`
const LAYOUT = '<!doctype html><title>{{document.meta.title}}</title><body>{{document.meta.title}}</body>'
const doc = (title, href) => `---\nlayout: page\ntitle: ${title}\nhref: ${href}\n---\n`

// Start a watcher and wait until it is actually listening.
async function startInstance(workdir, port) {
    const child = spawn(process.execPath, [
        path.join(MIKSER_ROOT, 'app.js'), '--working-folder', workdir, '--watch', '--server', String(port),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const endpoint = socketPath(workdir)
    for (let i = 0; i < 200; i++) {
        if (existsSync(endpoint)) return child
        await new Promise(r => setTimeout(r, 100))
    }
    child.kill()
    throw new Error('instance never opened its socket')
}

describe('a second invocation forwards to the running one', () => {
    const workdir = freshWorkdir('instance')
    let instance

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': LAYOUT,
            'documents/index.html': doc('One', '/index.html'),
        })
        await runMikser(workdir)
        instance = await startInstance(workdir, 3771)
    })
    after(async () => { instance?.kill(); await cleanup(workdir) })

    it('builds without starting a second engine', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        // The instance's own output, relayed — a local run would say the same
        // things, which is the point: nothing new to learn.
        assert.match(combined, /Mikser completed/)
    })

    // Ask the instance directly, with no process to start in between.
    //
    // Spawning a client takes ~300ms, which is long enough for inotify to
    // deliver the event — so a spawned client cannot tell rescanning from
    // draining. Beating the watcher needs a request sent microseconds after
    // the write, which only an in-process client can do.
    const ask = (dir) => new Promise((resolve) => {
        const socket = net.connect(socketPath(dir))
        let buffer = ''
        socket.on('connect', () => socket.write(JSON.stringify({
            type: 'build', config: path.join(dir, 'mikser.config.js'),
        }) + '\n'))
        socket.on('data', (chunk) => {
            buffer += chunk.toString()
            for (const line of buffer.split('\n')) {
                if (!line.trim()) continue
                let frame
                try { frame = JSON.parse(line) } catch { continue }
                if (frame.type === 'done' || frame.type === 'refused') {
                    socket.end(); resolve(frame)
                }
            }
        })
        socket.on('error', () => resolve({ type: 'error' }))
    })

    it('rescans even when the request beats the file event', async () => {
        // The watermark bug in a different hat: draining what the watcher has
        // already queued builds without the change that prompted the request.
        const file = path.join(workdir, 'documents/raced.html')
        await writeFile(file, doc('Raced', '/raced.html'))
        const answer = await ask(workdir)          // no process start, no delay
        assert.equal(answer.type, 'done', JSON.stringify(answer))

        const out = await readFile(path.join(workdir, 'out/raced/index.html'), 'utf8')
        assert.match(out, /Raced/, 'the file that prompted the build has to be in it')
    })

    it('rescans, so a file written a moment ago is in the build', async () => {
        // The failure this exists to avoid: a client that writes and
        // immediately asks can beat the inotify event, so draining what the
        // watcher already queued would build without the very change that
        // prompted the request.
        await writeFile(path.join(workdir, 'documents/fresh.html'), doc('Fresh', '/fresh.html'))
        const { code } = await runMikser(workdir)
        assert.equal(code, 0)
        const out = await readFile(path.join(workdir, 'out/fresh/index.html'), 'utf8')
        assert.match(out, /Fresh/)
    })

    it('comes back non-zero when the build failed', async () => {
        // The whole reason a one-shot gets run next to a watcher: exit status
        // is the completion signal. A forwarded build that always said 0 would
        // be worse than useless.
        const layout = path.join(workdir, 'layouts/page.hbs')
        const good = await readFile(layout, 'utf8')
        await writeFile(layout, '{{#each}}broken')
        const bad = await runMikser(workdir)
        await writeFile(layout, good)
        await new Promise(r => setTimeout(r, 1500))
        const fixed = await runMikser(workdir)

        assert.equal(bad.code, 1, `a failed build must not report success\n${bad.combined}`)
        assert.equal(fixed.code, 0, fixed.combined)
    })

    it('answers --verify from the live catalogue', async () => {
        // These read, so running them locally never damaged anything — and
        // never made them correct either. At ten thousand pages a local
        // --verify reads a catalogue the instance is mid-way through writing
        // and reports drift that is a half-finished cycle.
        const { code, combined } = await runMikser(workdir, ['--verify'])
        assert.equal(code, 0, combined)
        assert.match(combined, /Verify OK/)
    })

    it('keeps --explain\'s not-found exit code across the socket', async () => {
        // 3 means "no such entity", which is neither clean nor corrupt. An
        // agent branching on the exit code has only this to go on.
        const found = await runMikser(workdir, ['--explain', '/documents/index.html'])
        const missing = await runMikser(workdir, ['--explain', '/nope'])
        assert.equal(found.code, 0, found.combined)
        assert.equal(missing.code, 3, missing.combined)
    })

    it('refuses a report against the wrong config too', async () => {
        // A --verify with the wrong config is the incident this project
        // already wrote a rule about. It answers against a manifest a
        // different config produced, which is wrong whether or not it writes.
        await writeFile(path.join(workdir, 'mikser.config.prod.js'), CONFIG)
        const { code, combined } = await runMikser(workdir, ['--verify', '-c', 'mikser.config.prod.js'])
        assert.equal(code, 1)
        assert.match(combined, /this instance is running/)
    })

    it('refuses a different config rather than building with the wrong one', async () => {
        // The accident already written down: a command resolving the prod
        // config reaching an instance running the dev one.
        await writeFile(path.join(workdir, 'mikser.config.prod.js'), CONFIG)
        const { code, combined } = await runMikser(workdir, ['-c', 'mikser.config.prod.js'])
        assert.equal(code, 1)
        assert.match(combined, /this instance is running/)
        assert.match(combined, /--no-attach/, 'and says how to get a private engine')
    })

    it('refuses a second server rather than forwarding it', async () => {
        // The bug this replaced: `--server 3010` was treated as a build
        // request, so the instance built, the client printed "completed" and
        // exited, and nothing was listening on 3010. A server is not a
        // request an engine can satisfy on someone's behalf — it has to open
        // a port in ITS OWN process — so it stops instead.
        const { code, combined } = await runMikser(workdir, ['--server', '3999'])
        assert.equal(code, 1, `a server that cannot start must not report success\n${combined}`)
        assert.match(combined, /cannot be forwarded/)
        assert.match(combined, /--no-attach/, 'and says how to run one anyway')
    })

    it('refuses a second watcher for the same reason', async () => {
        const { code, combined } = await runMikser(workdir, ['--watch'])
        assert.equal(code, 1, combined)
    })

    it('--no-attach runs its own engine, and says the folder is held', async () => {
        const { code, combined } = await runMikser(workdir, ['--no-attach'])
        assert.equal(code, 0, combined)
        assert.match(combined, /Another mikser is already running/)
    })
})

describe('when there is nobody to forward to', () => {
    const workdir = freshWorkdir('instance-alone')
    after(() => cleanup(workdir))

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': LAYOUT,
            'documents/index.html': doc('Alone', '/index.html'),
        })
    })

    it('builds locally, exactly as before', async () => {
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        assert.match(combined, /Mikser completed/)
    })

    it('does not hang on a socket a crash left behind', async () => {
        // The usual way this pattern fails: connect-and-fail has to mean
        // "no instance — clean up and carry on", never a wait.
        const endpoint = socketPath(workdir)
        await writeFile(endpoint, '').catch(() => {})
        const started = Date.now()
        const { code } = await runMikser(workdir)
        assert.equal(code, 0)
        assert.ok(Date.now() - started < 20_000, 'must not block on a dead endpoint')
        await rm(endpoint, { force: true })
    })
})

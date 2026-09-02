// The machine-readable channel has to survive being forwarded.
//
// `--json` is a promise about STREAMS: the document on stdout, every log line
// on stderr, so `mikser --json | jq` works. Both halves are decided by the
// process doing the writing, and when an instance is listening that process is
// the instance — which was started without the flag.
//
// So a forwarded `--json` exited 0 and wrote nothing at all to stdout:
// emitReport() asks runtime.options.json and found it false, and the client
// replayed every captured chunk onto stderr regardless of where the instance
// had written it. Both failures are silent, and they are silent to the one
// consumer that cannot notice — a script reading stdout gets zero bytes and a
// success code, which is indistinguishable from a build with nothing to say.
//
// The local behaviour is the specification here: every assertion below is
// "forwarded matches what the same command does with nothing listening".

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'
import { socketPath } from '../../src/instance.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`

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

describe('--json across the forwarding boundary', () => {
    const workdir = freshWorkdir('forwarded-json')
    let instance
    let local

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': CONFIG,
            'layouts/page.hbs': '<!doctype html><body>{{document.meta.title}}</body>',
            'documents/index.html': '---\nlayout: page\ntitle: One\n---\n',
        })
        // The control, taken with nothing listening: this is what the command
        // means, and the forwarded answer has to match it.
        local = await runMikser(workdir, ['--json'])
        instance = await startInstance(workdir)
    })
    after(async () => { instance?.kill(); await cleanup(workdir) })

    it('puts a parseable document on stdout, not zero bytes', async () => {
        const { code, stdout } = await runMikser(workdir, ['--json'])
        assert.equal(code, 0)
        assert.notEqual(stdout.length, 0,
            'a forwarded --json wrote nothing to stdout while exiting 0 — the exact silence this covers')
        // Parsing the WHOLE stream, not searching it for a brace: a document
        // with a log line in front of it is not a document, and that is the
        // shape the stream-blind replay produced.
        const report = JSON.parse(stdout)
        assert.equal(typeof report.summary, 'object')
    })

    it('is the same document the local run produces', async () => {
        const { stdout } = await runMikser(workdir, ['--json'])
        const keys = (s) => Object.keys(JSON.parse(s)).sort()
        assert.deepEqual(keys(stdout), keys(local.stdout),
            'forwarded and local must not be two different reports')
    })

    it('describes the cycle it just ran, not one it found lying around', async () => {
        // A stale report would parse, look right, and answer for a build that
        // happened before the caller asked — so identity is asserted, not
        // merely well-formedness.
        const first = JSON.parse((await runMikser(workdir, ['--json'])).stdout)
        const asked = Date.now()
        const second = JSON.parse((await runMikser(workdir, ['--json'])).stdout)
        assert.ok(second.cycleId > first.cycleId,
            `each request runs its own cycle: ${first.cycleId} then ${second.cycleId}`)
        assert.ok(second.startedAt >= asked - 1000,
            'the cycle must have started when the request arrived, not at instance startup')
    })

    it('keeps the log off stdout, which is what makes the document parseable', async () => {
        const { stdout, stderr } = await runMikser(workdir, ['--json'])
        assert.doesNotMatch(stdout, /Mikser completed/,
            `the log belongs on stderr under --json\n${stdout}`)
        assert.match(stderr, /Mikser completed/,
            'and it still has to be visible to the operator')
    })

    it('carries a tool document too, on the stream an agent pipes', async () => {
        // --tools already travelled with `json` on the request and still
        // arrived on stderr: the client had no way to know which stream the
        // instance had used, so this is the half the request flag alone does
        // not fix.
        const { code, stdout } = await runMikser(workdir, ['--tools', '--json'])
        assert.equal(code, 0)
        assert.ok(Array.isArray(JSON.parse(stdout)), `--tools --json must land on stdout\n${stdout}`)
    })

    it('leaves the instance in the mode it was started in', async () => {
        // The contract is the client's, for one request. An instance nudged
        // into json mode by one caller would answer the next one — and every
        // watch cycle after that — in a format nobody asked for.
        const { code, stdout } = await runMikser(workdir, [])
        assert.equal(code, 0)
        assert.match(stdout, /Mikser completed/,
            `a plain build after a --json one must still be human output\n${stdout}`)
        assert.doesNotMatch(stdout, /"summary"/, 'and must not carry a json document')
    })

    it('replays ordinary output on the stream a local run uses', async () => {
        // Not a --json question: the client used to put everything on stderr,
        // so `mikser > log.txt` captured an empty file whenever a watcher
        // happened to be running.
        const { stdout, stderr } = await runMikser(workdir, [])
        assert.match(stdout, /Mikser completed/, `a forwarded build logs to stdout\n${stderr}`)
    })
})

// One document per request, even when the instance is still starting.
//
// The control socket opens in onLoaded, before the instance's own first build
// has finished. A client that connects into that window turns on the json
// contract — and the INSTANCE's startup cycle then writes its report into the
// client's stdout, followed by the requested build's. Two documents in a
// stream that promises one, which fails a caller exactly as badly as emitting
// none: `JSON.parse` throws on the whole thing.
//
// Widened deliberately here with a plugin that spends time in onImport, so the
// window is reliably open when the request lands rather than occasionally.

const SLOW = `
export function slow(ms) {
    return ({ onImport }) => {
        onImport(async () => { await new Promise(r => setTimeout(r, ms)) })
        return { collection: 'slow', type: 'slow' }
    }
}
`

describe('a request that lands while the instance is still booting', () => {
    const workdir = freshWorkdir('forwarded-json-boot')
    let instance
    after(async () => { instance?.kill(); await cleanup(workdir) })

    it('still answers with exactly one document', async () => {
        await setupFixture(workdir, {
            'mikser.config.js': `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
import { slow } from './slow.js'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs(), slow(600)] }
`,
            'slow.js': SLOW,
            'layouts/page.hbs': '<!doctype html><title>x</title>',
            'documents/index.html': '---\nlayout: page\n---\n',
        })
        // No warm-up build: the instance starts cold, so its first cycle is
        // still running when the socket appears.
        instance = await startInstance(workdir)

        const { code, stdout } = await runMikser(workdir, ['--json'])
        assert.equal(code, 0)
        // The whole stream, not a brace-hunt: a second document appended to
        // the first is exactly what this guards against, and only parsing the
        // entire thing catches it.
        const report = JSON.parse(stdout)
        assert.equal(typeof report.summary, 'object')
    })
})

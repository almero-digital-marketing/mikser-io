// A log that is read afterwards says when things happened.
//
// The terminal format is deliberately minimal — no timestamp, no pid, no
// level word, an icon for severity — because someone watching a build knows
// what time it is. That format was also what a supervisor captured, so
// pm2/systemd/CI logs were a wall of undated lines wearing ANSI escapes.
//
// It cost a real incident. A deployment served stale pages, and
// reconstructing the sequence meant ordering events by file mtimes and git
// commit dates, because the build's own log could not say when any of it
// happened — and every excerpt had to be piped through sed to be legible.
//
// So the format follows the destination. Attended: unchanged. Redirected:
// timestamps, no colour.
//
// `SYS:standard` carries the UTC offset, which is not decoration — that
// incident needed a container's clock lined up against commits made in
// another zone, and a bare wall-clock time cannot answer that.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'

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

// [2026-09-04 16:13:50.952 +0300] — date, milliseconds, offset.
const STAMP = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}\]/
const ANSI = /\[[0-9;]*m/

describe('log format follows the destination', () => {
    const workdir = freshWorkdir('log-format')
    before(() => setupFixture(workdir, FIXTURE))
    after(() => cleanup(workdir))

    it('stamps every line when the output is redirected', async () => {
        // runMikser pipes, which is what a supervisor does.
        const { code, combined } = await runMikser(workdir)
        assert.equal(code, 0, combined)
        const lines = combined.split('\n').filter(l => l.trim())
        assert.ok(lines.length > 3, 'expected a few lines of build output')
        for (const line of lines) {
            assert.match(line, STAMP, `every line needs a timestamp:\n${line}`)
        }
    })

    it('carries the UTC offset, so the clock can be compared with another zone', async () => {
        const { combined } = await runMikser(workdir)
        const [stamp] = combined.match(STAMP)
        assert.match(stamp, /[+-]\d{4}\]$/, 'the offset is the half that makes it comparable')
    })

    it('writes no ANSI escapes into a file', async () => {
        // RAW stdout/stderr, not `combined` — the harness runs that through
        // stripAnsi, so asserting on it would pass no matter what the engine
        // emitted. The first version of this test did exactly that and was
        // worth nothing.
        const { stdout, stderr } = await runMikser(workdir)
        assert.doesNotMatch(stdout + stderr, ANSI,
            'a redirected log is read with a pager, not a terminal emulator')
    })

    it('leaves an attended terminal exactly as it was', async () => {
        // A pty, so the engine sees a TTY. Nothing is asserted about colour
        // beyond its presence: the point is that redirecting is what changes
        // the format, and watching is unaffected.
        const out = await new Promise((resolve, reject) => {
            const child = spawn('script', [
                '-qec',
                `node --no-warnings ${path.join(MIKSER_ROOT, 'app.js')} --working-folder ${workdir}`,
                '/dev/null',
            ], { cwd: MIKSER_ROOT, env: { ...process.env, NO_COLOR: '' } })
            let buffer = ''
            child.stdout.on('data', d => { buffer += d })
            child.stderr.on('data', d => { buffer += d })
            child.on('error', reject)
            child.on('close', () => resolve(buffer))
        })
        assert.match(out, /Mikser completed/, `expected a build:\n${out}`)
        assert.doesNotMatch(out, STAMP, 'a watched build is not stamped')
    })
})

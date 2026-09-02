// `--clear` against a running instance is refused, not ignored.
//
// Clearing is a BOOT operation: it removes the output folder and it closes,
// unlinks and reopens the cache database, which is why the wipe lives at the
// point the database is opened and nowhere else. A running instance holds that
// handle with prepared statements against it throughout the engine, has its
// manifest and plugin state loaded from what would be deleted, and may be
// answering requests out of the folder being removed. There is no point
// mid-run where the flag can be honoured and still mean what it says.
//
// So it was carried on the request and never read: `mikser --clear` against a
// watcher rebuilt normally and exited 0 with nothing cleared. Same words, two
// outcomes, and the quiet one looks like it worked — the failure this surface
// exists to remove. A half-clear would be worse than either, because then the
// caller could not say what state the folder was left in.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir, MIKSER_ROOT } from './_harness.js'
import { socketPath } from '../../src/instance.js'

const CONFIG = `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default { plugins: [documents(), frontMatter(), layouts(), renderHbs()] }
`

const FILES = {
    'mikser.config.js': CONFIG,
    'layouts/page.html.hbs': '<!doctype html><body>x</body>',
    'documents/index.html': '---\nlayout: page\n---\n',
}

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

describe('--clear with nothing listening', () => {
    const workdir = freshWorkdir('clear-local')
    after(() => cleanup(workdir))

    it('removes what is in the output folder', async () => {
        // The control. This is what the flag means, and it is the behaviour a
        // forwarded invocation was silently not delivering.
        await setupFixture(workdir, FILES)
        await runMikser(workdir)
        const stray = path.join(workdir, 'out', 'stray.txt')
        await writeFile(stray, 'left over from an earlier build\n')

        const { code } = await runMikser(workdir, ['--clear'])
        assert.equal(code, 0)
        assert.equal(existsSync(stray), false, 'a local --clear must clear')
    })
})

describe('--clear against a running instance', () => {
    const workdir = freshWorkdir('clear-forwarded')
    let instance
    let stray

    before(async () => {
        await setupFixture(workdir, FILES)
        await runMikser(workdir)
        instance = await startInstance(workdir)
        stray = path.join(workdir, 'out', 'stray.txt')
        await writeFile(stray, 'left over from an earlier build\n')
    })
    after(async () => { instance?.kill(); await cleanup(workdir) })

    it('exits non-zero rather than reporting a build it did not clear for', async () => {
        const { code } = await runMikser(workdir, ['--clear'])
        assert.equal(code, 1, 'accepting and ignoring the flag is the bug')
    })

    it('says the instance is why, and what to do about it', async () => {
        const { combined } = await runMikser(workdir, ['--clear'])
        assert.match(combined, /--clear cannot run while it does/, combined)
        assert.match(combined, /Stop it and run this again/,
            `a refusal without the remedy just moves the confusion\n${combined}`)
    })

    it('leaves the folder exactly as it was — no half-clear', async () => {
        await runMikser(workdir, ['--clear'])
        assert.equal(existsSync(stray), true,
            'refusing means refusing; a partial clear would be worse than either outcome')
        assert.equal(existsSync(path.join(workdir, 'out', 'index.html')), true,
            'and the built output is untouched')
    })

    it('refuses only this flag — ordinary builds still forward', async () => {
        const { code, combined } = await runMikser(workdir, [])
        assert.equal(code, 0, combined)
        assert.match(combined, /Mikser completed/)
    })
})

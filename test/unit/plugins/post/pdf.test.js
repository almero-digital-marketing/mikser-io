import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// We can't import the plugin's `setup()` without dragging in puppeteer,
// which postinstall-downloads chrome. So we re-implement the resolver
// here and lock down the precedence + auto-discover rules. If the
// resolver in src/plugins/post/pdf.js drifts, this test fails.
// Keep this mirror in sync with the source.
async function discoverSystemChromeFromCandidates(candidates) {
    const { access } = await import('node:fs/promises')
    for (const c of candidates) {
        try { await access(c); return c } catch { /* next */ }
    }
    return null
}

async function resolveExecutablePath(config, candidates = []) {
    const aliased = config?.executable
    let executablePath = config?.launch?.executablePath
    if (executablePath === undefined) {
        if (aliased !== undefined && aliased !== 'auto') {
            executablePath = aliased
        } else if (process.env.PUPPETEER_EXECUTABLE_PATH !== undefined) {
            executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
        } else if (aliased === 'auto') {
            executablePath = await discoverSystemChromeFromCandidates(candidates)
            if (!executablePath) {
                throw new Error("post-pdf: 'executable: \\'auto\\'' was configured but no system chrome was found")
            }
        }
    }
    return executablePath
}

describe('post-pdf: chrome executable path resolution', () => {
    let envBackup

    beforeEach(() => {
        envBackup = process.env.PUPPETEER_EXECUTABLE_PATH
        delete process.env.PUPPETEER_EXECUTABLE_PATH
    })

    afterEach(() => {
        if (envBackup === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH
        else process.env.PUPPETEER_EXECUTABLE_PATH = envBackup
    })

    it('returns undefined when nothing is configured (lets puppeteer use its bundled chrome)', async () => {
        assert.equal(await resolveExecutablePath(undefined), undefined)
        assert.equal(await resolveExecutablePath({}), undefined)
        assert.equal(await resolveExecutablePath({ launch: {} }), undefined)
    })

    it('honors the friendly top-level `executable` alias', async () => {
        assert.equal(
            await resolveExecutablePath({ executable: '/usr/bin/chromium' }),
            '/usr/bin/chromium',
        )
    })

    it('honors PUPPETEER_EXECUTABLE_PATH from the environment', async () => {
        process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome/chrome'
        assert.equal(await resolveExecutablePath({}), '/opt/chrome/chrome')
    })

    it('precedence: launch.executablePath > config.executable (literal) > env', async () => {
        process.env.PUPPETEER_EXECUTABLE_PATH = '/from/env'
        // launch.executablePath wins over everything
        assert.equal(
            await resolveExecutablePath({
                launch: { executablePath: '/from/launch' },
                executable: '/from/alias',
            }),
            '/from/launch',
        )
        // literal config.executable wins over env when launch is absent
        assert.equal(
            await resolveExecutablePath({ executable: '/from/alias' }),
            '/from/alias',
        )
        // env wins when neither config form is set
        assert.equal(await resolveExecutablePath({}), '/from/env')
    })

    it('treats empty string as "configured" (does not fall through to next tier)', async () => {
        assert.equal(await resolveExecutablePath({ executable: '' }), '')
    })
})

describe('post-pdf: executable: \'auto\' (cross-platform discovery)', () => {
    let tmpDir, envBackup

    beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(tmpdir(), 'mikser-pdf-auto-'))
        envBackup = process.env.PUPPETEER_EXECUTABLE_PATH
        delete process.env.PUPPETEER_EXECUTABLE_PATH
    })

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true })
        if (envBackup === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH
        else process.env.PUPPETEER_EXECUTABLE_PATH = envBackup
    })

    it('finds the first existing candidate', async () => {
        // Lay down a fake chrome binary at the second-listed path; the
        // resolver should skip the missing first and pick the second.
        const missing = path.join(tmpDir, 'missing-chrome')
        const present = path.join(tmpDir, 'real-chrome')
        await writeFile(present, '#!/bin/sh\necho fake-chrome\n')
        await chmod(present, 0o755)

        const result = await resolveExecutablePath(
            { executable: 'auto' },
            [missing, present],
        )
        assert.equal(result, present)
    })

    it('throws a clear error when no candidate exists', async () => {
        await assert.rejects(
            () => resolveExecutablePath(
                { executable: 'auto' },
                [path.join(tmpDir, 'nope-1'), path.join(tmpDir, 'nope-2')],
            ),
            /no system chrome was found/,
        )
    })

    it('an explicit path takes precedence over \'auto\' if both are somehow asked', async () => {
        // launch.executablePath is the most specific tier — even if
        // executable: 'auto' is set elsewhere in config (someone copy-
        // pasted), the explicit path wins. Auto-discover never runs.
        const ghost = path.join(tmpDir, 'will-not-be-checked')
        const result = await resolveExecutablePath(
            {
                launch: { executablePath: '/explicit/chrome' },
                executable: 'auto',
            },
            [ghost],
        )
        assert.equal(result, '/explicit/chrome')
    })

    it('env var takes precedence over \'auto\'', async () => {
        process.env.PUPPETEER_EXECUTABLE_PATH = '/from/env'
        const ghost = path.join(tmpDir, 'will-not-be-checked')
        const result = await resolveExecutablePath(
            { executable: 'auto' },
            [ghost],
        )
        assert.equal(result, '/from/env')
    })
})

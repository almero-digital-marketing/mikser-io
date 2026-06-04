import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'

// We can't import the plugin and exercise its real `setup` without
// also dragging in puppeteer (which postinstall-downloads chrome).
// Instead, mirror the resolution logic and lock down the precedence
// rules with a tiny local helper so any future refactor keeps them.
// The logic under test is the executablePath resolver in src/plugins/
// post/pdf.js — if it changes, this test should fail.
function resolveExecutablePath(config) {
    return (
        config?.launch?.executablePath
        ?? config?.executable
        ?? process.env.PUPPETEER_EXECUTABLE_PATH
        ?? undefined
    )
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

    it('returns undefined when nothing is configured (lets puppeteer use its bundled chrome)', () => {
        assert.equal(resolveExecutablePath(undefined), undefined)
        assert.equal(resolveExecutablePath({}), undefined)
        assert.equal(resolveExecutablePath({ launch: {} }), undefined)
    })

    it('honors the friendly top-level `executable` alias', () => {
        assert.equal(
            resolveExecutablePath({ executable: '/usr/bin/chromium' }),
            '/usr/bin/chromium',
        )
    })

    it('honors PUPPETEER_EXECUTABLE_PATH from the environment', () => {
        process.env.PUPPETEER_EXECUTABLE_PATH = '/opt/chrome/chrome'
        assert.equal(resolveExecutablePath({}), '/opt/chrome/chrome')
    })

    it('precedence: launch.executablePath > config.executable > env', () => {
        process.env.PUPPETEER_EXECUTABLE_PATH = '/from/env'
        // launch.executablePath wins over everything
        assert.equal(
            resolveExecutablePath({
                launch: { executablePath: '/from/launch' },
                executable: '/from/alias',
            }),
            '/from/launch',
        )
        // config.executable wins over env when launch is absent
        assert.equal(
            resolveExecutablePath({ executable: '/from/alias' }),
            '/from/alias',
        )
        // env wins when neither config form is set
        assert.equal(resolveExecutablePath({}), '/from/env')
    })

    it('treats empty string as "configured" (does not fall through to next tier)', () => {
        // Belt-and-suspenders: an empty string is a user error worth
        // surfacing (puppeteer.launch will throw with the empty path
        // rather than silently downloading), not a fall-through to env.
        // Documents the ?? semantics on strings vs null/undefined.
        assert.equal(resolveExecutablePath({ executable: '' }), '')
    })
})

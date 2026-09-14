// A config module edited while --watch is running.
//
// Node caches the module and mikser only compares the config stamp at
// startup — that is where "Config changed since the last run. Wiping the
// cache…" comes from. So the process keeps running the logic it booted
// with, rebuilds happily, and reports green.
//
// Reported after it cost a consumer several rounds: a derivation plugin
// they had already fixed kept producing the old output, every symptom
// pointed at the data rather than at the process, and they reported it
// as broken twice before finding it.
//
// The comparison already existed for the forwarded-command path. These
// pin it as a reusable check, since that is what the watch path now calls.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import { configStale } from '../../src/instance.js'

async function withConfig(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-config-'))
    const file = path.join(dir, 'mikser.config.js')
    const helper = path.join(dir, 'derive.js')
    await writeFile(file, 'export default {}\n')
    await writeFile(helper, 'export const derive = () => 1\n')
    try { return await fn({ dir, file, helper }) }
    finally { await rm(dir, { recursive: true, force: true }) }
}

describe('configStale', () => {
    beforeEach(() => {
        delete runtime.options.configStamps
        delete runtime.options.configCoverage
    })

    it('records a baseline on the first call and judges nothing', async () => {
        await withConfig(async ({ file, helper }) => {
            runtime.options.configCoverage = { files: [file, helper], complete: true }
            assert.equal(await configStale(), null, 'nothing to compare against yet')
            assert.ok(runtime.options.configStamps[file] > 0, 'the baseline was recorded')
        })
    })

    it('names the file that changed', async () => {
        await withConfig(async ({ file, helper }) => {
            runtime.options.configCoverage = { files: [file, helper], complete: true }
            await configStale()
            // An IMPORTED module, not the entry file — that is the case the
            // consumer hit, and the one a naive entry-file check misses.
            await writeFile(helper, 'export const derive = () => 2\n')
            const future = new Date(Date.now() + 2000)
            await utimes(helper, future, future)
            assert.equal(await configStale(), helper)
        })
    })

    it('stays quiet when nothing moved', async () => {
        await withConfig(async ({ file, helper }) => {
            runtime.options.configCoverage = { files: [file, helper], complete: true }
            await configStale()
            assert.equal(await configStale(), null)
        })
    })

    it('counts a deleted config file as changed', async () => {
        await withConfig(async ({ dir, file, helper }) => {
            runtime.options.configCoverage = { files: [file, helper], complete: true }
            await configStale()
            await rm(helper)
            assert.equal(await configStale(), helper, 'a module that vanished is a change')
        })
    })

    it('has nothing to say when no config file is covered', async () => {
        runtime.options.configCoverage = { files: [], complete: true }
        assert.equal(await configStale(), null, 'defaults all the way down is a legitimate state')
    })
})

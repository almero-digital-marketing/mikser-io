// Regression: when something is keeping the process alive across many
// process() cycles — either watch mode (chokidar handles) or an HTTP
// server (runtime.options.app, set by --server or by a caller passing
// setup({ app })) — journal.clearJournal must NOT tear down the sqlite
// connection. Without this, the second journal write would crash with
// "Unable to acquire a connection".

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import { addEntry, clearJournal } from '../../src/journal.js'

// The journal module's onLoaded hook initializes its knex client when
// the lifecycle reaches the 'loaded' phase. We don't want to spin up the
// whole engine for this test, so we fire just that one phase.
async function loadJournal(runtimeFolder) {
    runtime.options.runtimeFolder = runtimeFolder
    runtime.engine = { logger: console }
    for (const cb of runtime.hooks.loaded) await cb()
}

describe('journal: keep the sqlite connection alive across cycles', () => {
    let dir

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'mikser-journal-'))
        await loadJournal(dir)
    })

    after(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it('addEntry still works after clearJournal when runtime.options.app is set', async () => {
        runtime.options.app = { /* any non-null value — signals "server present" */ }
        runtime.options.watch = false

        await addEntry({ entity: { id: '/a' }, operation: 'update', context: {}, options: {} })
        await clearJournal(false)
        await assert.doesNotReject(() =>
            addEntry({ entity: { id: '/b' }, operation: 'update', context: {}, options: {} })
        )
    })

    it('addEntry still works after clearJournal when watch=true', async () => {
        runtime.options.app = undefined
        runtime.options.watch = true

        await clearJournal(false)
        await assert.doesNotReject(() =>
            addEntry({ entity: { id: '/c' }, operation: 'update', context: {}, options: {} })
        )
    })

    it('addEntry fails after clearJournal in plain one-shot mode (no flags)', async () => {
        runtime.options.app = undefined
        runtime.options.watch = false

        await clearJournal(false)
        // knex's underlying error varies — sometimes "Unable to acquire a
        // connection", sometimes "aborted" (from the tarn pool). Either
        // way the addEntry rejects: that's the regression we want to fail
        // loudly when nothing's keeping the process alive.
        await assert.rejects(() =>
            addEntry({ entity: { id: '/d' }, operation: 'update', context: {}, options: {} })
        )
    })
})

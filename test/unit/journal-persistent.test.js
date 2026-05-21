// Regression: when the API plugin (or any long-running consumer) is in
// use, runtime.options.persistent stops journal.clearJournal from
// destroying the sqlite connection at the end of each cycle. Without
// this, the second render request would crash with "Unable to acquire a
// connection" because the journal's knex client had been torn down.

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

describe('journal: persistent mode keeps the sqlite connection alive', () => {
    let dir

    before(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'mikser-journal-'))
        await loadJournal(dir)
    })

    after(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it('addEntry still works after clearJournal when persistent=true', async () => {
        runtime.options.persistent = true
        runtime.options.watch = false

        await addEntry({ entity: { id: '/a' }, operation: 'update', context: {}, options: {} })
        await clearJournal(false)
        // Would throw "Unable to acquire a connection" if the journal were
        // destroyed.
        await assert.doesNotReject(() =>
            addEntry({ entity: { id: '/b' }, operation: 'update', context: {}, options: {} })
        )
    })

    it('addEntry still works after clearJournal when watch=true', async () => {
        runtime.options.persistent = false
        runtime.options.watch = true

        await clearJournal(false)
        await assert.doesNotReject(() =>
            addEntry({ entity: { id: '/c' }, operation: 'update', context: {}, options: {} })
        )
    })

    it('addEntry fails after clearJournal in plain one-shot mode (no flags)', async () => {
        runtime.options.persistent = false
        runtime.options.watch = false

        await clearJournal(false)
        // knex's underlying error varies — sometimes "Unable to acquire a
        // connection", sometimes "aborted" (from the tarn pool). Either
        // way the addEntry rejects: that's the regression we want to fail
        // loudly without the persistent flag.
        await assert.rejects(() =>
            addEntry({ entity: { id: '/d' }, operation: 'update', context: {}, options: {} })
        )
    })
})

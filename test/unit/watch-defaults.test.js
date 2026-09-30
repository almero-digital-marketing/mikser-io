// Which watcher settles, and which must not.
//
// `awaitWriteFinish` exists for the SOURCE watcher: an upload tool stages a
// temporary file in the watched folder and renames it, and an event fired
// before the size stops moving reads a file that is either half-written or
// already gone. That cost a live site four process deaths in an afternoon and
// one derivative built from zero bytes.
//
// `watchFolder` is the generic one and has no such problem — mikser-io-live
// points it at the output folder to push browser reloads, mikser-io-auth at an
// htpasswd, and those files are written by mikser itself or edited in place.
// A settle there is pure latency: measured, an event that arrives in 3ms
// arrives in 753ms behind a 500ms threshold, on top of live's own 250ms
// debounce. The first version of this change applied it to both.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../../src/manager.js', import.meta.url), 'utf8')

describe('watcher defaults', () => {
    it('settles the source watcher', () => {
        assert.match(source, /const SOURCE_WATCH_DEFAULTS = \{[\s\S]*?awaitWriteFinish/,
            'watch() is the path an upload tool writes into')
    })

    it('does NOT settle the generic folder watcher', () => {
        const generic = source.slice(source.indexOf('const WATCH_DEFAULTS = {'),
                                     source.indexOf('const SOURCE_WATCH_DEFAULTS'))
        assert.doesNotMatch(generic, /awaitWriteFinish/,
            'a settle on the output watcher only delays live reload')
    })

    it('carries no polling-only options pretending to be a debounce', () => {
        // `interval` and `binaryInterval` were set to 1000 and 3000 and read
        // as a debounce. chokidar consumes both only inside
        // `if (opts.usePolling)`, and polling is off — so they described an
        // intention that never ran, which stops the next reader looking for
        // the debounce that was actually missing.
        const defaults = source.slice(source.indexOf('const WATCH_DEFAULTS = {'),
                                      source.indexOf('export function watchFolder'))
        assert.doesNotMatch(defaults, /binaryInterval/)
        assert.doesNotMatch(defaults, /\binterval:/)
    })
})

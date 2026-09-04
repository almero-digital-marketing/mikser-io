// The overrides, on their own.
//
// These used to be four copies — in source.js's gate, in a private one inside
// files.js, at the render gate, and in the assets marker — and the copies are
// how an override added to one was missed by the others. The point of testing
// them here rather than only through a build is that a fifth caller should be
// able to ask "what overrides my evidence" and get the same answer without
// standing up an engine.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import {
    REASON, bypassReason, isFullCycle,
    outputMissing, resolveOutputPath, missingOutputIds, forgetMissingOutputs,
} from '../../src/invalidation.js'

let outputFolder
const priorOptions = { ...runtime.options }
const priorCatalog = runtime.catalog
const priorManifest = runtime.manifest

beforeEach(() => {
    outputFolder = mkdtempSync(path.join(tmpdir(), 'invalidation-'))
    runtime.options = { ...priorOptions, outputFolder, force: false, firstRun: false }
    runtime.catalog = { cacheInvalidated: false }
    runtime.manifest = undefined
    forgetMissingOutputs()
})

afterEach(() => {
    rmSync(outputFolder, { recursive: true, force: true })
    runtime.options = priorOptions
    runtime.catalog = priorCatalog
    runtime.manifest = priorManifest
    forgetMissingOutputs()
})

const place = (relative) => {
    const file = path.join(outputFolder, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'bytes')
    return file
}

describe('resolveOutputPath', () => {
    it('resolves an output-relative destination against the output folder', () => {
        place('page/index.html')
        assert.equal(
            resolveOutputPath('/page/index.html'),
            path.join(outputFolder, 'page/index.html'))
    })

    it('accepts an absolute destination, which is the shape assets records', () => {
        const absolute = place('derivative.webp')
        assert.equal(resolveOutputPath(absolute), absolute)
    })

    it('returns the path it looked for when nothing is there', () => {
        // "Missing" without a path is a fact nobody can act on.
        assert.equal(
            resolveOutputPath('/gone.html'),
            path.join(outputFolder, 'gone.html'))
    })
})

describe('outputMissing', () => {
    it('is false for a file that is there and true for one that is not', () => {
        place('here.html')
        assert.equal(outputMissing('/here.html'), false)
        assert.equal(outputMissing('/gone.html'), true)
    })

    it('is false for no destination at all', () => {
        // An entity that writes nothing has nothing to be missing.
        assert.equal(outputMissing(undefined), false)
        assert.equal(outputMissing(''), false)
    })
})

describe('missingOutputIds', () => {
    const manifestOf = (snapshots) => ({ *all() { yield* snapshots } })

    it('names the entities whose recorded output is gone, and only those', () => {
        place('kept.html')
        runtime.manifest = manifestOf([
            { id: '/documents/kept.md', destination: '/kept.html' },
            { id: '/documents/gone.md', destination: '/gone.html' },
            { id: '/documents/nowhere.md', destination: null },
        ])
        assert.deepEqual([...missingOutputIds()], ['/documents/gone.md'])
    })

    it('is memoized for the cycle, and forgettable', () => {
        // Every gate asks, all of them before anything has rendered, so one
        // walk answers all. The memo is dropped in onFinalize, where this
        // cycle's renders make the answer untrue.
        runtime.manifest = manifestOf([{ id: '/a', destination: '/a.html' }])
        assert.deepEqual([...missingOutputIds()], ['/a'])

        place('a.html')
        assert.deepEqual([...missingOutputIds()], ['/a'], 'still the memoized answer')

        forgetMissingOutputs()
        assert.deepEqual([...missingOutputIds()], [], 'and re-read after the memo is dropped')
    })

    it('answers empty rather than throwing when there is no manifest yet', () => {
        runtime.manifest = undefined
        assert.deepEqual([...missingOutputIds()], [])
    })
})

describe('bypassReason', () => {
    it('is null when nothing overrides the evidence', () => {
        assert.equal(bypassReason(), null)
    })

    it('names --force', () => {
        runtime.options.force = true
        assert.equal(bypassReason(), REASON.FORCE)
    })

    it('names a wiped cache', () => {
        runtime.catalog.cacheInvalidated = true
        assert.equal(bypassReason(), REASON.CACHE_INVALIDATED)
    })

    it('names a reload, which only the source layer has', () => {
        assert.equal(bypassReason({ reload: true }), REASON.RELOAD)
    })

    it('names a missing output, but only when asked about an entity', () => {
        runtime.manifest = { *all() { yield { id: '/documents/gone.md', destination: '/gone.html' } } }
        // The render gate passes no id: it checks the output itself, later, so
        // that an entity whose inputs ALSO moved keeps `inputs-changed` as its
        // reason instead of losing the detail to a broader answer.
        assert.equal(bypassReason(), null)
        assert.equal(bypassReason({ id: '/documents/gone.md' }), REASON.OUTPUT_MISSING)
        assert.equal(bypassReason({ id: '/documents/other.md' }), null)
    })

    it('ranks reload and force above the output walk', () => {
        // Ordering is not cosmetic: the cheap universal answers come first so
        // a forced build never pays for a stat per snapshot.
        runtime.manifest = {
            *all() { throw new Error('must not walk snapshots when a cheaper override applies') },
        }
        assert.equal(bypassReason({ reload: true, id: '/x' }), REASON.RELOAD)
        runtime.options.force = true
        assert.equal(bypassReason({ id: '/x' }), REASON.FORCE)
    })
})

describe('isFullCycle', () => {
    it('is true for --force, a first run, and a wiped cache', () => {
        assert.equal(isFullCycle(), false)

        assert.equal(isFullCycle({ options: { force: true } }), true)
        assert.equal(isFullCycle({ options: { firstRun: true } }), true)
        assert.equal(isFullCycle({ catalog: { cacheInvalidated: true } }), true)
    })

    it('counts firstRun, which bypassReason deliberately does not', () => {
        // Nothing to bypass on a first run — no prior checksum, no snapshot,
        // so every gate opens on its own evidence. But everything IS being
        // evaluated, which is what a "matched nothing" warning needs to know.
        runtime.options.firstRun = true
        assert.equal(isFullCycle(runtime), true)
        assert.equal(bypassReason(), null)
    })

    it('reads the runtime it is handed, for a plugin under test', () => {
        assert.equal(isFullCycle({}), false)
        assert.equal(isFullCycle(undefined), false)
    })
})

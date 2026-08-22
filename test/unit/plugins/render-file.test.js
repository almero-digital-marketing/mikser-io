import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as fileHelpers from '../../../src/plugins/render/file.js'

// render-file is a "load() only" plugin — it attaches utility
// functions to the runtime object. We invoke load() with a fake
// runtime, then assert the attached functions behave correctly.
function fakeRuntime() {
    return {}
}

describe('render-file plugin', () => {
    describe('runtime.json', () => {
        it('stringifies primitives', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })

            assert.equal(r.json('hello'),       '"hello"')
            assert.equal(r.json(42),             '42')
            assert.equal(r.json(true),           'true')
            assert.equal(r.json(null),           'null')
            assert.equal(r.json(undefined),      undefined) // JSON.stringify(undefined) returns undefined
        })

        it('stringifies arrays + objects with full structural fidelity', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })

            assert.equal(r.json([1, 'two', null]),  '[1,"two",null]')
            assert.equal(r.json({ a: 1, b: [2, 3] }), '{"a":1,"b":[2,3]}')
        })

        it('escapes quotes inside strings — produces a syntactically valid JS literal', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })

            // This is the whole point of having a json helper:
            // embedding strings that may contain quotes / newlines
            // into a <script> block requires JSON escaping. Without
            // it, layout authors hand-roll escape logic and get it
            // wrong on the strings that actually contain quotes.
            assert.equal(r.json('she said "hi"'), '"she said \\"hi\\""')
            assert.equal(r.json('a\nb'),          '"a\\nb"')
            assert.equal(r.json('back\\slash'),   '"back\\\\slash"')
        })

        it('returns a plain string (not a SafeString) — caller chooses escaping via {{{}}} vs {{}}', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })

            // No SafeString wrap on purpose. Triple-stash in the
            // template means "raw"; double-stash means "escaped". The
            // helper stays orthogonal to that choice.
            const out = r.json({ id: '/documents/blog/x.md' })
            assert.equal(typeof out, 'string')
            // Should NOT be a SafeString — that has a string property
            // and other Handlebars-specific shape.
            assert.equal(out.constructor.name, 'String')
        })
    })

    describe('runtime.array', () => {
        it('returns an empty array when called with no args', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })
            assert.deepEqual(r.array(), [])
        })

        it('returns its positional args as an array', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })

            assert.deepEqual(r.array(1, 2, 3),               [1, 2, 3])
            assert.deepEqual(r.array('a', 'b'),               ['a', 'b'])
            assert.deepEqual(r.array(null, undefined, 0),     [null, undefined, 0])
        })

        it('strips the trailing Handlebars options object (with .hash) so it doesn\'t leak into the array', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })

            // Handlebars helpers receive a trailing options object on
            // every call. If we didn't strip it, {{array}} would
            // return [{ hash:{}, … }] instead of [].
            const optionsLike = { hash: {}, data: {}, fn: () => {} }
            assert.deepEqual(r.array(optionsLike), [])
            assert.deepEqual(r.array(1, 2, optionsLike), [1, 2])
        })

        it('preserves trailing plain objects (no .hash) — they are real array elements', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })

            // A user calling `{{array obj1 obj2}}` where obj2 has no
            // `.hash` is using array() to build a list of real
            // objects. We must not eat those.
            const obj = { foo: 'bar' }
            assert.deepEqual(r.array(obj), [obj])
        })
    })

    describe('existing helpers still work (regression check)', () => {
        it('registers readFile, jsonFile, glob, json, array', () => {
            const r = fakeRuntime()
            fileHelpers.load({ runtime: r })

            for (const name of ['readFile', 'jsonFile', 'glob', 'json', 'array']) {
                assert.equal(typeof r[name], 'function', `expected runtime.${name} to be a function`)
            }
        })

        it('readFile + jsonFile read from disk as before', async () => {
            const tmp = await mkdtemp(path.join(tmpdir(), 'mikser-render-file-'))
            try {
                await writeFile(path.join(tmp, 'a.txt'), 'hello')
                await writeFile(path.join(tmp, 'a.json'), '{"x":1}')

                const r = fakeRuntime()
                fileHelpers.load({ runtime: r })

                assert.equal(r.readFile(path.join(tmp, 'a.txt')), 'hello')
                assert.deepEqual(r.jsonFile(path.join(tmp, 'a.json')), { x: 1 })
            } finally {
                await rm(tmp, { recursive: true, force: true })
            }
        })
    })
})

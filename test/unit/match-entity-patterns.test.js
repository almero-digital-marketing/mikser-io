// `matchEntity` compiles each glob once and keeps it.
//
// It used to call minimatch's one-shot form, which parses and compiles the
// pattern on every call — and this function is asked the same question about
// the same handful of patterns once per entity, per preset, per source rule.
// On a 6,800-entity site with 29 asset presets that is 5.7 million
// compilations, and a CPU profile of a restart put HALF its samples inside
// minimatch's parser: 44 seconds of 89, none of it in the matcher.
//
// The risk a cache brings is the one these tests are mostly about: a compiled
// pattern is now shared between calls, so it must carry no state from the
// entity it was last asked about.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { minimatch } from 'minimatch'

import { matchEntity } from '../../src/utils/entity.js'

const PATTERNS = [
    '/documents/**/*.json', '/files/**/*.jpg', '/a/{b,c}/d', '/**/*.{jpg,png}',
    '*', '**', '/a/*/b', '/a/b/**', '[a-z]*.txt', '!(foo)*', '#comment', '/a/b/c',
]
const PATHS = [
    '/documents/reports/r.json', '/files/frames/f.jpg', '/a/b/d', '/a/c/d', '/a/b/c',
    '/a/b/x/y', 'foo.txt', 'bar.txt', '#comment', '/hero.png', '',
]

describe('matchEntity against a glob', () => {
    it('answers exactly what the uncached matcher answers', () => {
        // The whole contract: a cache that changed any answer would be a
        // silent change to which files every preset, source rule and resource
        // library covers.
        for (const pattern of PATTERNS) {
            for (const id of PATHS) {
                assert.equal(
                    matchEntity({ id, name: id }, pattern),
                    minimatch(id, pattern),
                    `pattern ${JSON.stringify(pattern)} against ${JSON.stringify(id)}`)
            }
        }
    })

    it("matches `@/`-prefixed patterns against the entity's name, not its id", () => {
        const entity = { id: '/files/images/hero.jpg', name: '/images/hero.jpg' }
        assert.equal(matchEntity(entity, '@//images/*'), true)
        assert.equal(matchEntity(entity, '/images/*'), false)
    })

    it('gives a different answer for a different entity through the same pattern', () => {
        // A compiled pattern is reused now. If it held anything from the call
        // before it, the second entity would get the first one's answer —
        // which no amount of correct globbing would show up as.
        const pattern = '/files/**/*.jpg'
        for (let round = 0; round < 3; round++) {
            assert.equal(matchEntity({ id: '/files/a/hero.jpg' }, pattern), true)
            assert.equal(matchEntity({ id: '/files/a/hero.png' }, pattern), false)
            assert.equal(matchEntity({ id: '/documents/a/hero.jpg' }, pattern), false)
        }
    })

    it('reads a string entity as the path itself', () => {
        assert.equal(matchEntity('/files/hero.jpg', '/files/*.jpg'), true)
        assert.equal(matchEntity('/files/hero.png', '/files/*.jpg'), false)
    })

    it('keeps the non-glob forms', () => {
        assert.equal(matchEntity({ id: '/a' }, null), false)
        assert.equal(matchEntity({ id: '/a' }, ''), false)
        assert.equal(matchEntity({ id: '/a', collection: 'files' }, { collection: 'files' }), true)
        assert.equal(matchEntity({ id: '/a', collection: 'files' }, { collection: 'documents' }), false)
        assert.equal(matchEntity({ id: '/a' }, (entity) => entity.id === '/a'), true)
        assert.throws(() => matchEntity({ id: '/a' }, 7), /Invalid match type/)
    })

    it('costs far less to ask the same pattern than to ask a new one each time', () => {
        // A ratio rather than a budget. Both halves do the same number of
        // matches of the same shape on the same machine, so what is left
        // between them is the compile — and a cache that stopped working
        // would bring them level. Measured at ~20x; asserted at 3x so the
        // test says something about the mechanism and nothing about the box
        // it runs on.
        const ROUNDS = 20_000
        const entity = { id: '/files/frames/frame-00001.jpg' }

        const start = (fn) => { const t = performance.now(); fn(); return performance.now() - t }
        // Warm both paths so neither pays for the first JIT tier.
        for (let i = 0; i < 1000; i++) matchEntity(entity, '/files/**/*.jpg')
        for (let i = 0; i < 1000; i++) matchEntity(entity, `/warm-${i}/**/*.jpg`)

        const distinct = start(() => {
            for (let i = 0; i < ROUNDS; i++) matchEntity(entity, `/files-${i}/**/*.jpg`)
        })
        const shared = start(() => {
            for (let i = 0; i < ROUNDS; i++) matchEntity(entity, '/files/**/*.jpg')
        })

        assert.ok(distinct / Math.max(shared, 0.001) > 3,
            `${ROUNDS} matches of one pattern took ${shared.toFixed(1)}ms and of ${ROUNDS} different `
            + `patterns ${distinct.toFixed(1)}ms — too close for the compiled pattern to be kept`)
    })
})

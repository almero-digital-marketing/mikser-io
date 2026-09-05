import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { checksum, checksumOf, inputHashOf, inputPartsOf, diffInputParts } from '../../src/utils/index.js'

let dir
const tmp = async (name, buf) => {
    dir ??= await mkdtemp(path.join(tmpdir(), 'mikser-ck-'))
    const file = path.join(dir, name)
    await writeFile(file, buf)
    return file
}
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('checksumOf is byte-compatible with checksum', () => {
    // Load-bearing: the two must be interchangeable, or swapping a caller
    // from one to the other invalidates its whole catalog.
    const cases = [
        ['empty',          Buffer.alloc(0)],
        ['small text',     Buffer.from('hello world')],
        ['300KB minus 1',  Buffer.alloc(300 * 1024 - 1, 7)],
        ['exactly 300KB',  Buffer.alloc(300 * 1024, 7)],
        ['300KB plus 1',   Buffer.alloc(300 * 1024 + 1, 7)],
        ['1MB mixed',      Buffer.concat([Buffer.alloc(500 * 1024, 1), Buffer.alloc(524 * 1024, 2)])],
    ]
    for (const [label, buf] of cases) {
        it(`agrees on ${label}`, async () => {
            const file = await tmp(`${label.replace(/\W+/g, '-')}.bin`, buf)
            assert.equal(await checksum(file), checksumOf(buf))
        })
    }

    it('accepts a string, decoding as utf8 like the callers do', () => {
        assert.equal(checksumOf('hello world'), checksumOf(Buffer.from('hello world', 'utf8')))
    })
})

describe('the torn-read hazard', () => {
    it('empty content and full content produce DIFFERENT checksums', async () => {
        // The bug: a plugin read '' (mid-write) while checksum() read the
        // finished file. Same entity, empty body, checksum correct for the
        // final content — so every later sync short-circuits on "unchanged"
        // and the empty body is permanent. Deriving both from one buffer is
        // what makes that impossible; this pins that they cannot collide.
        const finished = Buffer.from('export default 1\n')
        assert.notEqual(checksumOf(Buffer.alloc(0)), checksumOf(finished))
    })
})

describe('the truncation hazard', () => {
    it('detects a same-length change beyond the first 300KB', async () => {
        // The previous form was `size + md5(first 300KB)`, so an edit past
        // byte 307200 that preserved the length hashed identically — the
        // sync reported "unchanged" and dropped the edit, exactly as
        // permanently as the torn read.
        const head = Buffer.alloc(400 * 1024, 1)
        const rest = Buffer.alloc(100 * 1024, 3)
        const a = Buffer.concat([head, Buffer.from('AAAA'), rest])
        const b = Buffer.concat([head, Buffer.from('BBBB'), rest])
        assert.equal(a.length, b.length, 'same length — the old form saw no difference')
        assert.notEqual(checksumOf(a), checksumOf(b))

        // Same through the file path, since large files take the ranged read.
        assert.notEqual(await checksum(await tmp('a.bin', a)), await checksum(await tmp('b.bin', b)))
    })

    it('still reads only the ends of a large file, not all of it', async () => {
        // The truncation exists so a 1.4GB video is not streamed every
        // cycle. The shape encodes that: length + two 300KB digests.
        const big = Buffer.alloc(2 * 1024 * 1024, 9)
        const value = checksumOf(big)
        const [size, head, tail] = value.split(':')
        assert.equal(Number(size), big.length)
        assert.match(head, /^[0-9a-f]{32}$/)
        assert.match(tail, /^[0-9a-f]{32}$/)
    })

    it('a small file is a bare hash, with no length prefix', () => {
        assert.match(checksumOf(Buffer.from('x')), /^[0-9a-f]{32}$/)
    })
})

describe('inputPartsOf / diffInputParts', () => {
    // The attribution behind `inputs-changed`. inputPartsOf hashes the SAME
    // payload inputHashOf does, one level deep, so the two cannot disagree
    // about what went into the hash.
    it('names meta fields individually', () => {
        const parts = inputPartsOf({ id: '/a', meta: { title: 'A', href: '/a' }, content: 'body' })
        assert.deepEqual(Object.keys(parts).sort(), ['content', 'meta.href', 'meta.title'])
    })

    it('includes checksum only when content is absent', () => {
        const file = inputPartsOf({ id: '/f', meta: { url: '/f' }, checksum: 'c1' })
        assert.ok('checksum' in file, 'a file entity is fingerprinted by its checksum')
        const doc = inputPartsOf({ id: '/d', meta: {}, content: 'body', checksum: 'c1' })
        assert.ok(!('checksum' in doc), 'content is authoritative when present')
    })

    it('omits null components rather than hashing them', () => {
        const parts = inputPartsOf({ id: '/a', content: 'body' })
        assert.deepEqual(Object.keys(parts), ['content'])
    })

    it('reports a changed field by name', () => {
        const before = inputPartsOf({ id: '/a', meta: { title: 'A' }, content: 'b' })
        const after = inputPartsOf({ id: '/a', meta: { title: 'B' }, content: 'b' })
        assert.deepEqual(diffInputParts(before, after),
            { changed: ['meta.title'], added: [], removed: [] })
    })

    it('separates added and removed from changed', () => {
        const before = inputPartsOf({ id: '/a', meta: { title: 'A', old: 1 }, content: 'b' })
        const after = inputPartsOf({ id: '/a', meta: { title: 'A', fresh: 2 }, content: 'c' })
        assert.deepEqual(diffInputParts(before, after),
            { changed: ['content'], added: ['meta.fresh'], removed: ['meta.old'] })
    })

    it('reports nothing for identical inputs', () => {
        const entity = { id: '/a', meta: { title: 'A' }, content: 'b' }
        assert.deepEqual(diffInputParts(inputPartsOf(entity), inputPartsOf({ ...entity })),
            { changed: [], added: [], removed: [] })
    })

    it('agrees with inputHashOf about what counts as a change', () => {
        // If a change moves the combined hash, the parts must attribute it;
        // if it does not, they must stay silent. Drift between the two is
        // worse than no attribution at all.
        const base = { id: '/a', meta: { title: 'A' }, content: 'b', inputs: { shared: 'x' } }
        const cases = [
            { ...base, meta: { title: 'B' } },
            { ...base, content: 'c' },
            { ...base, inputs: { shared: 'y' } },
            { ...base },
        ]
        for (const variant of cases) {
            const hashMoved = inputHashOf(base) !== inputHashOf(variant)
            const d = diffInputParts(inputPartsOf(base), inputPartsOf(variant))
            const partsMoved = d.changed.length + d.added.length + d.removed.length > 0
            assert.equal(partsMoved, hashMoved,
                `disagreement for ${JSON.stringify(variant)}`)
        }
    })
})

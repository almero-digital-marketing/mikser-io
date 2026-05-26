import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
    normalize,
    matchEntity,
    changeExtension,
    getFormatInfo,
    formatLogArgs,
    formatErrorContext,
    checksum,
    AbortError,
} from '../../src/utils.js'

// ─── normalize ──────────────────────────────────────────────────────────────

describe('normalize', () => {
    it('keeps truthy primitives', () => {
        assert.deepEqual(normalize({ a: 'x', b: 1, c: true, d: false }), { a: 'x', b: 1, c: true, d: false })
    })

    it('drops null, undefined, empty string, NaN', () => {
        assert.deepEqual(
            normalize({ a: 'x', b: null, c: undefined, d: '', e: NaN, f: 0 }),
            { a: 'x', f: 0 }
        )
    })

    it('drops entries with sentinel keys "undefined", "null", ""', () => {
        const input = { real: 1, [''.toString()]: 2, undefined: 3, null: 4 }
        assert.deepEqual(normalize(input), { real: 1 })
    })

    it('returns an empty object when everything is dropped', () => {
        assert.deepEqual(normalize({ a: null, b: undefined }), {})
    })
})

// ─── matchEntity ────────────────────────────────────────────────────────────

describe('matchEntity', () => {
    const entity = { id: '/documents/en/post.md', name: 'en/post', collection: 'documents', format: 'md' }

    it('returns false for a falsy match', () => {
        assert.equal(matchEntity(entity, null), false)
        assert.equal(matchEntity(entity, undefined), false)
        assert.equal(matchEntity(entity, ''), false)
    })

    it('matches function patterns', () => {
        assert.equal(matchEntity(entity, e => e.format === 'md'), true)
        assert.equal(matchEntity(entity, e => e.format === 'html'), false)
    })

    it('matches glob strings against entity.id', () => {
        assert.equal(matchEntity(entity, '/documents/**'), true)
        assert.equal(matchEntity(entity, '/layouts/**'), false)
    })

    it('matches "@/<glob>" strings against entity.name', () => {
        assert.equal(matchEntity(entity, '@/en/*'), true)
        assert.equal(matchEntity(entity, '@/bg/*'), false)
    })

    it('matches partial-object patterns via lodash isMatch', () => {
        assert.equal(matchEntity(entity, { collection: 'documents' }), true)
        assert.equal(matchEntity(entity, { collection: 'layouts' }), false)
        assert.equal(matchEntity(entity, { format: 'md', collection: 'documents' }), true)
    })

    it('throws for an unsupported match type', () => {
        assert.throws(() => matchEntity(entity, 42), /Invalid match type/)
    })
})

// ─── changeExtension ────────────────────────────────────────────────────────

describe('changeExtension', () => {
    it('swaps the final extension', () => {
        assert.equal(changeExtension('/out/page.html', 'md'), '/out/page.md')
        assert.equal(changeExtension('post.md', 'html'), 'post.html')
    })

    it('only touches the last extension on a multi-dot filename', () => {
        assert.equal(changeExtension('/out/page.html.gz', 'br'), '/out/page.html.br')
    })

    it('appends an extension when none is present', () => {
        // Current behavior: no extension → result has the dot appended.
        assert.equal(changeExtension('/out/page', 'html'), '/out/page.html')
    })
})

// ─── getFormatInfo ──────────────────────────────────────────────────────────

describe('getFormatInfo', () => {
    it('decodes a plain template extension (default format)', () => {
        assert.deepEqual(getFormatInfo('foo.hbs'), {
            name: 'foo',
            format: 'html',
            template: 'hbs',
            postprocessor: undefined,
        })
    })

    it('decodes a format segment', () => {
        assert.deepEqual(getFormatInfo('page.css.hbs'), {
            name: 'page',
            format: 'css',
            template: 'hbs',
            postprocessor: undefined,
        })
    })

    it('decodes a format-postprocessor pair', () => {
        assert.deepEqual(getFormatInfo('report.html-pdf.hbs'), {
            name: 'report',
            format: 'html',
            template: 'hbs',
            postprocessor: 'pdf',
        })
    })

    it('works with non-hbs renderers', () => {
        assert.deepEqual(getFormatInfo('welcome.html-mjml.liquid'), {
            name: 'welcome',
            format: 'html',
            template: 'liquid',
            postprocessor: 'mjml',
        })
    })

    it('preserves directory in the name', () => {
        assert.deepEqual(getFormatInfo('partials/header.hbs'), {
            name: 'partials/header',
            format: 'html',
            template: 'hbs',
            postprocessor: undefined,
        })
    })

    it('lowercases the template and format', () => {
        const info = getFormatInfo('page.HTML.HBS')
        assert.equal(info.template, 'hbs')
        assert.equal(info.format, 'html')
    })
})

// ─── formatLogArgs ──────────────────────────────────────────────────────────

describe('formatLogArgs', () => {
    it('joins primitive args with spaces', () => {
        assert.equal(formatLogArgs(['rendering', '/foo.md']), 'rendering /foo.md')
        assert.equal(formatLogArgs(['a', 1, true]), 'a 1 true')
    })

    it('stringifies null and undefined', () => {
        assert.equal(formatLogArgs(['x', null, undefined]), 'x null undefined')
    })

    it('JSON.stringifies plain objects', () => {
        assert.equal(formatLogArgs(['meta', { title: 'Hi' }]), 'meta {"title":"Hi"}')
    })

    it('falls back to String() on objects that throw during stringify', () => {
        const circular = {}
        circular.self = circular
        const out = formatLogArgs(['cyc', circular])
        assert.match(out, /^cyc /)
        assert.match(out, /\[object Object\]/)
    })

    it('drops the trailing Handlebars options object (has .hash)', () => {
        const hbsOpts = { hash: {}, data: {}, name: 'log', loc: {} }
        assert.equal(formatLogArgs(['rendering', '/foo.md', hbsOpts]), 'rendering /foo.md')
    })

    it('keeps a plain trailing object that does not look like Handlebars', () => {
        assert.equal(formatLogArgs(['data', { id: 1 }]), 'data {"id":1}')
    })

    it('returns an empty string for an empty arg list', () => {
        assert.equal(formatLogArgs([]), '')
    })
})

// ─── formatErrorContext ─────────────────────────────────────────────────────

describe('formatErrorContext', () => {
    const options = { workingFolder: '/project' }

    it('returns an empty string when no layout info is available', () => {
        assert.equal(formatErrorContext({}, {}, options), '')
        assert.equal(formatErrorContext(null, null, options), '')
    })

    it('uses err.layoutUri when present, relative to workingFolder', () => {
        const err = { layoutUri: '/project/layouts/post.hbs' }
        assert.equal(formatErrorContext({}, err, options), ' [layouts/post.hbs]')
    })

    it('falls back to entity.layout.uri', () => {
        const entity = { layout: { uri: '/project/layouts/page.hbs' } }
        assert.equal(formatErrorContext(entity, {}, options), ' [layouts/page.hbs]')
    })

    it('falls back to entity.layout.id if no uri', () => {
        const entity = { layout: { id: '/layouts/page.hbs' } }
        assert.equal(formatErrorContext(entity, {}, options), ' [/layouts/page.hbs]')
    })

    it('keeps the absolute path when it is outside workingFolder', () => {
        const err = { layoutUri: '/somewhere/else/layout.hbs' }
        assert.equal(formatErrorContext({}, err, options), ' [/somewhere/else/layout.hbs]')
    })

    it('appends :line when available', () => {
        const err = { layoutUri: '/project/layouts/post.hbs', line: 12 }
        assert.equal(formatErrorContext({}, err, options), ' [layouts/post.hbs:12]')
    })

    it('reads lineNumber as an alias for line', () => {
        const err = { layoutUri: '/project/layouts/post.hbs', lineNumber: 7 }
        assert.equal(formatErrorContext({}, err, options), ' [layouts/post.hbs:7]')
    })

    it('appends :line:column when both are available', () => {
        const err = { layoutUri: '/project/layouts/post.hbs', line: 12, column: 4 }
        assert.equal(formatErrorContext({}, err, options), ' [layouts/post.hbs:12:4]')
    })

    it('reads col as an alias for column', () => {
        const err = { layoutUri: '/project/layouts/post.hbs', line: 5, col: 9 }
        assert.equal(formatErrorContext({}, err, options), ' [layouts/post.hbs:5:9]')
    })

    it('tolerates an undefined options object', () => {
        const err = { layoutUri: '/anywhere/foo.hbs' }
        assert.equal(formatErrorContext({}, err, undefined), ' [/anywhere/foo.hbs]')
    })
})

// ─── checksum ───────────────────────────────────────────────────────────────

describe('checksum', () => {
    it('produces a stable hash for a small file (< 300 KB)', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-test-'))
        try {
            const file = path.join(dir, 'small.txt')
            await writeFile(file, 'hello world')
            const a = await checksum(file)
            const b = await checksum(file)
            assert.equal(a, b)
            assert.equal(typeof a, 'string')
            assert.match(a, /^[0-9a-f]{32}$/i) // raw md5 hex
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('uses size+hash format for files >= 300 KB', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-test-'))
        try {
            const file = path.join(dir, 'big.bin')
            await writeFile(file, Buffer.alloc(310 * 1024, 0x41)) // 310 KB of 'A'
            const a = await checksum(file)
            assert.match(a, /^\d+:[0-9a-f]{32}$/i) // <size>:<md5>
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('produces different hashes for different content', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-test-'))
        try {
            const a = path.join(dir, 'a.txt')
            const b = path.join(dir, 'b.txt')
            await writeFile(a, 'one')
            await writeFile(b, 'two')
            assert.notEqual(await checksum(a), await checksum(b))
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

// ─── AbortError ─────────────────────────────────────────────────────────────

describe('AbortError', () => {
    it('is an Error subclass with name="AbortError"', () => {
        const err = new AbortError('cancelled')
        assert.ok(err instanceof Error)
        assert.equal(err.name, 'AbortError')
        assert.equal(err.message, 'cancelled')
    })
})

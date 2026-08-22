import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fm from 'front-matter'

import {
    normalize,
    matchEntity,
    changeExtension,
    getFormatInfo,
    formatLogArgs,
    formatErrorContext,
    checksum,
    AbortError,
    mimeForEntity,
    isLoopback,
    loopbackOnly,
    isRefKey,
    refFilter,
    projectMeta,
    extractRefs,
    writeEntity,
    expandEntity,
    ExpandError,
    useCollection,
    readEntityContent,
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
            postprocessors: [],
            postprocessor: undefined,
        })
    })

    it('decodes a format segment', () => {
        assert.deepEqual(getFormatInfo('page.css.hbs'), {
            name: 'page',
            format: 'css',
            template: 'hbs',
            postprocessors: [],
            postprocessor: undefined,
        })
    })

    it('decodes a format-postprocessor pair', () => {
        assert.deepEqual(getFormatInfo('report.html-pdf.hbs'), {
            name: 'report',
            format: 'html',
            template: 'hbs',
            postprocessors: ['pdf'],
            postprocessor: 'pdf',
        })
    })

    it('decodes a multi-stage postprocessor chain', () => {
        // welcome.html-mjml-email.hbs → render to MJML, compile MJML
        // to HTML, then send/persist as email. Chain runs left-to-right.
        assert.deepEqual(getFormatInfo('newsletter.html-mjml-email.hbs'), {
            name: 'newsletter',
            format: 'html',
            template: 'hbs',
            postprocessors: ['mjml', 'email'],
            postprocessor: 'mjml',
        })
    })

    it('works with non-hbs renderers', () => {
        assert.deepEqual(getFormatInfo('welcome.html-mjml.liquid'), {
            name: 'welcome',
            format: 'html',
            template: 'liquid',
            postprocessors: ['mjml'],
            postprocessor: 'mjml',
        })
    })

    it('preserves directory in the name', () => {
        assert.deepEqual(getFormatInfo('partials/header.hbs'), {
            name: 'partials/header',
            format: 'html',
            template: 'hbs',
            postprocessors: [],
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

    it('uses size+head+tail format for files >= 300 KB', async () => {
        // Was `<size>:<md5 of first 300KB>`. The tail digest was added
        // because the two-part form silently missed any change beyond byte
        // 307200 that preserved the file's length — the checksum matched,
        // the sync reported "unchanged", and the edit was dropped
        // permanently. See test/unit/checksum.test.js for that case.
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-test-'))
        try {
            const file = path.join(dir, 'big.bin')
            await writeFile(file, Buffer.alloc(310 * 1024, 0x41)) // 310 KB of 'A'
            const a = await checksum(file)
            assert.match(a, /^\d+:[0-9a-f]{32}:[0-9a-f]{32}$/i) // <size>:<md5 head>:<md5 tail>
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

describe('mimeForEntity', () => {
    it('returns null for an entity without a destination', () => {
        assert.equal(mimeForEntity({}), null)
        assert.equal(mimeForEntity(null), null)
    })

    it('maps a .pdf destination to application/pdf', () => {
        assert.equal(mimeForEntity({ destination: '/en/report.pdf' }), 'application/pdf')
    })

    it('maps a .html destination to text/html with charset', () => {
        assert.match(mimeForEntity({ destination: '/index.html' }), /text\/html/)
    })

    it('maps common content-types from the extension', () => {
        assert.match(mimeForEntity({ destination: '/feed.xml' }), /application\/xml/)
        assert.match(mimeForEntity({ destination: '/feed.rss' }), /application\/rss\+xml/)
        assert.match(mimeForEntity({ destination: '/api.json' }), /application\/json/)
        assert.equal(mimeForEntity({ destination: '/logo.png' }), 'image/png')
        assert.equal(mimeForEntity({ destination: '/clip.mp4' }), 'video/mp4')
    })

    it('returns null for an unrecognized extension', () => {
        assert.equal(mimeForEntity({ destination: '/strange.bizarro' }), null)
    })

    it('is case-insensitive on the extension', () => {
        assert.equal(mimeForEntity({ destination: '/Report.PDF' }), 'application/pdf')
    })
})

describe('isLoopback', () => {
    it('recognizes IPv4 127.0.0.1', () => {
        assert.equal(isLoopback('127.0.0.1'), true)
    })

    it('recognizes the rest of 127.0.0.0/8', () => {
        assert.equal(isLoopback('127.0.0.2'), true)
        assert.equal(isLoopback('127.1.2.3'), true)
        assert.equal(isLoopback('127.255.255.254'), true)
    })

    it('recognizes IPv6 ::1', () => {
        assert.equal(isLoopback('::1'), true)
    })

    it('recognizes IPv4-mapped IPv6 loopback (::ffff:127.x.x.x)', () => {
        assert.equal(isLoopback('::ffff:127.0.0.1'), true)
        assert.equal(isLoopback('::ffff:127.1.2.3'), true)
    })

    it('rejects non-loopback IPv4 addresses', () => {
        assert.equal(isLoopback('1.2.3.4'), false)
        assert.equal(isLoopback('10.0.0.1'), false)
        assert.equal(isLoopback('192.168.1.1'), false)
        assert.equal(isLoopback('128.0.0.1'), false)   // adjacent to 127/8
    })

    it('rejects non-loopback IPv6 addresses', () => {
        assert.equal(isLoopback('::2'), false)
        assert.equal(isLoopback('fe80::1'), false)
        assert.equal(isLoopback('2001:db8::1'), false)
    })

    it('rejects malformed and falsy input', () => {
        assert.equal(isLoopback(''), false)
        assert.equal(isLoopback(null), false)
        assert.equal(isLoopback(undefined), false)
        assert.equal(isLoopback(0), false)
        assert.equal(isLoopback('not-an-ip'), false)
        assert.equal(isLoopback('127'), false)
        assert.equal(isLoopback('127.0.0'), false)
        assert.equal(isLoopback('127.0.0.1.1'), false)
    })
})

describe('loopbackOnly', () => {
    function fakeReqRes(ip) {
        const req = { ip, socket: { remoteAddress: ip } }
        const res = {
            statusCode: null,
            body: null,
            status(c) { this.statusCode = c; return this },
            json(b) { this.body = b; return this },
        }
        return { req, res }
    }

    it('calls next() for a loopback request', () => {
        const mw = loopbackOnly()
        const { req, res } = fakeReqRes('127.0.0.1')
        let nextCalled = false
        mw(req, res, () => { nextCalled = true })
        assert.equal(nextCalled, true)
        assert.equal(res.statusCode, null)
    })

    it('responds 403 for a non-loopback request', () => {
        const mw = loopbackOnly()
        const { req, res } = fakeReqRes('1.2.3.4')
        let nextCalled = false
        mw(req, res, () => { nextCalled = true })
        assert.equal(nextCalled, false)
        assert.equal(res.statusCode, 403)
        assert.ok(res.body.error)
    })

    it('honors a custom message', () => {
        const mw = loopbackOnly({ message: 'go away' })
        const { req, res } = fakeReqRes('1.2.3.4')
        mw(req, res, () => {})
        assert.equal(res.body.error, 'go away')
    })

    it('treats ::ffff:127.0.0.1 as loopback', () => {
        const mw = loopbackOnly()
        const { req, res } = fakeReqRes('::ffff:127.0.0.1')
        let nextCalled = false
        mw(req, res, () => { nextCalled = true })
        assert.equal(nextCalled, true)
    })
})

describe('isRefKey', () => {
    it('returns true for $-prefixed strings with content after', () => {
        assert.equal(isRefKey('$author'), true)
        assert.equal(isRefKey('$ogImage'), true)
        assert.equal(isRefKey('$related'), true)
    })

    it('returns false for plain keys', () => {
        assert.equal(isRefKey('author'), false)
        assert.equal(isRefKey('title'), false)
        assert.equal(isRefKey(''), false)
    })

    it('returns false for bare $ (could be a legitimate field name)', () => {
        assert.equal(isRefKey('$'), false)
    })

    it('returns false for non-strings', () => {
        assert.equal(isRefKey(null), false)
        assert.equal(isRefKey(undefined), false)
        assert.equal(isRefKey(42), false)
        assert.equal(isRefKey({}), false)
    })
})

describe('projectMeta', () => {
    it('strips $ from top-level reference keys', () => {
        assert.deepEqual(
            projectMeta({ title: 'A', $author: '/authors/dick' }),
            { title: 'A', author: '/authors/dick' },
        )
    })

    it('leaves plain keys unchanged', () => {
        assert.deepEqual(
            projectMeta({ title: 'A', tags: ['x', 'y'] }),
            { title: 'A', tags: ['x', 'y'] },
        )
    })

    it('strips $ from nested object keys', () => {
        assert.deepEqual(
            projectMeta({ seo: { $ogImage: '/images/foo', desc: 'x' } }),
            { seo: { ogImage: '/images/foo', desc: 'x' } },
        )
    })

    it('strips $ inside array elements', () => {
        assert.deepEqual(
            projectMeta({ sections: [{ $image: '/a' }, { $image: '/b' }] }),
            { sections: [{ image: '/a' }, { image: '/b' }] },
        )
    })

    it('passes string and array $-values through as-is', () => {
        assert.deepEqual(
            projectMeta({
                $author:  '/authors/dick',
                $related: ['/blog/a', '/blog/b'],
            }),
            {
                author:  '/authors/dick',
                related: ['/blog/a', '/blog/b'],
            },
        )
    })

    it('on collision, $-version wins regardless of declaration order', () => {
        assert.deepEqual(
            projectMeta({ author: 'plain', $author: '/authors/dick' }),
            { author: '/authors/dick' },
        )
        assert.deepEqual(
            projectMeta({ $author: '/authors/dick', author: 'plain' }),
            { author: '/authors/dick' },
        )
    })

    it('returns a new tree without mutating input', () => {
        const input = { $author: '/authors/dick', nested: { x: 1 } }
        const before = JSON.stringify(input)
        const output = projectMeta(input)
        assert.notEqual(input, output)
        assert.notEqual(input.nested, output.nested)
        assert.equal(JSON.stringify(input), before)
    })

    it('passes primitives through', () => {
        assert.equal(projectMeta('hi'), 'hi')
        assert.equal(projectMeta(42), 42)
        assert.equal(projectMeta(null), null)
        assert.equal(projectMeta(undefined), undefined)
        assert.equal(projectMeta(true), true)
    })

    it('handles deep nesting', () => {
        const input = {
            a: { b: { c: { $ref: '/x', $also: ['/y', '/z'], other: 1 } } },
        }
        assert.deepEqual(
            projectMeta(input),
            { a: { b: { c: { ref: '/x', also: ['/y', '/z'], other: 1 } } } },
        )
    })

    it('treats bare $ as a regular field name', () => {
        assert.deepEqual(
            projectMeta({ $: 'something' }),
            { $: 'something' },
        )
    })

    it('does not crash on empty objects or arrays', () => {
        assert.deepEqual(projectMeta({}), {})
        assert.deepEqual(projectMeta([]), [])
    })
})

describe('extractRefs', () => {
    it('finds top-level string refs', () => {
        assert.deepEqual(
            extractRefs({ $author: '/authors/dick' }),
            [{ path: '$author', ref: '/authors/dick' }],
        )
    })

    it('finds string-array refs under $-keys with index paths', () => {
        assert.deepEqual(
            extractRefs({ $related: ['/a', '/b'] }),
            [
                { path: '$related.0', ref: '/a' },
                { path: '$related.1', ref: '/b' },
            ],
        )
    })

    it('finds refs nested inside plain objects', () => {
        assert.deepEqual(
            extractRefs({ seo: { $ogImage: '/images/foo' } }),
            [{ path: 'seo.$ogImage', ref: '/images/foo' }],
        )
    })

    it('finds refs inside arrays of objects', () => {
        assert.deepEqual(
            extractRefs({
                sections: [
                    { $image: '/a', kind: 'hero' },
                    { $image: '/b', kind: 'cta'  },
                ],
            }),
            [
                { path: 'sections.0.$image', ref: '/a' },
                { path: 'sections.1.$image', ref: '/b' },
            ],
        )
    })

    it('finds multiple refs in one meta', () => {
        const refs = extractRefs({
            $author: '/authors/dick',
            $hero:   '/images/launch',
            $related: ['/blog/a', '/blog/b'],
        })
        assert.deepEqual(refs, [
            { path: '$author',    ref: '/authors/dick' },
            { path: '$hero',      ref: '/images/launch' },
            { path: '$related.0', ref: '/blog/a' },
            { path: '$related.1', ref: '/blog/b' },
        ])
    })

    it('skips $-keys whose value is not a string or string array', () => {
        assert.deepEqual(
            extractRefs({
                $broken: 42,
                $alsoBroken: { nested: 'object' },
                $good: '/authors/dick',
            }),
            [{ path: '$good', ref: '/authors/dick' }],
        )
    })

    it('skips non-string items inside $-keyed arrays', () => {
        assert.deepEqual(
            extractRefs({ $related: ['/a', 42, '/b', null] }),
            [
                { path: '$related.0', ref: '/a' },
                { path: '$related.2', ref: '/b' },
            ],
        )
    })

    it('returns empty array when no refs are present', () => {
        assert.deepEqual(extractRefs({ title: 'hi', tags: ['a', 'b'] }), [])
    })

    it('handles null and primitives at the root', () => {
        assert.deepEqual(extractRefs(null), [])
        assert.deepEqual(extractRefs(undefined), [])
        assert.deepEqual(extractRefs('string'), [])
        assert.deepEqual(extractRefs(42), [])
    })

    it('handles deeply nested mixed shapes', () => {
        const meta = {
            $author: '/authors/dick',
            seo: {
                $ogImage: '/images/og',
                tags: ['x', 'y'],
            },
            sections: [
                {
                    type: 'hero',
                    $image: '/images/hero',
                    cta: { $target: '/contact' },
                },
                {
                    type: 'gallery',
                    $images: ['/images/a', '/images/b'],
                },
            ],
        }
        assert.deepEqual(extractRefs(meta), [
            { path: '$author',                     ref: '/authors/dick' },
            { path: 'seo.$ogImage',                ref: '/images/og' },
            { path: 'sections.0.$image',           ref: '/images/hero' },
            { path: 'sections.0.cta.$target',      ref: '/contact' },
            { path: 'sections.1.$images.0',        ref: '/images/a' },
            { path: 'sections.1.$images.1',        ref: '/images/b' },
        ])
    })
})

describe('writeEntity', () => {
    let dir
    let file

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'mikser-writeEntity-'))
        file = path.join(dir, 'post.md')
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    it('patches a single meta field, preserves the others and the body', async () => {
        await writeFile(file, `---
title: Old
draft: true
---
Hello world
`, 'utf8')

        await writeEntity({ uri: file }, { title: 'New' })

        const parsed = fm(await readFile(file, 'utf8'))
        assert.equal(parsed.attributes.title, 'New')
        assert.equal(parsed.attributes.draft, true)
        // fm consumes the \n after the closing `---` as part of the
        // delimiter, so the body starts at the next character.
        assert.equal(parsed.body, 'Hello world\n')
    })

    it('writes $-keyed reference fields verbatim', async () => {
        await writeFile(file, `---
title: Article
---
Body
`, 'utf8')

        await writeEntity({ uri: file }, { $author: '/authors/dick' })

        const parsed = fm(await readFile(file, 'utf8'))
        assert.equal(parsed.attributes.$author, '/authors/dick')
        assert.equal(parsed.attributes.title, 'Article')
    })

    it('overwrites an existing $-keyed value (rename-cascade pattern)', async () => {
        await writeFile(file, `---
$author: /authors/old
title: x
---
`, 'utf8')

        await writeEntity({ uri: file }, { $author: '/authors/new' })

        const parsed = fm(await readFile(file, 'utf8'))
        assert.equal(parsed.attributes.$author, '/authors/new')
        assert.equal(parsed.attributes.title, 'x')
    })

    it('removes a key when its patch value is null', async () => {
        await writeFile(file, `---
title: x
draft: true
---
body
`, 'utf8')

        await writeEntity({ uri: file }, { draft: null })

        const parsed = fm(await readFile(file, 'utf8'))
        assert.equal(parsed.attributes.title, 'x')
        assert.equal('draft' in parsed.attributes, false)
    })

    it('preserves body verbatim across multiple lines', async () => {
        // Body as fm sees it (after the \n that follows the closing `---`).
        const body = 'Line 1\n\nLine 2\n\n  indented\n'
        await writeFile(file, `---
title: x
---
${body}`, 'utf8')

        await writeEntity({ uri: file }, { title: 'y' })

        const parsed = fm(await readFile(file, 'utf8'))
        assert.equal(parsed.body, body)
    })

    it('adds frontmatter to a file that has none', async () => {
        await writeFile(file, 'Just body content\n', 'utf8')

        await writeEntity({ uri: file }, { $author: '/authors/x' })

        const parsed = fm(await readFile(file, 'utf8'))
        assert.equal(parsed.attributes.$author, '/authors/x')
        assert.equal(parsed.body, 'Just body content\n')
    })

    it('creates the file (and any missing parent dirs) when it does not exist', async () => {
        const target = path.join(dir, 'subdir', 'nested', 'new.md')
        await writeEntity({ uri: target }, { title: 'fresh', $author: '/authors/x' })

        const parsed = fm(await readFile(target, 'utf8'))
        assert.equal(parsed.attributes.title, 'fresh')
        assert.equal(parsed.attributes.$author, '/authors/x')
    })

    it('leaves frontmatter unchanged when patch is empty', async () => {
        const original = `---
title: x
$author: /authors/dick
---
body
`
        await writeFile(file, original, 'utf8')

        await writeEntity({ uri: file }, {})

        const parsedOrig = fm(original)
        const parsedNew = fm(await readFile(file, 'utf8'))
        assert.deepEqual(parsedOrig.attributes, parsedNew.attributes)
        assert.equal(parsedOrig.body, parsedNew.body)
    })

    it('preserves a plain author alongside a $author on a targeted update', async () => {
        // Collision case — caller chose canonical $author. Plain author
        // is left intact. The schemas plugin would warn about collision
        // separately; writeEntity does its narrow job: update only what
        // was patched.
        await writeFile(file, `---
author: plain string
$author: /authors/old
title: x
---
body
`, 'utf8')

        await writeEntity({ uri: file }, { $author: '/authors/new' })

        const parsed = fm(await readFile(file, 'utf8'))
        assert.equal(parsed.attributes.author, 'plain string')
        assert.equal(parsed.attributes.$author, '/authors/new')
    })

    it('writes only the body when the patch empties the frontmatter', async () => {
        await writeFile(file, `---
title: x
---
body content
`, 'utf8')

        await writeEntity({ uri: file }, { title: null })

        const content = await readFile(file, 'utf8')
        assert.equal(fm.test(content), false)
        assert.equal(content, 'body content\n')
    })

    it('errors if entity has no uri', async () => {
        await assert.rejects(
            writeEntity({}, { title: 'x' }),
            /entity\.uri is required/,
        )
    })

    it('handles array values in the patch (multi-ref updates)', async () => {
        await writeFile(file, `---
title: x
---
body
`, 'utf8')

        await writeEntity({ uri: file }, {
            $related: ['/blog/a', '/blog/b', '/blog/c'],
        })

        const parsed = fm(await readFile(file, 'utf8'))
        assert.deepEqual(parsed.attributes.$related, ['/blog/a', '/blog/b', '/blog/c'])
    })
})

describe('expandEntity', () => {
    // Tiny in-memory catalog the tests dispatch against. Each entity has
    // an id (its ref form) and meta. findRef() looks up by id.
    function makeCatalog(entities) {
        const byId = new Map(entities.map(e => [e.id, e]))
        return async ref => byId.get(ref) ?? null
    }

    it('returns input unchanged when paths is empty or missing', async () => {
        const entity = { id: '/x', meta: { $author: '/a' } }
        const catalog = makeCatalog([{ id: '/a', meta: { name: 'A' } }])

        const r1 = await expandEntity(entity, [], { findRef: catalog })
        assert.deepEqual(r1, entity)

        const r2 = await expandEntity(entity, undefined, { findRef: catalog })
        assert.deepEqual(r2, entity)
    })

    it('expands a one-hop single ref inline', async () => {
        const entity = { id: '/blog/launch', meta: { title: 'Launch', $author: '/authors/dick' } }
        const author = { id: '/authors/dick', meta: { name: 'Dick' } }

        const result = await expandEntity(entity, ['author'], {
            findRef: makeCatalog([author]),
        })

        assert.deepEqual(result.meta.$author, author)
        assert.equal(result.meta.title, 'Launch')          // siblings preserved
    })

    it('accepts canonical ($author) and normalized (author) path forms', async () => {
        const entity = { id: '/x', meta: { $author: '/a' } }
        const author = { id: '/a', meta: { name: 'A' } }
        const catalog = makeCatalog([author])

        const r1 = await expandEntity(entity, ['$author'], { findRef: catalog })
        const r2 = await expandEntity(entity, ['author'],  { findRef: catalog })
        assert.deepEqual(r1.meta.$author, author)
        assert.deepEqual(r2.meta.$author, author)
    })

    it('expands a multi-hop chain through nested entities', async () => {
        const entity = { id: '/blog/launch', meta: { $author: '/authors/dick' } }
        const author = { id: '/authors/dick',  meta: { $organization: '/orgs/almero', name: 'Dick' } }
        const org    = { id: '/orgs/almero',   meta: { name: 'Almero' } }

        const result = await expandEntity(entity, ['author.organization'], {
            findRef: makeCatalog([author, org]),
        })

        assert.equal(result.meta.$author.meta.$organization.meta.name, 'Almero')
    })

    it('expands every element of a $-keyed string array', async () => {
        const entity = { id: '/x', meta: { $related: ['/a', '/b'] } }
        const catalog = makeCatalog([
            { id: '/a', meta: { name: 'A' } },
            { id: '/b', meta: { name: 'B' } },
        ])

        const result = await expandEntity(entity, ['related'], { findRef: catalog })

        assert.equal(result.meta.$related.length, 2)
        assert.equal(result.meta.$related[0].meta.name, 'A')
        assert.equal(result.meta.$related[1].meta.name, 'B')
    })

    it('iterates arrays through `*` segments', async () => {
        const entity = {
            id: '/x',
            meta: {
                sections: [
                    { type: 'hero',     $image: '/img/a' },
                    { type: 'gallery',  $image: '/img/b' },
                ],
            },
        }
        const catalog = makeCatalog([
            { id: '/img/a', meta: { alt: 'A' } },
            { id: '/img/b', meta: { alt: 'B' } },
        ])

        const result = await expandEntity(entity, ['sections.*.image'], { findRef: catalog })

        assert.equal(result.meta.sections[0].$image.meta.alt, 'A')
        assert.equal(result.meta.sections[1].$image.meta.alt, 'B')
    })

    it('leaves the ref as a string when the target is missing', async () => {
        const entity = { id: '/x', meta: { $author: '/authors/missing' } }
        const result = await expandEntity(entity, ['author'], {
            findRef: makeCatalog([]),
        })
        assert.equal(result.meta.$author, '/authors/missing')   // unchanged
    })

    it('leaves the ref as a string when cycle detection fires', async () => {
        // Self-cycle: /x references /a, and /a references /x.
        const root = { id: '/x', meta: { $partner: '/a' } }
        const a    = { id: '/a', meta: { $partner: '/x', name: 'A' } }

        const result = await expandEntity(root, ['partner.partner'], {
            findRef: makeCatalog([a, root]),
        })

        // First hop expanded (/x → a), second hop's partner.$partner is
        // /x which is in `seen` — left as the ref string.
        assert.equal(result.meta.$partner.meta.name, 'A')
        assert.equal(result.meta.$partner.meta.$partner, '/x')
    })

    it('does not mutate the input entity', async () => {
        const entity = { id: '/x', meta: { $author: '/a' } }
        const before = JSON.stringify(entity)
        const author = { id: '/a', meta: { name: 'A' } }

        const result = await expandEntity(entity, ['author'], {
            findRef: makeCatalog([author]),
        })

        assert.equal(JSON.stringify(entity), before)          // input untouched
        assert.notEqual(result.meta.$author, '/a')            // output expanded
    })

    it('skips silently when a path traverses a non-ref field', async () => {
        // 'title' is a plain string, not a $-keyed ref. The walker
        // doesn't error — it just doesn't expand. The api layer is the
        // right place to surface non-$ field as 422 (it has the entity
        // and can inspect schema metadata).
        const entity = { id: '/x', meta: { title: 'just a string' } }
        const result = await expandEntity(entity, ['title'], { findRef: makeCatalog([]) })
        assert.deepEqual(result.meta, { title: 'just a string' })
    })

    it('throws ExpandError when a single path exceeds maxDepth', async () => {
        const entity = { id: '/x', meta: { $a: '/a' } }
        await assert.rejects(
            expandEntity(entity, ['a.b.c.d.e.f'], { findRef: makeCatalog([]), maxDepth: 5 }),
            err => err instanceof ExpandError && err.status === 422,
        )
    })

    it('throws ExpandError when paths list exceeds maxPaths', async () => {
        const entity = { id: '/x', meta: {} }
        const tooMany = Array.from({ length: 11 }, (_, i) => `p${i}`)
        await assert.rejects(
            expandEntity(entity, tooMany, { findRef: makeCatalog([]), maxPaths: 10 }),
            err => err instanceof ExpandError && err.status === 422,
        )
    })

    it('throws ExpandError when total resolved entities exceeds maxResolved', async () => {
        // 6 refs to expand, but maxResolved is 3.
        const entity = { id: '/x', meta: { $related: ['/a', '/b', '/c', '/d', '/e', '/f'] } }
        const catalog = makeCatalog(['a', 'b', 'c', 'd', 'e', 'f'].map(n => ({
            id: `/${n}`, meta: { name: n.toUpperCase() },
        })))
        await assert.rejects(
            expandEntity(entity, ['related'], { findRef: catalog, maxResolved: 3 }),
            err => err instanceof ExpandError && err.status === 422,
        )
    })

    it('counts resolved entities across paths (cumulative cap)', async () => {
        const entity = { id: '/x', meta: { $a: '/a', $b: '/b', $c: '/c' } }
        const catalog = makeCatalog([
            { id: '/a', meta: { name: 'A' } },
            { id: '/b', meta: { name: 'B' } },
            { id: '/c', meta: { name: 'C' } },
        ])
        // Three single-ref paths; cap of 2 should trip on the third.
        await assert.rejects(
            expandEntity(entity, ['a', 'b', 'c'], { findRef: catalog, maxResolved: 2 }),
            err => err instanceof ExpandError,
        )
    })

    it('preserves the rest of the entity outside meta', async () => {
        const entity = {
            id: '/x',
            collection: 'documents',
            refId: 'documents/x.md',
            format: 'md',
            meta: { $author: '/a' },
        }
        const author = { id: '/a', meta: { name: 'A' } }
        const result = await expandEntity(entity, ['author'], { findRef: makeCatalog([author]) })

        assert.equal(result.id, '/x')
        assert.equal(result.collection, 'documents')
        assert.equal(result.refId, 'documents/x.md')
        assert.equal(result.format, 'md')
    })

    it('handles mixed nesting and array iteration in one call', async () => {
        const entity = {
            id: '/landing',
            meta: {
                $hero: '/img/hero',
                sections: [
                    { type: 'features', $image: '/img/feat-a' },
                    { type: 'cta',      $target: '/contact' },
                ],
            },
        }
        const catalog = makeCatalog([
            { id: '/img/hero',   meta: { alt: 'Hero' } },
            { id: '/img/feat-a', meta: { alt: 'Feature A' } },
            { id: '/contact',    meta: { title: 'Contact' } },
        ])
        const result = await expandEntity(
            entity,
            ['hero', 'sections.*.image', 'sections.*.target'],
            { findRef: catalog },
        )

        assert.equal(result.meta.$hero.meta.alt, 'Hero')
        assert.equal(result.meta.sections[0].$image.meta.alt, 'Feature A')
        assert.equal(result.meta.sections[1].$target.meta.title, 'Contact')
    })
})

// ─── useCollection ──────────────────────────────────────────────────────────

describe('useCollection', () => {
    async function withTempCollection(fn) {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-utils-'))
        try {
            const docsFolder = path.join(dir, 'documents')
            await mkdir(docsFolder, { recursive: true })
            const runtime = { options: { workingFolder: dir, documentsFolder: docsFolder } }
            return await fn({ runtime, dir, docsFolder })
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    }

    it('exposes name and folder on the returned binding', async () => {
        await withTempCollection(async ({ runtime, docsFolder }) => {
            const docs = useCollection(runtime, 'documents')
            assert.equal(docs.name, 'documents')
            assert.equal(docs.folder, docsFolder)
        })
    })

    it('write() creates the file and any missing parent directories', async () => {
        await withTempCollection(async ({ runtime, docsFolder }) => {
            const docs = useCollection(runtime, 'documents')
            await docs.write('en/posts/hello.md', '# Hi')
            const content = await readFile(path.join(docsFolder, 'en/posts/hello.md'), 'utf8')
            assert.equal(content, '# Hi')
        })
    })

    it('write() returns the absolute uri of the file it wrote', async () => {
        await withTempCollection(async ({ runtime, docsFolder }) => {
            const docs = useCollection(runtime, 'documents')
            const uri = await docs.write('note.md', 'x')
            assert.equal(uri, path.join(docsFolder, 'note.md'))
        })
    })

    it('write() throws "Unknown collection" when the binding\'s folder option is absent', async () => {
        const layouts = useCollection({ options: {} }, 'layouts')
        await assert.rejects(() => layouts.write('x.hbs', '...'), /Unknown collection: layouts/)
    })

    it('remove() unlinks an existing file', async () => {
        await withTempCollection(async ({ runtime, docsFolder }) => {
            const file = path.join(docsFolder, 'a.md')
            await writeFile(file, 'x')
            const docs = useCollection(runtime, 'documents')
            await docs.remove('a.md')
            await assert.rejects(() => readFile(file, 'utf8'), { code: 'ENOENT' })
        })
    })

    it('remove() throws "Unknown collection" when the binding\'s folder option is absent', async () => {
        const layouts = useCollection({ options: {} }, 'layouts')
        await assert.rejects(() => layouts.remove('x.hbs'), /Unknown collection: layouts/)
    })

    it('reading .folder throws if the collection has not been loaded yet', async () => {
        const layouts = useCollection({ options: {} }, 'layouts')
        assert.throws(() => layouts.folder, /Unknown collection: layouts/)
    })

    it('binding is lazy — useCollection() succeeds even before the folder is set', () => {
        const docs = useCollection({ options: {} }, 'documents')
        // Doesn't throw; resolution happens on actual use.
        assert.equal(docs.name, 'documents')
    })
})

// ─── readEntityContent (scheme dispatch) ────────────────────────────────────

describe('readEntityContent', () => {
    it('returns {} for null entity', async () => {
        assert.deepEqual(await readEntityContent(null), {})
        assert.deepEqual(await readEntityContent(undefined), {})
    })

    it('fast-path: entity.content already populated → no I/O, no scheme lookup', async () => {
        // Even with a scheme-shaped uri (would dispatch to an
        // uninstalled provider), pre-populated content wins.
        const result = await readEntityContent({
            content: 'pre-populated',
            uri:     'gdrive://abc123/welcome.md',
        })
        assert.deepEqual(result, { content: 'pre-populated' })
    })

    it('reports contentError when entity has no uri and no content', async () => {
        const result = await readEntityContent({ id: '/x' })
        assert.match(result.contentError, /entity has no uri/)
    })

    it('built-in filesystem read: plain local path with text extension', async () => {
        let dir
        try {
            dir = await mkdtemp(path.join(tmpdir(), 'mikser-read-content-'))
            const filePath = path.join(dir, 'hello.md')
            await writeFile(filePath, '# hello', 'utf8')
            const result = await readEntityContent({ id: '/x', uri: filePath })
            assert.deepEqual(result, { content: '# hello' })
        } finally {
            if (dir) await rm(dir, { recursive: true })
        }
    })

    it('built-in filesystem read: file:// URI strips the scheme', async () => {
        let dir
        try {
            dir = await mkdtemp(path.join(tmpdir(), 'mikser-read-content-'))
            const filePath = path.join(dir, 'page.html')
            await writeFile(filePath, '<h1>hi</h1>', 'utf8')
            const result = await readEntityContent({ id: '/x', uri: `file://${filePath}` })
            assert.deepEqual(result, { content: '<h1>hi</h1>' })
        } finally {
            if (dir) await rm(dir, { recursive: true })
        }
    })

    it('built-in filesystem read: contentSkipped for binary extension', async () => {
        const result = await readEntityContent({ id: '/x', uri: '/some/path/photo.png' })
        assert.match(result.contentSkipped, /Non-text format \(\.png\)/)
    })

    it('built-in filesystem read: contentError when file does not exist', async () => {
        const result = await readEntityContent({ id: '/x', uri: '/this/does/not/exist/yo.md' })
        assert.match(result.contentError, /ENOENT/)
    })

    it('scheme dispatch: reports contentError when provider package is not installed', async () => {
        // Use a scheme that genuinely has no companion provider package
        // installed in the workspace; the dispatch should surface the
        // package name it tried.
        const result = await readEntityContent({ id: '/x', uri: 'noatall://abc123/welcome.md' })
        assert.match(result.contentError, /Provider "noatall" not installed \(mikser-io-provider-noatall\)/)
    })

    it('scheme dispatch: reaches an installed provider end-to-end', async () => {
        // mikser-io-provider-gdrive IS installed via the workspace.
        // The provider's lifecycle plugin hasn't been initialized in
        // this test, so its read() returns "not initialized" — which
        // confirms the dispatch reached the package and called its
        // read() export, the substrate's contract.
        const result = await readEntityContent({
            id: '/x',
            uri: 'gdrive://abc123/foo.md',
            meta: { driveId: 'abc123', driveMimeType: 'text/markdown' },
        })
        assert.match(result.contentError, /gdrive: provider not initialized/)
    })
})

describe('refFilter (ADR-0011: served-path resolution)', () => {
    it('matches a reference by id, meta.href, OR meta.url', () => {
        const f = refFilter('/media/bg/clip.mp4')
        const keys = f.$or.map(c => Object.keys(c)[0])
        assert.ok(keys.includes('id'), 'matches by id')
        assert.ok(keys.includes('meta.href'), 'matches by meta.href')
        assert.ok(keys.includes('meta.url'), 'matches by meta.url (served path)')
    })

    it('the meta.url clause carries the ref verbatim — a $-ref is the served path', () => {
        const f = refFilter('/img/products/X.jpg')
        const urlClause = f.$or.find(c => 'meta.url' in c)
        assert.equal(urlClause['meta.url'], '/img/products/X.jpg')
    })

    it('keeps the extensionless-id regex fallback (ADR-0007)', () => {
        const f = refFilter('/images/hero')
        const rx = f.$or.find(c => c.id && typeof c.id === 'object' && c.id.$regex)
        assert.ok(rx, 'still resolves /images/hero → /images/hero.<ext>')
    })

    it('returns a never-match filter for a non-string ref', () => {
        assert.deepEqual(refFilter(null), { id: '__never__' })
    })
})

describe('expandEntity — $ wildcard (deep, structure-agnostic ref expansion)', () => {
    const catalog = {
        '/media/a.mp4':  { id: '/media/a.mp4', meta: { url: '/media/a.mp4', presets: { poster: '/p.jpg' } } },
        '/media/b.mp4':  { id: '/media/b.mp4', meta: { url: '/media/b.mp4' } },
        '/authors/dick': { id: '/authors/dick', meta: { name: 'Dick', $org: '/orgs/acme' } },
        '/orgs/acme':    { id: '/orgs/acme', meta: { name: 'Acme' } },
    }
    const findRef = async (ref) => catalog[ref] ?? null

    it('["$"] expands every $-ref at any structural depth, one hop', async () => {
        const entity = { id: '/doc', meta: {
            presentation: { $video: '/media/a.mp4' },
            faq: { questions: [{ $video: '/media/b.mp4' }, { text: 'no video' }] },
        } }
        const r = await expandEntity(entity, ['$'], { findRef })
        assert.equal(r.meta.presentation.$video.meta.presets.poster, '/p.jpg')
        assert.equal(r.meta.faq.questions[0].$video.id, '/media/b.mp4')
        assert.equal(r.meta.faq.questions[1].text, 'no video')   // non-ref untouched
    })

    it('["$"] is one hop — deeper graph refs stay strings', async () => {
        const entity = { id: '/doc', meta: { $author: '/authors/dick' } }
        const r = await expandEntity(entity, ['$'], { findRef })
        assert.equal(r.meta.$author.meta.name, 'Dick')
        assert.equal(r.meta.$author.meta.$org, '/orgs/acme')     // not expanded yet
    })

    it('["$.$"] walks the resolved graph one hop deeper', async () => {
        const entity = { id: '/doc', meta: { $author: '/authors/dick' } }
        const r = await expandEntity(entity, ['$.$'], { findRef })
        assert.equal(r.meta.$author.meta.name, 'Dick')
        assert.equal(r.meta.$author.meta.$org.meta.name, 'Acme')
    })

    it('composes with literal segments — `faq.$`', async () => {
        const entity = { id: '/doc', meta: { faq: { questions: [{ $video: '/media/a.mp4' }] }, $other: '/media/b.mp4' } }
        const r = await expandEntity(entity, ['faq.$'], { findRef })
        assert.equal(r.meta.faq.questions[0].$video.id, '/media/a.mp4')  // under faq → expanded
        assert.equal(r.meta.$other, '/media/b.mp4')                       // outside faq → untouched
    })

    it('respects maxResolved', async () => {
        const entity = { id: '/doc', meta: { $a: '/media/a.mp4', $b: '/media/b.mp4' } }
        await assert.rejects(expandEntity(entity, ['$'], { findRef, maxResolved: 1 }), /maxResolved/)
    })
})

describe('useSource glob pattern', () => {
    it('builds a single-extension pattern WITHOUT braces', async () => {
        // `**/*.{css}` matches nothing — minimatch does not expand a
        // one-element brace — so a source declaring one extension silently
        // imported zero files and reported the folder as empty.
        const src = await readFile(new URL('../../src/source.js', import.meta.url), 'utf8')
        assert.match(src, /extensions\.length === 1/)
        assert.match(src, /\*\*\/\*\.\$\{extensions\[0\]\}/)
    })

    it('and the brace form really does fail, which is why', async () => {
        const { globby } = await import('globby')
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-glob-'))
        try {
            await writeFile(path.join(dir, 'a.css'), 'x')
            assert.deepEqual(await globby('**/*.{css}', { cwd: dir, onlyFiles: true }), [],
                             'a one-element brace matches nothing')
            assert.deepEqual(await globby('**/*.css', { cwd: dir, onlyFiles: true }), ['a.css'])
            assert.deepEqual(await globby('**/*.{css,scss}', { cwd: dir, onlyFiles: true }), ['a.css'])
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

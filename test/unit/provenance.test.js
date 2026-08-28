import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { fieldPositions, positionsForSource, positionsByProbe, registerProvenanceFormat,
         provenanceComment, provenanceCommentsEnabled } from '../../src/provenance.js'
import runtime from '../../src/runtime.js'

// The shapes here are taken from real content, because the whole point of
// recording positions is that a caller can open the file at the line reported
// and find the thing there.

describe('fieldPositions — one parse, every leaf', () => {
    // The acceptance case: a nav item three deep in a sequence, whose label is
    // printed on every page of the site by a shared partial and appears in no
    // page's own document.
    const NAV = `items:
  - label: Начало
    href: /
  - label: Апарати
    href: /devices
  - label: Козметика
    href: /cosmetics
`

    it('places a value inside a sequence of maps, by path', () => {
        const fields = fieldPositions(NAV)
        assert.deepEqual(fields['items[2].label'], { line: 6, col: 11 })
        assert.deepEqual(fields['items[2].href'], { line: 7, col: 10 })
    })

    it('reports the position of the VALUE, not of the key', () => {
        // A caller looking at `label: Козметика` wants the column of the text.
        const { line, col } = fieldPositions(NAV)['items[2].label']
        assert.equal(NAV.split('\n')[line - 1].slice(col), 'Козметика')
    })

    it('uses the same path spelling as flattenMeta and refs_inbound', () => {
        // Three spellings of one location would be three a caller has to
        // reconcile. Indices bracket, keys dot.
        const fields = fieldPositions('columns:\n  - links:\n      - label: X\n')
        assert.ok('columns[0].links[0].label' in fields)
    })

    it('covers every leaf in one pass, nested arbitrarily', () => {
        const fields = fieldPositions(`a:\n  b:\n    - c: 1\n      d: [2, 3]\n`)
        assert.deepEqual(Object.keys(fields).sort(),
            ['a.b[0].c', 'a.b[0].d[0]', 'a.b[0].d[1]'])
    })

    it('parses JSON, because YAML is a superset of it', () => {
        // One implementation for .yml and .json rather than two that disagree.
        const fields = fieldPositions('{\n  "title": "Hello",\n  "tags": ["a", "b"]\n}')
        assert.equal(fields['title'].line, 2)
        assert.equal(fields['tags[1]'].line, 3)
    })

    it('returns nothing rather than throwing on a file it cannot parse', () => {
        // A diagnostic that crashes is worse than one that declines: the
        // caller still has the field path, which is most of the value.
        assert.deepEqual(fieldPositions('a:\n - b\n  - c: [1,\n'), {})
        assert.deepEqual(fieldPositions(''), {})
        assert.deepEqual(fieldPositions(null), {})
    })

    it('declines a document the parser only RECOVERED from', () => {
        // parseDocument repairs and returns a best guess where YAML.parse —
        // which is what produced entity.meta — would have thrown. Positions
        // from a structure the engine never loaded point confidently at the
        // wrong lines, which is worse than pointing nowhere.
        const broken = 'title: ok\n\ttabbed: not-allowed-in-yaml\n'
        assert.deepEqual(fieldPositions(broken), {})
    })

    it('does not emit a position for the document root', () => {
        assert.equal(fieldPositions('just a scalar')[''], undefined)
    })
})

describe('positionsForSource — front matter shifts the lines', () => {
    const DOC = `---
title: Контакти
layout: page
---

# Heading

Body text.
`

    it('reports lines in the WHOLE file, not within the front matter block', () => {
        // A caller opens the file at the reported line. Reporting a line
        // relative to the block sends them two lines up, silently.
        const fields = positionsForSource(DOC)
        assert.equal(fields['title'].line, 2)
        assert.equal(fields['layout'].line, 3)
        assert.equal(DOC.split('\n')[fields['title'].line - 1], 'title: Контакти')
    })

    it('handles a file with no front matter as plain yaml', () => {
        const fields = positionsForSource('title: X\n')
        assert.equal(fields['title'].line, 1)
    })

    it('places a value inside front matter arrays too', () => {
        const fields = positionsForSource('---\nnav:\n  - a\n  - b\n---\nbody\n')
        assert.equal(fields['nav[1]'].line, 4)
    })
})

describe('positionsByProbe — for a parser that reports no ranges', () => {
    // The mikser 4.x mechanism, which is the only thing that works for
    // archieml, toml, cson or anything a plugin brings later: substitute a
    // token for a value, re-parse with the format's OWN parser, and read the
    // position off wherever the token actually landed.
    //
    // A deliberately awkward stand-in parser — indentation-sensitive, no
    // ranges, nothing like YAML — so these test the mechanism rather than a
    // second path into the same library.
    const parse = (text) => {
        const out = {}
        let list = null
        for (const line of text.split('\n')) {
            if (line === '[items]') { list = out.items = []; continue }
            if (line === '[]') { list = null; continue }
            const at = line.indexOf(': ')
            if (at < 0) continue
            const [key, value] = [line.slice(0, at).trim(), line.slice(at + 2)]
            if (!list) { out[key] = value; continue }
            if (!list.length || key in list[list.length - 1]) list.push({})
            list[list.length - 1][key] = value
        }
        return out
    }

    const RAW = 'title: Контакти\n[items]\nlabel: Начало\nhref: /\nlabel: Козметика\nhref: /cosmetics\n[]\n'

    it('locates every leaf, not just the first', () => {
        // The regression this pins: substituting progressively shifts every
        // later offset by (token length - value length), so field two onwards
        // drifts. Silently, and further with each field.
        const positions = positionsByProbe(RAW, parse, parse(RAW))
        assert.deepEqual(positions, {
            'title':          { line: 1, col: 7 },
            'items[0].label': { line: 3, col: 7 },
            'items[0].href':  { line: 4, col: 6 },
            'items[1].label': { line: 5, col: 7 },
            'items[1].href':  { line: 6, col: 6 },
        })
    })

    it('every reported position actually holds the value it claims', () => {
        // The property that matters: open the file there and find the thing.
        const meta = parse(RAW)
        const positions = positionsByProbe(RAW, parse, meta)
        const lines = RAW.split('\n')
        const leaves = Object.fromEntries([
            ['title', meta.title],
            ...meta.items.flatMap((item, i) =>
                Object.entries(item).map(([k, v]) => [`items[${i}].${k}`, v])),
        ])
        for (const [path, { line, col }] of Object.entries(positions)) {
            assert.equal(lines[line - 1].slice(col), leaves[path],
                `${path} at ${line}:${col} should hold ${JSON.stringify(leaves[path])}`)
        }
    })

    it('gives two identical values two different positions', () => {
        const raw = 'a: same\nb: same\n'
        const positions = positionsByProbe(raw, parse, parse(raw))
        assert.equal(positions.a.line, 1)
        assert.equal(positions.b.line, 2)
    })

    it('declines rather than guessing when substitution breaks the parse', () => {
        const exploding = () => { throw new Error('nope') }
        assert.deepEqual(positionsByProbe(RAW, exploding, parse(RAW)), {})
    })

    it('returns nothing for input it cannot work with', () => {
        assert.deepEqual(positionsByProbe(null, parse, {}), {})
        assert.deepEqual(positionsByProbe('x', null, {}), {})
        assert.deepEqual(positionsByProbe('x', parse, null), {})
    })
})

describe('registerProvenanceFormat', () => {
    it('lets a plugin own its format, and later registrations win', () => {
        // The engine has no business knowing archieml exists; a format that
        // ships in its own package ships its provenance with it.
        const undo = registerProvenanceFormat('test-format', {
            test: (entity) => entity?.format === 'test',
            positions: () => ({ marker: { line: 42, col: 0 } }),
        })
        try {
            assert.deepEqual(positionsForSource('anything', { format: 'test' }),
                { marker: { line: 42, col: 0 } })
            // An entity it does not claim still falls through to the built-ins.
            assert.equal(positionsForSource('title: X\n', { format: 'yml' }).title.line, 1)
        } finally {
            undo()
        }
        // Unregistered again, the built-in answers.
        assert.equal(positionsForSource('title: X\n', { format: 'test' }).title.line, 1)
    })
})

describe('provenance comments — a debug view that cannot ship', () => {
    const SOURCES = [{ id: '/documents/bg/system/navigation.yml', via: ['query {"meta.href":"/system/navigation"}'] }]
    const reset = () => {
        delete runtime.options.provenanceComments
        delete runtime.options.mode
        delete process.env.NODE_ENV
    }

    it('is off unless asked for', () => {
        reset()
        assert.equal(provenanceCommentsEnabled(), false)
        assert.equal(provenanceComment(SOURCES), null)
    })

    it('refuses production even when the flag is set', () => {
        // Marker injection changes the bytes that ship, which is exactly why
        // the predecessor was only ever safe in development. An operator who
        // set this in a shared config should not find out from the shipped
        // HTML, so the refusal is mechanical rather than a convention.
        reset()
        runtime.options.provenanceComments = true
        runtime.options.mode = 'production'
        assert.equal(provenanceComment(SOURCES), null)

        runtime.options.mode = 'development'
        process.env.NODE_ENV = 'production'
        assert.equal(provenanceComment(SOURCES), null, 'NODE_ENV must veto independently')
        reset()
    })

    it('emits the recorded closure when enabled in development', () => {
        reset()
        runtime.options.provenanceComments = true
        const comment = provenanceComment(SOURCES)
        assert.match(comment, /mikser:provenance/)
        assert.match(comment, /navigation\.yml/)
        reset()
    })

    it('cannot be broken out of by a source id containing a comment close', () => {
        // `--` is illegal inside an HTML comment and a recorded query filter
        // can easily contain one. Emitting it raw would end the comment early
        // and spill the rest into the document.
        reset()
        runtime.options.provenanceComments = true
        const comment = provenanceComment([{ id: '/documents/a--b.yml', via: ['ref'] }])
        assert.doesNotMatch(comment.slice(comment.indexOf('mikser:provenance')), /--(?!>)/)
        reset()
    })

    it('says nothing when there is nothing recorded', () => {
        reset()
        runtime.options.provenanceComments = true
        assert.equal(provenanceComment([]), null)
        reset()
    })
})

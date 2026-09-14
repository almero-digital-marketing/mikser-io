// Malformed front matter must not end the run.
//
// `fm()` throws a js-yaml exception on a bad block, and nothing caught it:
// it went up through the journal loop and out of the process. One mistyped
// line in one document stopped every other document from building, and the
// stack named js-yaml and front-matter and never the file — so the author
// had to read a parser's internals to find out where to look.
//
// Hit while reproducing a Liquid report: a `destination:` written with
// single quotes inside a single-quoted YAML string, which is an easy thing
// to write and an invisible thing to debug.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { readFrontMatter } from '../../src/plugins/front-matter.js'

// The exact line that ended a build: the inner quotes close the outer string.
const BROKEN = "---\ndestination: '/{{ before (after entity.name '/') '_' }}'\n---\nbody\n"
const GOOD = "---\ntitle: Hello\nweight: 2\n---\n# Body\n"

describe('readFrontMatter', () => {
    it('returns attributes and body for a good block', () => {
        const parsed = readFrontMatter(GOOD)
        assert.deepEqual(parsed.attributes, { title: 'Hello', weight: 2 })
        assert.equal(parsed.body, '# Body\n')
    })

    it('reports a parse failure instead of throwing', () => {
        // The whole point: this used to take the process with it.
        const parsed = readFrontMatter(BROKEN)
        assert.ok(parsed.error, 'a malformed block must come back as an error, not an exception')
        assert.equal(parsed.attributes, undefined)
    })

    it('says there is nothing rather than inventing something', () => {
        assert.equal(readFrontMatter('# Just a heading\n'), null)
        assert.equal(readFrontMatter(''), null)
        assert.equal(readFrontMatter(undefined), null)
        assert.equal(readFrontMatter(Buffer.from('---\na: 1\n---\nx')), null,
            'not a string is not front matter')
    })

    it('does not treat a horizontal rule mid-document as front matter', () => {
        assert.equal(readFrontMatter('# Title\n\n---\n\nMore text.\n'), null)
    })
})

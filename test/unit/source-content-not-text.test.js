// `content: true` on a collection of binaries.
//
// The default is right for the CSS and template parts useSource was built
// for, and the option's own comment already says content is overridable
// "for a collection that only needs to be known". What it did not do is
// say anything when the bytes were not text: `toString('utf8')` never
// fails, it substitutes U+FFFD and hands back a string.
//
// Reported by a consumer wiring PDF extraction: the mangled string went
// out as a model prompt and came back "Your input exceeds the context
// window of this model" — an error naming the document, which sends the
// reader to the PDF rather than to the one line of config that caused it.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { warnIfNotText } from '../../src/source.js'

const PDF = Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
])
const CSS = Buffer.from('.a { color: red }\n')
const UTF8 = Buffer.from('# Заглавие\n\nБългарски текст.\n')

function recorder() {
    const warnings = []
    return { warnings, logger: { warn: (...args) => warnings.push(args) } }
}

describe('a content: true source carrying binaries', () => {
    it('warns, naming the collection and a sample file', () => {
        const { warnings, logger } = recorder()
        assert.equal(warnIfNotText('reports-a', 'skincheck/8501054473.pdf', PDF, logger), true)
        assert.equal(warnings.length, 1)
        const [fields, message] = warnings[0]
        assert.equal(fields.code, 'source-content-not-text')
        assert.equal(fields.collection, 'reports-a')
        assert.equal(fields.sample, 'skincheck/8501054473.pdf')
        assert.match(message, /content: false/, 'names the setting that fixes it')
        assert.match(message, /entity\.uri/, 'says the files are still reachable')
    })

    it('says it once per collection, not once per file', () => {
        // A media folder catalogued this way is ALL binaries. One warning per
        // file is how a warning becomes noise and gets filtered.
        const { warnings, logger } = recorder()
        assert.equal(warnIfNotText('reports-b', 'one.pdf', PDF, logger), true)
        assert.equal(warnIfNotText('reports-b', 'two.pdf', PDF, logger), false)
        assert.equal(warnIfNotText('reports-b', 'three.pdf', PDF, logger), false)
        assert.equal(warnings.length, 1)
    })

    it('stays out of the way of the collections this option is for', () => {
        const { warnings, logger } = recorder()
        assert.equal(warnIfNotText('parts-a', 'button.css', CSS, logger), false)
        assert.equal(warnings.length, 0)
    })

    it('does not mistake non-ASCII text for binary', () => {
        // The site content here is Bulgarian. Flagging every Cyrillic file
        // would make the warning worse than useless.
        const { warnings, logger } = recorder()
        assert.equal(warnIfNotText('docs-a', 'за-нас.md', UTF8, logger), false)
        assert.equal(warnings.length, 0)
    })

    it('a different collection still gets its own warning', () => {
        const { warnings, logger } = recorder()
        warnIfNotText('reports-c', 'one.pdf', PDF, logger)
        assert.equal(warnIfNotText('reports-d', 'other.pdf', PDF, logger), true)
        assert.equal(warnings.length, 2)
    })
})

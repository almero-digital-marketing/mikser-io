// `threads` end to end: the flag, the config key, and which one wins.
//
// It sizes the inline render dispatcher, the inline postprocess dispatcher
// and both worker pools, and until now it was 4 with no way to say otherwise:
// `setup()` read it from an argument `app.js` never passes. A site worked
// around it by assigning `options.threads` inside its config factory, which
// reached the inline dispatcher (it re-reads the value every cycle) and not
// the pools (built before the config loads).
//
// The startup line is what a reader has to go on, so it is what is asserted —
// including the source, because "why is it 4" and "why is it 12" are the same
// question and the number alone answers neither.

import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupFixture, runMikser, cleanup, freshWorkdir } from './_harness.js'

const config = (body = '') => `
import { documents, frontMatter, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'
export default {
${body}
    plugins: [documents(), frontMatter(), layouts({ autoLayouts: true }), renderHbs()],
}
`
const width = (combined) => {
    const line = combined.split('\n').find(l => l.includes('Render width:'))
    return line ? line.slice(line.indexOf('Render width:')).trim() : '(no line)'
}

describe('the render width', () => {
    const workdir = freshWorkdir('threads')
    const build = async (args, body) => {
        if (body !== undefined) await writeFile(path.join(workdir, 'mikser.config.js'), config(body))
        const { code, combined } = await runMikser(workdir, args)
        assert.equal(code, 0, combined)
        return { combined, reported: width(combined) }
    }

    before(async () => {
        await setupFixture(workdir, {
            'mikser.config.js': config(),
            'layouts/page.hbs': '<p>{{document.meta.title}}</p>',
            'documents/a.md': '---\nlayout: page\ntitle: A\n---\n',
        })
    })
    after(async () => { await cleanup(workdir) })

    it('says what it is, once, on an ordinary build', async () => {
        // Without a line, a 24-core container rendering four at a time is
        // indistinguishable from a slow site.
        const { combined, reported } = await build()
        assert.match(reported, /^Render width: 4 at once \(default\)/)
        assert.equal(combined.split('\n').filter(l => l.includes('Render width:')).length, 1,
            'said more than once')
    })

    it('takes --threads', async () => {
        assert.match((await build(['--threads', '6'])).reported, /^Render width: 6 at once \(cli\)/)
    })

    it('takes a `threads` key in the config', async () => {
        assert.match((await build([], '    threads: 9,')).reported,
            /^Render width: 9 at once \(config\)/)
    })

    it('puts --threads over the config key', async () => {
        assert.match((await build(['--threads', '2'], '    threads: 9,')).reported,
            /^Render width: 2 at once \(cli\)/)
    })

    it('reads --threads 4 as asked-for, not as the default', async () => {
        assert.match((await build(['--threads', '4'], '    threads: 9,')).reported,
            /^Render width: 4 at once \(cli\)/)
    })

    it('refuses a width that is not a positive whole number, instead of building', async () => {
        // A build that quietly renders one at a time — or hands p-map a 0 —
        // is worse than one that will not start.
        const { code, combined } = await runMikser(workdir, ['--threads', '0'])
        assert.notEqual(code, 0, 'built anyway')
        assert.match(combined, /--threads must be a positive whole number/)
    })

    it('still builds the site at a width it accepts', async () => {
        // The point of the number is the work it sizes; a flag that is read
        // and then changes nothing about the build would pass every test above.
        await writeFile(path.join(workdir, 'mikser.config.js'), config())
        const { code, combined } = await runMikser(workdir, ['--threads', '3', '--force'])
        assert.equal(code, 0, combined)
        assert.match(combined, /Rendered: [1-9]/)
    })
})

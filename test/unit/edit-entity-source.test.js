// Editing a file by naming the text to change.
//
// The tool this replaces takes the WHOLE file. To change one line of a long
// document a model must re-emit every other line, and a line it quietly drops
// on the way is indistinguishable, downstream, from a line someone deleted on
// purpose. `ifChecksum` catches a stale READ. Nothing catches a lossy WRITE.
//
// So the property under test is not "the edit worked" — it is that the bytes
// outside the match are not merely equal but never rewritten, and that the
// three ways an anchor can be wrong all stop rather than write something.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import { editEntitySource } from '../../src/write.js'
import { withPrincipal } from '../../src/principal.js'
import { registerSourceFormat } from '../../src/utils/index.js'

let dir, priorOptions
const documents = () => path.join(dir, 'documents')
const seed = (name, text) => writeFile(path.join(documents(), name), text)
const read = (name) => readFile(path.join(documents(), name), 'utf8')
const edit = (options) => editEntitySource({ collection: 'documents', ...options })

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-edit-'))
    await mkdir(path.join(dir, 'documents'), { recursive: true })
    priorOptions = runtime.options
    runtime.options = {
        ...runtime.options,
        workingFolder: dir,
        documentsFolder: path.join(dir, 'documents'),
    }
})
afterEach(async () => {
    runtime.options = priorOptions
    await rm(dir, { recursive: true, force: true })
})

describe('what it changes', () => {
    it('changes the named text and nothing else', async () => {
        await seed('page.md', '---\ntitle: Old\nweight: 3\n---\n\nBody stays.\n')
        const result = await edit({ relativePath: 'page.md', find: 'title: Old', replace: 'title: New' })
        assert.equal(result.ok, true)
        assert.equal(await read('page.md'), '---\ntitle: New\nweight: 3\n---\n\nBody stays.\n')
    })

    it('leaves every byte it did not match, to the byte', async () => {
        // The whole point. Trailing spaces, CRLF, a tab, no final newline —
        // all the things a regenerated file loses without anyone noticing.
        const original = '---\r\nkeep: "  padded  "\r\n---\r\n\ttabbed\nprice: 10'
        await seed('odd.md', original)
        await edit({ relativePath: 'odd.md', find: 'price: 10', replace: 'price: 12' })
        assert.equal(await read('odd.md'), original.replace('price: 10', 'price: 12'))
    })

    it('deletes when the replacement is empty', async () => {
        await seed('page.md', '---\ntitle: T\ndraft: true\n---\n')
        const result = await edit({ relativePath: 'page.md', find: 'draft: true\n' })
        assert.equal(result.ok, true)
        assert.equal(await read('page.md'), '---\ntitle: T\n---\n')
    })

    it('reports how many it replaced', async () => {
        await seed('page.md', 'a\nb\na\n')
        assert.equal((await edit({ relativePath: 'page.md', find: 'a', replace: 'z', all: true })).replacements, 2)
        assert.equal(await read('page.md'), 'z\nb\nz\n')
    })

    it('does not compound when the replacement contains the anchor', async () => {
        // A replacement that contains its own anchor must be applied to the
        // ORIGINAL text, once per match there — not fed back in.
        await seed('page.md', 'x\ny\nx\n')
        assert.equal((await edit({ relativePath: 'page.md', find: 'x', replace: 'xx', all: true })).replacements, 2)
        assert.equal(await read('page.md'), 'xx\ny\nxx\n')
    })

    it('replaces only the first when `all` is not asked for and it is unique', async () => {
        await seed('page.md', 'one two one')
        assert.equal((await edit({ relativePath: 'page.md', find: 'two', replace: 'TWO' })).replacements, 1)
        assert.equal(await read('page.md'), 'one TWO one')
    })
})

describe('what it refuses', () => {
    it('refuses an anchor that is not there, and writes nothing', async () => {
        await seed('page.md', 'title: A\n')
        const result = await edit({ relativePath: 'page.md', find: 'title: B', replace: 'title: C' })
        assert.equal(result.ok, false)
        assert.equal(result.refused, 'anchor-not-found')
        assert.equal(await read('page.md'), 'title: A\n')
    })

    it('refuses an ambiguous anchor and says how many', async () => {
        await seed('page.md', 'name: x\nname: x\nname: x\n')
        const result = await edit({ relativePath: 'page.md', find: 'name: x', replace: 'name: y' })
        assert.equal(result.refused, 'anchor-ambiguous')
        assert.equal(result.occurrences, 3)
        assert.equal(await read('page.md'), 'name: x\nname: x\nname: x\n', 'and touches nothing')
    })

    it('refuses a result that would not parse, before it lands', async () => {
        // The guarantee a whole-file write cannot make.
        await seed('data.yml', 'title: Fine\nitems:\n  - one\n')
        const result = await edit({ relativePath: 'data.yml', find: '  - one', replace: '  - "unterminated' })
        assert.equal(result.refused, 'would-not-parse')
        assert.equal(await read('data.yml'), 'title: Fine\nitems:\n  - one\n')
    })

    it('catches a broken front-matter block too, not only a .yml file', async () => {
        // The common case: a document, not a data file. The check is the
        // format registry's, so every registered format gets it.
        await seed('page.md', '---\ntitle: Fine\n---\n\nBody.\n')
        const result = await edit({
            relativePath: 'page.md', find: 'title: Fine', replace: 'title: "unterminated',
        })
        assert.equal(result.refused, 'would-not-parse')
        assert.equal(await read('page.md'), '---\ntitle: Fine\n---\n\nBody.\n')
    })

    it('says nothing about a format with no parser, rather than refusing it', async () => {
        // A .css file has no source format that validates. Silence there must
        // mean "allowed", not "unknown, so no".
        await seed('site.css', '.btn { color: red; }\n')
        const result = await edit({ relativePath: 'site.css', find: 'red', replace: 'blue' })
        assert.equal(result.ok, true)
        assert.equal(await read('site.css'), '.btn { color: blue; }\n')
    })

    it('refuses an empty anchor rather than matching everywhere', async () => {
        await seed('page.md', 'x')
        assert.equal((await edit({ relativePath: 'page.md', find: '', replace: 'y' })).refused, 'no-anchor')
        assert.equal((await edit({ relativePath: 'page.md', replace: 'y' })).refused, 'no-anchor')
        assert.equal(await read('page.md'), 'x')
    })

    it('refuses a file that is not there rather than creating one', async () => {
        // An edit is a change to something. Creating from an anchor that
        // matched nothing would be a whole-file write wearing a disguise.
        assert.equal((await edit({ relativePath: 'nope.md', find: 'a', replace: 'b' })).refused, 'no-such-file')
    })

    it('refuses a path that escapes the collection without reading it', async () => {
        const result = await edit({ relativePath: '../../etc/passwd', find: 'root', replace: 'x' })
        assert.equal(result.refused, 'invalid-target')
        assert.equal(result.currentChecksum, undefined, 'and reports nothing about it')
    })

    it('refuses a stale read', async () => {
        await seed('page.md', 'a\n')
        const result = await edit({ relativePath: 'page.md', find: 'a', replace: 'b', ifChecksum: 'stale' })
        assert.equal(result.refused, 'checksum-mismatch')
        assert.equal(await read('page.md'), 'a\n')
    })

    it('refuses without both halves of a target', async () => {
        assert.equal((await editEntitySource({ relativePath: 'page.md', find: 'a' })).refused, 'incomplete-target')
    })
})

describe('the capability gate is the one every write goes through', () => {
    it('refuses a principal that does not hold write on the collection', async () => {
        await seed('page.md', 'a\n')
        runtime.options = { ...runtime.options, roles: { catalogue: { editors: ['write:layouts'] } } }
        await assert.rejects(
            () => withPrincipal({ subject: 'u', capabilities: ['write:layouts'] },
                () => edit({ relativePath: 'page.md', find: 'a', replace: 'b' })),
            /needs write:documents/)
        assert.equal(await read('page.md'), 'a\n')
    })
})

describe('the window between the read and the write', () => {
    // `editEntitySource` reads the file, works out the new text, and only then
    // writes. Someone else writing in that gap would be silently overwritten,
    // so it forwards the checksum it read as the write's precondition. There
    // is no way to observe that from the outside except to BE the other
    // writer, which is what this does: a format handler whose validate step
    // runs inside the gap and writes.
    it('refuses rather than overwriting someone who wrote inside it', async () => {
        const file = path.join(documents(), 'race.yml')
        let intruded = false
        const unregister = registerSourceFormat('test-intruder', {
            test: (entity) => String(entity?.uri ?? '').endsWith('race.yml'),
            write: ({ raw }) => raw,
            validate() {
                if (!intruded) {
                    intruded = true
                    writeFileSync(file, 'title: Someone else got here first\n')
                }
                return null
            },
        })
        try {
            await seed('race.yml', 'title: Mine\n')
            const result = await edit({ relativePath: 'race.yml', find: 'Mine', replace: 'Changed' })
            assert.equal(intruded, true, 'the intruder must actually have run inside the window')
            assert.equal(result.ok, false)
            assert.equal(result.refused, 'checksum-mismatch')
            assert.equal(await read('race.yml'), 'title: Someone else got here first\n',
                'their write stands; ours never landed')
        } finally {
            unregister()
        }
    })
})

describe('dry run', () => {
    it('checks the anchor and still writes nothing', async () => {
        await seed('page.md', 'a\n')
        const preview = await edit({ relativePath: 'page.md', find: 'a', replace: 'b', dryRun: true })
        assert.equal(preview.ok, true)
        assert.equal(preview.dryRun, true)
        assert.equal(await read('page.md'), 'a\n')
        assert.equal((await edit({ relativePath: 'page.md', find: 'zz', replace: 'b', dryRun: true })).refused,
            'anchor-not-found', 'and a dry run of a bad anchor still says so')
    })
})

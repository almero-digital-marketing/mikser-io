// writeEntitySource — the guarded whole-file write.
//
// The write is the easy part. These cover what surrounds it: containment,
// the checksum precondition, advisories, sibling collisions, and the dry run.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import {
    writeEntitySource, deleteEntitySource, contentAdvisories, advisoryWarning, siblingDestinations,
} from '../../src/write.js'
import { checksum } from '../../src/utils/index.js'

let root, docs

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mikser-write-'))
    docs = path.join(root, 'documents')
    await mkdir(docs, { recursive: true })
    runtime.options = { ...runtime.options, documentsFolder: docs }
    runtime.catalog = { byId: new Map() }
    runtime.manifest = undefined
})
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('containment', () => {
    it('refuses a path that escapes the collection folder', async () => {
        // A relative path from a form or a request body must not become an
        // arbitrary-write primitive.
        //
        // The target is named per-run: `documents/../../x` lands in the
        // system temp dir, which every other run shares, so a fixed name
        // would pass or fail on whatever a previous run left behind.
        const target = `escaped-${path.basename(root)}.md`
        const result = await writeEntitySource({
            collection: 'documents', relativePath: `../../${target}`, content: 'nope',
        })
        assert.equal(result.ok, false)
        assert.equal(result.refused, 'invalid-target')
        await assert.rejects(() => stat(path.join(root, '..', target)),
            'nothing may be written outside the collection')
    })

    it('refuses an absolute path', async () => {
        const result = await writeEntitySource({
            collection: 'documents', relativePath: '/etc/mikser-test.md', content: 'nope',
        })
        assert.equal(result.ok, false)
        assert.equal(result.refused, 'invalid-target')
    })

    it('allows a path that walks up but lands inside', async () => {
        // Rejecting a literal '..' would break this, which is legitimate.
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'blog/../about.md', content: 'fine\n',
        })
        assert.equal(result.ok, true)
        assert.equal(await readFile(path.join(docs, 'about.md'), 'utf8'), 'fine\n')
    })

    it('reports nothing about a file it refused to address', async () => {
        // A checksum for an out-of-tree path is a disclosure on its own, so
        // the refusal must come before anything stats it.
        const result = await writeEntitySource({
            collection: 'documents', relativePath: '../../../../etc/passwd', dryRun: true,
        })
        assert.equal(result.ok, false)
        assert.equal(result.currentChecksum, undefined)
    })
})

describe('the checksum precondition', () => {
    it('writes when the precondition holds', async () => {
        await writeFile(path.join(docs, 'a.md'), 'one\n')
        const before = await checksum(path.join(docs, 'a.md'))
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'a.md', content: 'two\n', ifChecksum: before,
        })
        assert.equal(result.ok, true)
        assert.equal(await readFile(path.join(docs, 'a.md'), 'utf8'), 'two\n')
        assert.notEqual(result.checksum, before, 'and reports the checksum to pass next time')
    })

    it('refuses when the file moved underneath, without writing', async () => {
        await writeFile(path.join(docs, 'a.md'), 'edited by someone else\n')
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'a.md', content: 'my whole-file rewrite\n',
            ifChecksum: 'a-checksum-from-before',
        })
        assert.equal(result.ok, false)
        assert.equal(result.refused, 'checksum-mismatch')
        assert.equal(await readFile(path.join(docs, 'a.md'), 'utf8'), 'edited by someone else\n',
            'the other edit must survive')
        assert.ok(result.currentChecksum, 'and the caller gets the value to retry with')
    })

    it('says so when the precondition names a file that is not there', async () => {
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'ghost.md', content: 'x', ifChecksum: 'anything',
        })
        assert.equal(result.refused, 'checksum-mismatch')
        assert.match(result.hint, /does not exist/)
    })

    it('writes unconditionally when no precondition is given', async () => {
        await writeFile(path.join(docs, 'a.md'), 'old\n')
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'a.md', content: 'new\n',
        })
        assert.equal(result.ok, true)
        assert.equal(await readFile(path.join(docs, 'a.md'), 'utf8'), 'new\n')
    })
})

describe('advisories', () => {
    it('names a file governed by an external spec', () => {
        const found = contentAdvisories(null, '/* Spec source: buttons.pdf — match exactly. */\n.btn{}')
        assert.equal(found[0].kind, 'spec-locked')
        // The capture runs to end of line, so a trailing comment delimiter
        // rides along in `detail`. Cosmetic in a warning a human reads, and
        // asserted as-is rather than quietly trimmed here.
        assert.match(found[0].detail, /buttons\.pdf/)
        assert.equal(found[0].line, 1)
        assert.match(advisoryWarning(found), /SPEC-LOCKED/)
    })

    it('names a generated file', () => {
        const found = contentAdvisories(null, '// Generated by: the build\nx')
        assert.equal(found[0].kind, 'generated')
        assert.match(advisoryWarning(found), /edit its source instead/)
    })

    it('takes explicit meta over a header', () => {
        const found = contentAdvisories({ meta: { generated: 'the schemas plugin' } }, 'plain text')
        assert.equal(found[0].via, 'meta.generated')
    })

    it('warns on the way OUT, for a caller that never read the file', async () => {
        await writeFile(path.join(docs, 'gen.md'), '<!-- Do not edit: built from data -->\nbody\n')
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'gen.md', content: 'clobbered\n',
        })
        assert.equal(result.ok, true)
        assert.equal(result.advisories[0].kind, 'generated')
        assert.match(result.warning, /GENERATED/)
    })

    it('reads the advisory from a format no extension list would have listed', async () => {
        // The header scan goes through readEntityContent, which decides text
        // by reading the bytes — so a .njk carries an advisory like a .md.
        await writeFile(path.join(docs, 'gen.njk'), '{# Generated by: a script #}\n')
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'gen.njk', content: 'x', dryRun: true,
        })
        assert.equal(result.advisories[0]?.kind, 'generated')
    })
})

describe('siblings that could collide', () => {
    it('reports a file differing only by extension', async () => {
        await writeFile(path.join(docs, 'index.yml'), 'title: real\n')
        const found = await siblingDestinations(docs, 'index.md')
        assert.deepEqual(found.map(s => s.path), ['index.yml'])
    })

    it('does not report the file itself', async () => {
        await writeFile(path.join(docs, 'index.md'), 'x')
        assert.deepEqual(await siblingDestinations(docs, 'index.md'), [])
    })
})

describe('dry run', () => {
    it('writes nothing', async () => {
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'new.md', content: 'x', dryRun: true,
        })
        assert.equal(result.ok, true)
        assert.equal(result.dryRun, true)
        await assert.rejects(() => stat(path.join(docs, 'new.md')))
    })

    it('says plainly when there is no blast radius to report', async () => {
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'new.md', content: 'x', dryRun: true,
        })
        assert.equal(result.exists, false)
        assert.deepEqual(result.wouldAffect, [])
        assert.match(result.note, /not in the catalog yet/)
    })

    it('reports the destinations a change would re-render', async () => {
        await writeFile(path.join(docs, 'a.md'), 'body\n')
        const entity = { id: '/documents/a.md', collection: 'documents', uri: path.join(docs, 'a.md'), meta: {} }
        runtime.catalog = { byId: new Map([[entity.id, entity]]) }
        runtime.manifest = {
            affectedBy: () => [{ id: '/documents/a.md', destination: '/a.html', reason: 'inputs-changed' }],
            collisions: () => [{ destination: '/a.html', ids: ['/documents/a.md', '/documents/a.yml'] }],
        }
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'a.md', content: 'new\n', dryRun: true,
        })
        assert.equal(result.wouldAffectCount, 1)
        assert.deepEqual(result.collisionsAtAffected.map(c => c.destination), ['/a.html'],
            'a collision already standing where this write lands is the reason to look before writing')
    })
})

describe('addressing', () => {
    it('refuses an id it cannot resolve rather than throwing', async () => {
        const result = await writeEntitySource({ id: '/documents/nope.md', content: 'x' })
        assert.equal(result.ok, false)
        assert.equal(result.refused, 'unresolvable-id')
    })

    it('refuses a target with neither an id nor a path', async () => {
        const result = await writeEntitySource({ content: 'x' })
        assert.equal(result.refused, 'incomplete-target')
    })

    it('refuses an id whose collection disagrees with the one passed', async () => {
        const entity = { id: '/documents/a.md', collection: 'documents', uri: path.join(docs, 'a.md') }
        runtime.catalog = { byId: new Map([[entity.id, entity]]) }
        const result = await writeEntitySource({ id: '/documents/a.md', collection: 'layouts', content: 'x' })
        assert.equal(result.refused, 'collection-mismatch')
    })
})

describe('deleting a source file', () => {
    it('refuses a path that escapes the collection', async () => {
        const target = `escaped-del-${path.basename(root)}.md`
        const result = await deleteEntitySource({
            collection: 'documents', relativePath: `../../${target}`,
        })
        assert.equal(result.ok, false)
        assert.equal(result.refused, 'invalid-target')
    })

    it('says so rather than throwing when there is nothing there', async () => {
        const result = await deleteEntitySource({ collection: 'documents', relativePath: 'ghost.md' })
        assert.equal(result.refused, 'not-found')
    })

    it('refuses when the file changed since it was read', async () => {
        // Someone edited what you are about to remove. That is the moment to
        // stop, not to proceed because the path still matches.
        await writeFile(path.join(docs, 'a.md'), 'edited by someone else\n')
        const result = await deleteEntitySource({
            collection: 'documents', relativePath: 'a.md', ifChecksum: 'a-stale-value',
        })
        assert.equal(result.refused, 'checksum-mismatch')
        assert.equal(await readFile(path.join(docs, 'a.md'), 'utf8'), 'edited by someone else\n')
    })

    it('deletes when the precondition holds', async () => {
        await writeFile(path.join(docs, 'a.md'), 'bye\n')
        const before = await checksum(path.join(docs, 'a.md'))
        const result = await deleteEntitySource({
            collection: 'documents', relativePath: 'a.md', ifChecksum: before,
        })
        assert.equal(result.ok, true)
        await assert.rejects(() => stat(path.join(docs, 'a.md')))
    })

    it('a dry run deletes nothing', async () => {
        await writeFile(path.join(docs, 'a.md'), 'still here\n')
        const result = await deleteEntitySource({
            collection: 'documents', relativePath: 'a.md', dryRun: true,
        })
        assert.equal(result.ok, true)
        assert.equal(result.dryRun, true)
        assert.equal(await readFile(path.join(docs, 'a.md'), 'utf8'), 'still here\n')
    })

    it('names what would be left pointing at nothing', async () => {
        // The check a delete needs and a write does not: removing an entity
        // other documents reference breaks them, and the path alone cannot
        // show that.
        await writeFile(path.join(docs, 'hero.jpg.md'), 'x\n')
        const target = { id: '/documents/hero.jpg.md', uri: path.join(docs, 'hero.jpg.md'),
                         collection: 'documents', meta: { url: '/img/hero.jpg' } }
        runtime.catalog = { byId: new Map([[target.id, target]]) }
        runtime.refs = {
            inboundFor: (key) => (key === '/img/hero.jpg'
                ? [{ id: '/documents/page.md', field: 'hero', kind: 'ref' }]
                : []),
        }
        const result = await deleteEntitySource({
            collection: 'documents', relativePath: 'hero.jpg.md', dryRun: true,
        })
        assert.deepEqual(result.referencedBy.map(r => r.id), ['/documents/page.md'],
            'found through meta.url, not only through the id')
        assert.match(result.warning, /reference this/)
        runtime.refs = undefined
    })

    it('records the delete in a change set', async () => {
        await writeFile(path.join(docs, 'gone.md'), 'x\n')
        const result = await deleteEntitySource({
            collection: 'documents', relativePath: 'gone.md',
            changeSet: 'req-del', summary: 'Remove the old promo',
        })
        assert.equal(result.ok, true)
        assert.equal(result.changeSet, 'req-del')
    })

    it('records nothing when the delete was refused', async () => {
        const result = await deleteEntitySource({
            collection: 'documents', relativePath: 'never-existed.md', changeSet: 'req-x',
        })
        assert.equal(result.ok, false)
        assert.equal(result.changeSet, undefined)
    })
})

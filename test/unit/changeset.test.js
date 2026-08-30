// Change sets: which writes belong together, and who asked for them.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import {
    recordChangeSetWrite, pendingChangeSets, clearChangeSets, forgetAllChangeSets,
} from '../../src/changeset.js'
import { writeEntitySource } from '../../src/write.js'

let root, docs

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mikser-cs-'))
    docs = path.join(root, 'documents')
    await mkdir(docs, { recursive: true })
    runtime.options = { ...runtime.options, workingFolder: root, documentsFolder: docs }
    runtime.catalog = { byId: new Map() }
    forgetAllChangeSets()
})
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('recording', () => {
    it('accumulates several writes under one set', () => {
        recordChangeSetWrite({ changeSet: 'a', summary: 'Update the devices page', uri: path.join(docs, 'x.md') })
        recordChangeSetWrite({ changeSet: 'a', uri: path.join(docs, 'y.md') })
        const [set] = pendingChangeSets()
        assert.equal(set.id, 'a')
        assert.equal(set.summary, 'Update the devices page')
        assert.deepEqual(set.paths.sort(), ['documents/x.md', 'documents/y.md'])
    })

    it('reports paths relative to the working folder, POSIX-separated', () => {
        // These become a git pathspec; an absolute path matches nothing.
        recordChangeSetWrite({ changeSet: 'a', uri: path.join(docs, 'deep', 'z.md') })
        assert.deepEqual(pendingChangeSets()[0].paths, ['documents/deep/z.md'])
    })

    it('keeps the first summary rather than the last write\'s', () => {
        recordChangeSetWrite({ changeSet: 'a', summary: 'the request', uri: path.join(docs, 'x.md') })
        recordChangeSetWrite({ changeSet: 'a', summary: 'a later write', uri: path.join(docs, 'y.md') })
        assert.equal(pendingChangeSets()[0].summary, 'the request')
    })

    it('dedupes a file written twice', () => {
        recordChangeSetWrite({ changeSet: 'a', uri: path.join(docs, 'x.md') })
        recordChangeSetWrite({ changeSet: 'a', uri: path.join(docs, 'x.md') })
        assert.deepEqual(pendingChangeSets()[0].paths, ['documents/x.md'])
    })

    it('ignores a path outside the working folder', () => {
        // A pathspec built from it would match nothing, and keeping it would
        // put an absolute path into a commit scope.
        assert.equal(recordChangeSetWrite({ changeSet: 'a', uri: '/etc/passwd' }), null)
        assert.deepEqual(pendingChangeSets(), [])
    })

    it('ignores a write with no change set — unclaimed stays unclaimed', () => {
        assert.equal(recordChangeSetWrite({ uri: path.join(docs, 'x.md') }), null)
        assert.deepEqual(pendingChangeSets(), [])
    })

    it('orders sets oldest first, so history reads the way work happened', () => {
        recordChangeSetWrite({ changeSet: 'first', uri: path.join(docs, 'a.md') })
        recordChangeSetWrite({ changeSet: 'second', uri: path.join(docs, 'b.md') })
        assert.deepEqual(pendingChangeSets().map(s => s.id), ['first', 'second'])
    })

    it('drops only the sets a consumer dealt with', () => {
        recordChangeSetWrite({ changeSet: 'a', uri: path.join(docs, 'a.md') })
        recordChangeSetWrite({ changeSet: 'b', uri: path.join(docs, 'b.md') })
        clearChangeSets(['a'])
        assert.deepEqual(pendingChangeSets().map(s => s.id), ['b'])
    })
})

describe('writeEntitySource', () => {
    it('claims the file it wrote', async () => {
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'news/hello.md', content: '# Hi\n',
            changeSet: 'req-1', summary: 'Add a news item',
        })
        assert.equal(result.ok, true)
        assert.equal(result.changeSet, 'req-1')
        const [set] = pendingChangeSets()
        assert.deepEqual(set.paths, ['documents/news/hello.md'])
        assert.equal(set.summary, 'Add a news item')
    })

    it('claims nothing when the write was refused', async () => {
        // Claiming on intent would make a write that never happened undoable,
        // and undoing it would delete whatever is actually at that path.
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'a.md', content: 'x',
            ifChecksum: 'a-stale-value', changeSet: 'req-2',
        })
        assert.equal(result.ok, false)
        assert.deepEqual(pendingChangeSets(), [])
    })

    it('claims nothing for a path that escapes the collection', async () => {
        const result = await writeEntitySource({
            collection: 'documents', relativePath: '../../escape.md', content: 'x', changeSet: 'req-3',
        })
        assert.equal(result.refused, 'invalid-target')
        assert.deepEqual(pendingChangeSets(), [])
    })

    it('writes normally when no change set is given', async () => {
        const result = await writeEntitySource({
            collection: 'documents', relativePath: 'plain.md', content: 'body\n',
        })
        assert.equal(result.ok, true)
        assert.equal(result.changeSet, undefined)
        assert.equal(await readFile(path.join(docs, 'plain.md'), 'utf8'), 'body\n')
        assert.deepEqual(pendingChangeSets(), [])
    })
})

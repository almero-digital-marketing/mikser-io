// Change sets: which writes belong together, and who asked for them.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import runtime from '../../src/runtime.js'
import {
    recordChangeSetWrite, pendingChangeSets, clearChangeSets, forgetAllChangeSets,
    withChangeSet, currentChangeSet, closeChangeSet,
} from '../../src/changeset.js'
import { useCollection, writeEntity } from '../../src/utils.js'
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

describe('the ambient change set', () => {
    it('attributes a write that never names a set', async () => {
        // The point of the design: a plugin that has never heard of change
        // sets still produces undoable work.
        await withChangeSet({ changeSet: 'req-9', summary: 'One request' }, async () => {
            recordChangeSetWrite({ uri: path.join(docs, 'x.md') })
        })
        const [set] = pendingChangeSets()
        assert.equal(set.id, 'req-9')
        assert.equal(set.summary, 'One request')
        assert.deepEqual(set.paths, ['documents/x.md'])
    })

    it('lets an explicit id win over the ambient one', async () => {
        await withChangeSet({ changeSet: 'ambient' }, async () => {
            recordChangeSetWrite({ changeSet: 'explicit', uri: path.join(docs, 'x.md') })
        })
        assert.deepEqual(pendingChangeSets().map(s => s.id), ['explicit'])
    })

    it('claims nothing outside a context', () => {
        // An API or human write owned by no request stays unclaimed, which is
        // what keeps it out of an agent's undo.
        recordChangeSetWrite({ uri: path.join(docs, 'x.md') })
        assert.deepEqual(pendingChangeSets(), [])
        assert.equal(currentChangeSet(), null)
    })

    it('does not leak out of its own call', async () => {
        await withChangeSet({ changeSet: 'inside' }, async () => {})
        recordChangeSetWrite({ uri: path.join(docs, 'after.md') })
        assert.deepEqual(pendingChangeSets(), [])
    })

    it('survives an await inside the context', async () => {
        // AsyncLocalStorage is the whole reason this works across the awaits a
        // real write path is full of.
        await withChangeSet({ changeSet: 'req-async' }, async () => {
            await new Promise(resolve => setTimeout(resolve, 5))
            recordChangeSetWrite({ uri: path.join(docs, 'late.md') })
        })
        assert.deepEqual(pendingChangeSets().map(s => s.id), ['req-async'])
    })

    it('catches a collection write with no change set argument anywhere', async () => {
        // useCollection().write is the primitive drive-adjacent plugins and
        // sources use; nothing here mentions a change set.
        await withChangeSet({ changeSet: 'req-coll' }, async () => {
            await useCollection(runtime, 'documents').write('via-handle.md', 'body\n')
        })
        assert.deepEqual(pendingChangeSets()[0].paths, ['documents/via-handle.md'])
    })

    it('catches a collection remove as a deletion', async () => {
        await useCollection(runtime, 'documents').write('doomed.md', 'x\n')
        forgetAllChangeSets()
        await withChangeSet({ changeSet: 'req-del' }, async () => {
            await useCollection(runtime, 'documents').remove('doomed.md')
        })
        const [set] = pendingChangeSets()
        assert.deepEqual(set.deletions, ['documents/doomed.md'])
    })

    it('catches writeEntity, which a rename cascade runs per referring file', async () => {
        const uri = path.join(docs, 'ref.md')
        await withChangeSet({ changeSet: 'req-rename' }, async () => {
            await writeEntity({ uri }, { title: 'renamed' })
        })
        assert.deepEqual(pendingChangeSets()[0].paths, ['documents/ref.md'])
    })
})

describe('closing a set', () => {
    it('closes what it minted, so one tool call is committable at once', async () => {
        // The precise signal: an id nobody else can name cannot grow after the
        // call that owns it returns.
        await withChangeSet({ changeSet: 'auto-1', summary: 'One call', closeOnReturn: true }, async () => {
            recordChangeSetWrite({ uri: path.join(docs, 'a.md') })
        })
        assert.equal(pendingChangeSets()[0].closed, true)
    })

    it('leaves a caller-supplied set open, because more calls may join it', async () => {
        await withChangeSet({ changeSet: 'explicit-1', summary: 'Call one' }, async () => {
            recordChangeSetWrite({ uri: path.join(docs, 'b.md') })
        })
        assert.equal(pendingChangeSets()[0].closed, false,
            'grouping across calls is the whole point of passing an id')
    })

    it('closes even when the request failed part way', async () => {
        // Work that landed before the failure is real, and a set left open
        // forever holds it out of the committable half of the log.
        await assert.rejects(() => withChangeSet(
            { changeSet: 'boom', closeOnReturn: true },
            async () => {
                recordChangeSetWrite({ uri: path.join(docs, 'c.md') })
                throw new Error('handler failed')
            }))
        assert.equal(pendingChangeSets().find(s => s.id === 'boom')?.closed, true)
    })

    it('tracks when a set last grew, so an open one can go quiet', async () => {
        recordChangeSetWrite({ changeSet: 'idle-1', uri: path.join(docs, 'd.md') })
        const first = pendingChangeSets().find(s => s.id === 'idle-1').updatedAt
        await new Promise(resolve => setTimeout(resolve, 12))
        recordChangeSetWrite({ changeSet: 'idle-1', uri: path.join(docs, 'e.md') })
        const second = pendingChangeSets().find(s => s.id === 'idle-1').updatedAt
        assert.ok(second > first, 'a set that is still growing must not look idle')
    })
})

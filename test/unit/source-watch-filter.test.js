// A watched file is held to the same rules as a scanned one.
//
// The watcher sees the whole folder, so `extensions` and `ignore` have to be
// applied to each path it reports. Otherwise a collection declaring
// `extensions: ['json']` catalogues every file that arrives while the server
// runs, and two collections sharing a folder by extension take each other's
// files.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { sourceAccepts, sourcePattern, useSource } from '../../src/source.js'
import { ACTION } from '../../src/constants.js'

describe('sourcePattern', () => {
    it('matches everything for the default', () => {
        assert.equal(sourcePattern(), '**/*')
        assert.equal(sourcePattern(['*']), '**/*')
    })

    it('does not brace a single extension, which would match nothing', () => {
        assert.equal(sourcePattern(['json']), '**/*.json')
    })

    it('braces several', () => {
        assert.equal(sourcePattern(['json', 'jpg']), '**/*.{json,jpg}')
    })
})

describe('sourceAccepts', () => {
    const json = { pattern: sourcePattern(['json']) }
    const jpg = { pattern: sourcePattern(['jpg']) }

    it('takes a file with a declared extension, at any depth', () => {
        assert.equal(sourceAccepts('Janus/0878562193_201026.json', json), true)
        assert.equal(sourceAccepts('report.json', json), true)
    })

    it('refuses a file with another extension', () => {
        assert.equal(sourceAccepts('Janus/zz-probe.txt', json), false)
        assert.equal(sourceAccepts('Janus/0878562193_201026__F_WH.jpg', json), false)
    })

    it('lets two collections split one folder by extension', () => {
        const files = ['Janus/a.json', 'Janus/a__F_WH.jpg', 'Janus/a__L_PL.jpg']
        assert.deepEqual(files.filter(file => sourceAccepts(file, json)), ['Janus/a.json'])
        assert.deepEqual(files.filter(file => sourceAccepts(file, jpg)), ['Janus/a__F_WH.jpg', 'Janus/a__L_PL.jpg'])
    })

    it('honours ignore', () => {
        const rules = { pattern: sourcePattern(['json']), ignore: ['archive/**'] }
        assert.equal(sourceAccepts('archive/old.json', rules), false)
        assert.equal(sourceAccepts('Janus/new.json', rules), true)
    })

    it('ignores dotfiles, as the scan does', () => {
        assert.equal(sourceAccepts('Janus/.partial.json', json), false)
    })

    it('reads a Windows separator', () => {
        assert.equal(sourceAccepts('Janus\\a.json', json), true)
    })
})

describe('a watched event outside the collection', () => {
    // DELETE is the branch that runs without a catalog, and it passes the
    // same guard CREATE and UPDATE do.
    function wire(extensions) {
        let sync
        const deleted = []
        const quiet = { debug() {}, info() {}, warn() {}, error() {} }
        useSource({
            runtime: { options: {} },
            useLogger: () => quiet,
            onLoaded() {}, onImport() {},
            onSync: (collection, handler) => { sync = handler },
            createEntity: async () => {}, updateEntity: async () => {},
            deleteEntity: async (entity) => { deleted.push(entity.id) },
            watch() {}, trackProgress() {}, updateProgress() {},
        }, { collection: 'frames', type: 'source', folder: 'skincheck', extensions })
        return { sync, deleted }
    }

    it('is not the collection\'s to act on', async () => {
        const { sync, deleted } = wire(['jpg'])
        assert.equal(await sync({ action: ACTION.DELETE, context: { relativePath: 'Janus/a.json' } }), false)
        assert.deepEqual(deleted, [])
    })

    it('one inside it still is', async () => {
        const { sync, deleted } = wire(['jpg'])
        assert.equal(await sync({ action: ACTION.DELETE, context: { relativePath: 'Janus/a__F_WH.jpg' } }), true)
        assert.deepEqual(deleted, ['/frames/Janus/a__F_WH.jpg'])
    })
})

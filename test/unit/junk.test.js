import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import runtime from '../../src/runtime.js'
import { isJunkPath, JUNK_IGNORE, junkIgnore, junkFilter } from '../../src/utils.js'

afterEach(() => { delete runtime.config?.junk })

describe('isJunkPath', () => {
    it('catches the Windows litter that is NOT dot-prefixed', () => {
        // The whole reason this list is explicit. globby's dot:false default
        // and the watcher's leading-dot rule already hid the macOS files;
        // these were measurably being scanned AND watched.
        assert.equal(isJunkPath('Thumbs.db'), true)
        assert.equal(isJunkPath('desktop.ini'), true)
        assert.equal(isJunkPath('documents/sub/Thumbs.db'), true)
    })

    it('catches macOS litter too, so the rule survives someone enabling dotfiles', () => {
        assert.equal(isJunkPath('.DS_Store'), true)
        assert.equal(isJunkPath('._page.md'), true)
        assert.equal(isJunkPath('.localized'), true)
    })

    it('catches application lock files', () => {
        assert.equal(isJunkPath('~$report.docx'), true)         // Microsoft Office
        assert.equal(isJunkPath('.~lock.notes.odt#'), true)     // LibreOffice
    })

    it('catches anything inside a litter directory', () => {
        assert.equal(isJunkPath('documents/.Trashes/whatever.md'), true)
        assert.equal(isJunkPath('$RECYCLE.BIN/deleted.md'), true)
        assert.equal(isJunkPath('documents/System Volume Information/x'), true)
    })

    it('handles both separators', () => {
        assert.equal(isJunkPath('documents\\sub\\Thumbs.db'), true)
        assert.equal(isJunkPath('documents\\.Trashes\\x.md'), true)
    })

    it('does NOT catch content that merely resembles litter', () => {
        // A filter that silently drops content is worse than the litter it
        // prevents, so the match is on the whole basename.
        assert.equal(isJunkPath('page.md'), false)
        assert.equal(isJunkPath('my-thumbs.db'), false)
        assert.equal(isJunkPath('desktop.ini.md'), false)
        assert.equal(isJunkPath('thumbs-db.md'), false)
    })

    it('leaves editor backups alone — a person may have meant them', () => {
        assert.equal(isJunkPath('notes~'), false)
        assert.equal(isJunkPath('draft.md.bak'), false)
        assert.equal(isJunkPath('scratch.tmp'), false)
    })

    it('never throws on junk input', () => {
        for (const value of [undefined, null, '', 42, {}, []]) {
            assert.equal(isJunkPath(value), false)
        }
    })
})

describe('junk config', () => {
    it('defaults to the built-in list on both sides', () => {
        assert.deepEqual(junkIgnore(), JUNK_IGNORE)
        assert.equal(junkFilter()('Thumbs.db'), true)
    })

    it('junk: false turns the filter off entirely', () => {
        runtime.config = { ...runtime.config, junk: false }
        assert.deepEqual(junkIgnore(), [])
        assert.equal(junkFilter()('Thumbs.db'), false)
    })

    it('an array replaces the defaults rather than adding to them', () => {
        runtime.config = { ...runtime.config, junk: ['**/*.weird'] }
        assert.deepEqual(junkIgnore(), ['**/*.weird'])
    })
})

describe('wiring', () => {
    it('the scan puts junk patterns BEFORE a plugin\'s own ignore', async () => {
        // So a plugin adds to the filter instead of having to restate it.
        const { readFile } = await import('node:fs/promises')
        const src = await readFile(new URL('../../src/source.js', import.meta.url), 'utf8')
        assert.match(src, /ignore: \[\.\.\.junkIgnore\(\), \.\.\.ignore\]/)
    })

    it('the watcher combines the leading-dot rule with the junk filter', async () => {
        const { readFile } = await import('node:fs/promises')
        const src = await readFile(new URL('../../src/manager.js', import.meta.url), 'utf8')
        assert.match(src, /junkFilter\(\)\(filePath\)/)
        // A function, because chokidar 4+ dropped glob support in `ignored`.
        assert.match(src, /ignored: ignoreJunk/)
    })
})

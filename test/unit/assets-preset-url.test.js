// Unit coverage for presetUrl — the pure helper that builds a preset
// derivative's deployed URL (ADR-0011). It must produce exactly the path
// renderPresets writes to disk, so a $-ref expanding to a source entity
// resolves to a derivative that actually exists.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { presetUrl } from '../../src/plugins/assets.js'
import { changeExtension } from '../../src/utils.js'

describe('presetUrl', () => {
    it('swaps the extension when the preset declares a format (mp4 → jpg poster)', () => {
        const url = presetUrl({
            assetsFolder: 'assets',
            preset: 'poster',
            name: 'media/bg/products/X.mp4',
            format: 'jpg',
            changeExtension,
        })
        assert.equal(url, '/assets/poster/media/bg/products/X.jpg')
    })

    it('keeps the source extension when the preset declares no format', () => {
        const url = presetUrl({
            assetsFolder: 'assets',
            preset: 'product',
            name: 'media/bg/products/X.mp4',
            format: undefined,
            changeExtension,
        })
        assert.equal(url, '/assets/product/media/bg/products/X.mp4')
    })

    it('honors an output-folder-scoped assets root', () => {
        const url = presetUrl({
            assetsFolder: 'cdn/assets',
            preset: 'small',
            name: 'media/bg/faq/schedule.mp4',
            format: undefined,
            changeExtension,
        })
        assert.equal(url, '/cdn/assets/small/media/bg/faq/schedule.mp4')
    })

    it('produces a single leading slash, base-relative (no host)', () => {
        const url = presetUrl({
            assetsFolder: 'assets',
            preset: 'poster',
            name: 'img/products/Y.png',
            format: 'jpg',
            changeExtension,
        })
        assert.equal(url, '/assets/poster/img/products/Y.jpg')
        assert.ok(url.startsWith('/') && !url.startsWith('//'))
    })
})

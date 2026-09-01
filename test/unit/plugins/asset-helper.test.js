// `{{asset 'web' '/media/hero.jpg'}}` — the deployed URL of a preset
// derivative.
//
// It builds the URL rather than looking one up, so nothing it returns has been
// checked against anything: every mistake produces a well-formed link to a
// file that does not exist, on a green build, found by a person later.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { load } from '../../../src/plugins/render/asset.js'

function setup({ presets = {}, destination = '/index.html' } = {}) {
    const runtime = {}
    const warnings = []
    load({
        runtime,
        entity: { destination },
        state: { assets: { assetsFolder: 'assets', presets } },
        options: {},
        logger: { warn: (o, ...a) => warnings.push({ ...o, a }) },
    })
    return { asset: runtime.asset, warnings }
}

const WEB = { web: { name: 'web', format: 'webp' } }

describe('the extension comes from the preset', () => {
    it('uses the format the preset declares', () => {
        // Every preset module exports one. Requiring the template to repeat it
        // made the extension a thing two places had to agree about, and when
        // they disagreed the link was wrong with nothing said.
        const { asset } = setup({ presets: WEB })
        assert.equal(asset('web', '/media/hero.jpg').url, 'assets/web/media/hero.webp')
    })

    it('lets the caller override it', () => {
        const { asset } = setup({ presets: WEB })
        assert.equal(asset('web', '/media/hero.jpg', 'avif').url, 'assets/web/media/hero.avif')
    })

    it('says so when the override contradicts the preset', () => {
        const { asset } = setup({ presets: WEB })
        asset('web', '/media/hero.jpg', 'avif')
        assert.equal(setup({ presets: WEB }).warnings.length, 0, 'silent when they agree')
        const { asset: a2, warnings } = setup({ presets: WEB })
        a2('web', '/media/hero.jpg', 'png')
        assert.equal(warnings[0]?.code, 'asset-format-mismatch')
    })

    it('keeps the source extension for a preset that declares none', () => {
        // A preset with no format leaves the file as it is — a watermarker,
        // say. Nothing to swap.
        const { asset } = setup({ presets: { mark: { name: 'mark' } } })
        assert.equal(asset('mark', '/media/hero.jpg').url, 'assets/mark/media/hero.jpg')
    })
})

describe('a path with no extension', () => {
    it('keeps the path', () => {
        // The previous implementation split on '.' and rejoined, so a source
        // with no extension came back as bare "webp" — the path dropped
        // entirely, yielding a relative URL that resolved against whatever
        // page happened to be rendering.
        const { asset } = setup({ presets: WEB })
        assert.equal(asset('web', '/media/hero').url, 'assets/web/media/hero.webp')
    })

    it('is not confused by a dot in a directory name', () => {
        const { asset } = setup({ presets: WEB })
        assert.equal(asset('web', '/media/v1.2/hero.jpg').url, 'assets/web/media/v1.2/hero.webp')
    })
})

describe('a preset that is not configured', () => {
    it('warns, because the URL it returns points at nothing', () => {
        // The build cannot fail here — it is a string operation — so without
        // this a typo is a missing image and no other symptom anywhere.
        const { asset, warnings } = setup({ presets: WEB })
        asset('wbe', '/media/hero.jpg')
        assert.equal(warnings[0]?.code, 'asset-unknown-preset')
    })

    it('names what IS configured, so the typo is obvious', () => {
        const { asset, warnings } = setup({ presets: { web: {}, thumb: {} } })
        asset('wbe', '/media/hero.jpg')
        assert.match(JSON.stringify(warnings[0].a), /thumb.*web|web.*thumb/)
    })

    it('says it once per preset, not once per image', () => {
        const { asset, warnings } = setup({ presets: WEB })
        for (let i = 0; i < 20; i++) asset('wbe', `/media/${i}.jpg`)
        assert.equal(warnings.length, 1)
    })

    it('stays quiet for a preset that exists', () => {
        const { asset, warnings } = setup({ presets: WEB })
        asset('web', '/media/hero.jpg')
        assert.deepEqual(warnings, [])
    })
})

describe('relative to the page asking', () => {
    it('walks up from a nested page', () => {
        const { asset } = setup({ presets: WEB, destination: '/blog/post/index.html' })
        assert.equal(asset('web', '/media/hero.jpg').url, '../../assets/web/media/hero.webp')
    })

    it('accepts a url with no leading slash', () => {
        const { asset } = setup({ presets: WEB })
        assert.equal(asset('web', 'media/hero.jpg').url, 'assets/web/media/hero.webp')
    })
})

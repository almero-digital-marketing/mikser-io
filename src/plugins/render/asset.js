import path from 'node:path'

import { changeExtension } from '../../utils.js'

// `{{asset 'web' '/media/hero.jpg'}}` — the deployed URL of a preset
// derivative, relative to the page asking for it.
//
// It BUILDS the URL rather than looking one up, which is the source of every
// way it used to go wrong: nothing it returns has been checked against
// anything, so a mistake produces a perfectly well-formed link to a file that
// does not exist. The page renders, the build is green, and the image is
// missing — noticed by a person, later.
//
// Three of those are closed here. The remaining one is structural: the
// derivative may simply not have been generated, and this cannot tell.
// `meta.presets` (ADR-0011) is the looked-up answer where a caller has the
// entity; this helper exists for the case where they have a path.
export function load({ runtime, entity, state, options, logger }) {
    const presets = state?.assets?.presets ?? {}
    const warned = new Set()
    const warnOnce = (key, code, message, ...args) => {
        if (warned.has(key)) return
        warned.add(key)
        logger?.warn?.({ code }, message, ...args)
    }

    runtime.asset = (preset, url, format) => {
        if (url[0] != '/') url = `/${url}`

        const declared = presets[preset]?.format

        // A preset name nothing declares. The URL still gets built — it is a
        // string operation and cannot fail — so without this a typo is a
        // missing image and no other symptom anywhere.
        if (!presets[preset]) {
            warnOnce(`preset:${preset}`, 'asset-unknown-preset',
                'asset() was asked for preset %j, which is not configured. The URL it returns points at a '
                + 'derivative nothing generates. Configured: %s',
                preset, Object.keys(presets).sort().join(', ') || '(none)')
        }

        // The format the preset itself declares, unless the caller overrode
        // it. Every preset module exports one, so requiring the template to
        // repeat it made the extension a thing two places had to agree about
        // — and when they disagreed the link was wrong with nothing said.
        const effective = format ?? declared

        if (format && declared && format !== declared) {
            warnOnce(`format:${preset}:${format}`, 'asset-format-mismatch',
                'asset() was given format %j for preset %j, which produces %j. One of the two is wrong and '
                + 'the URL follows the argument.', format, preset, declared)
        }

        // changeExtension, not a local split-and-rejoin. The inline version
        // returned "webp" for a source with no extension — dropping the path
        // and yielding a relative URL that resolves against whatever page
        // happened to be rendering.
        const relative = `${state.assets.assetsFolder}/${preset}${effective ? changeExtension(url, effective) : url}`
        const destination = '/' + relative
        const from = path.dirname(entity.destination || '/')
        return { url: path.relative(from, destination) }
    }
}

export function assetUrlHelper(options = {}) {
    return { name: options.name ?? 'asset', options, load }
}

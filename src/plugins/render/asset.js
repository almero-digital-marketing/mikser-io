import path from 'node:path'

export function load({ runtime, entity, state, options }) {
    runtime.asset = (preset, url, format) => {
        if (url[0] != '/') url = `/${url}`
        const relative = `${state.assets.assetsFolder}/${preset}${format ? url.split('.').slice(0, -1).concat(format).join('.') : url}`
        const destination = '/' + relative
        const from = path.dirname(entity.destination || '/')
        return { url: path.relative(from, destination) }
    }
}

export function assetUrlHelper(options = {}) {
    return { name: options.name ?? 'asset', options, load }
}

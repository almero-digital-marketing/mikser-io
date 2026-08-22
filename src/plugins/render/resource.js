import path from 'node:path'

export function load({ runtime, entity, state, options }) {
    runtime.resource = (url) => {
        const { resourceLib } = state.resources
        for (let library in resourceLib) {
            if (url.match(library)) {
                const { origin } = new URL(url)
                const name = url.replace(origin, `${resourceLib[library]}`)
                const relative = url.replace(origin, `${state.resources.resourcesFolder}/${resourceLib[library]}`)
                const destination = '/' + relative
                const from = path.dirname(entity.destination || '/')
                return { url: path.relative(from, destination), name }
            }
        }
    }
}

export function resourceUrlHelper(options = {}) {
    return { name: options.name ?? 'resource', options, load }
}

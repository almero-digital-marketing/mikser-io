// Talking to a Piscina worker: forwarding its log records back, and making
// the options object survivable by structured clone.

import render from '../render.js'
import runtime from '../runtime.js'

// the terminal, with no second channel to keep in step.
export function workerMessages() {
    return event => {
        const message = JSON.parse(event.data)
        switch (message.command) {
            case 'logger':
                runtime.engine.logger[message.data.log](...message.data.args)
                break
        }
    }
}

// The identifier a descriptor is known by once its closures are gone.
// Render-shaped first, exactly as before: a descriptor carrying both `load`
// and `postprocess` has always been treated as a renderer.
function pluginIdentifier(plugin) {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.name !== 'string') return null
    if (typeof plugin.load === 'function' || typeof plugin.render === 'function') return `render-${plugin.name}`
    if (typeof plugin.postprocess === 'function') return `post-${plugin.name}`
    return null
}

export function workerSafeOptions(opts) {
    const result = {}
    // Where the code behind each identifier actually lives.
    //
    // The projection below reduces a descriptor to `render-<name>`, and the
    // worker resolves that name BY CONVENTION: a package called
    // `mikser-io-render-<name>`, or a file core ships. That convention is the
    // whole resolution story on a worker, because the runtime registry the
    // main thread reads is empty in another thread.
    //
    // So a renderer shipped under a package that is not named for it is
    // unresolvable there — and the failure is asymmetric in the worst way:
    // the main thread renders it fine from the registry, and only the
    // worker-dispatched entities break. mikser-io-assets ships two such
    // plugins (`preset` and `asset`), which is how 10.12.0 left every
    // worker render that calls `asset()` failing on a missing helper.
    //
    // A descriptor that carries `module` — the `import.meta.url` of the file
    // defining it — says where it is, and a string is exactly what survives
    // the thread boundary. Optional: a package named by the convention needs
    // nothing, so no existing plugin changes.
    const pluginModules = {}
    for (const [k, v] of Object.entries(opts)) {
        // `plugins` is a mixed array of factory-return values — functions
        // (lifecycle plugins; workers don't need them) and descriptor
        // objects (renderers / postprocessors) carrying closures that
        // can't survive structuredClone. Project descriptors to their
        // `render-${name}` / `post-${name}` identifiers so the worker
        // can resolve them via dynamic import.
        if (k === 'plugins' && Array.isArray(v)) {
            result[k] = v
                .map(p => {
                    const identifier = pluginIdentifier(p)
                    if (identifier && typeof p.module === 'string') pluginModules[identifier] = p.module
                    return identifier
                })
                .filter(Boolean)
            continue
        }
        try {
            structuredClone(v)
            result[k] = v
        } catch { /* not cloneable — skip */ }
    }
    // Only when something declared one, so an options object a test compares
    // whole does not grow an empty key.
    if (Object.keys(pluginModules).length) result.pluginModules = pluginModules
    return result
}

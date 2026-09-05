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

export function workerSafeOptions(opts) {
    const result = {}
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
                    if (p && typeof p === 'object' && typeof p.name === 'string'
                        && (typeof p.load === 'function' || typeof p.render === 'function'))   return `render-${p.name}`
                    if (p && typeof p === 'object' && typeof p.name === 'string'
                        && typeof p.postprocess === 'function')                                return `post-${p.name}`
                    return null
                })
                .filter(Boolean)
            continue
        }
        try {
            structuredClone(v)
            result[k] = v
        } catch { /* not cloneable — skip */ }
    }
    return result
}

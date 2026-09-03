import { useLogger } from './engine.js'
import { onLoad } from './lifecycle.js'
import runtime from './runtime.js'

import * as core from '../index.js'

// Dispatch v9-shaped plugin entries. The consumer's `plugins: [...]`
// carries the return values of factory calls — never strings, never the
// factories themselves. Three return shapes are recognized:
//
//   - function          → lifecycle plugin; called with `core` so it can
//                         register hooks (onLoaded, onBeforeRender, etc.)
//   - { name, load? }   → renderer descriptor; stored in
//     | { name, render? }   `runtime.renderers` for src/render.js to
//                         look up by name at dispatch time.
//   - { name, postprocess } → postprocessor descriptor; stored in
//                             `runtime.postprocessors`. Typically also
//                             carries `output` declaring the destination
//                             extension.
//
// Strings are explicit v8 → v9 migration errors with a pointer at the
// new shape (see ADR-0010).
onLoad(() => {
    const logger = useLogger()

    runtime.options.plugins = (runtime.options.plugins ?? [])
        .concat(runtime.config.plugins ?? [])
        .filter(Boolean)

    // Initialize the registries up front so first-time access (even
    // from render.js / postprocess.js before any descriptor lands)
    // always sees a Map, never undefined.
    runtime.renderers      = runtime.renderers      ?? new Map()
    runtime.postprocessors = runtime.postprocessors ?? new Map()

    const factoryEntries = []
    let registeredRenderers = 0
    let registeredPostprocessors = 0
    for (const entry of runtime.options.plugins) {
        if (typeof entry === 'function') {
            factoryEntries.push(entry)
            continue
        }
        if (entry && typeof entry === 'object') {
            // Renderer descriptor — has `name` and at least one of
            // `load` (template-helper / runtime augmentation; the
            // markdown / metatext / asset / href / file / resource
            // wrappers are the canonical "load-only" cases) or
            // `render` (the primary entity-to-output renderer).
            if (typeof entry.render === 'function' || typeof entry.load === 'function') {
                const name = entry.name
                if (!name) {
                    logger.error('Renderer descriptor missing `name`: %o', entry)
                    continue
                }
                runtime.renderers.set(name, entry)
                registeredRenderers++
                continue
            }
            if (typeof entry.postprocess === 'function') {
                const name = entry.name
                if (!name) {
                    logger.error('Postprocessor descriptor missing `name`: %o', entry)
                    continue
                }
                runtime.postprocessors.set(name, entry)
                registeredPostprocessors++
                continue
            }
            logger.error(
                'Plugin entry returned an unknown object shape (expected `render`, `load`, or `postprocess`): %o',
                entry,
            )
            continue
        }
        if (typeof entry === 'string') {
            logger.error(
                'Plugin "%s" is a string. v9 requires plugins to be imported and called:\n' +
                '  import { %s } from \'mikser-io\'\n' +
                '  plugins: [%s()]\n' +
                'See ADR-0010 for the new shape.',
                entry, kebabToCamel(entry), kebabToCamel(entry),
            )
            continue
        }
        logger.error('Plugin entry must be a factory call result; got %s', typeof entry)
    }

    if (!factoryEntries.length && !registeredRenderers && !registeredPostprocessors) {
        // "No plugins loaded" is a legitimate state for a project with no
        // config at all, and a near-certain mistake for one that HAS a
        // config. One line for both makes a config that produced no
        // plugins read as a deliberate choice, so say which case it is.
        if (runtime.options.configChecksum) {
            logger.warn(
                'No plugins loaded, but a config was read from %s — ' +
                'it exported no `plugins` array, or the array was empty. ' +
                'Nothing will be built.',
                runtime.options.config,
            )
        } else {
            logger.info('No plugins loaded')
        }
        return
    }

    const parts = []
    if (factoryEntries.length)    parts.push(`${factoryEntries.length} lifecycle`)
    if (registeredRenderers)      parts.push(`${registeredRenderers} renderer${registeredRenderers === 1 ? '' : 's'}`)
    if (registeredPostprocessors) parts.push(`${registeredPostprocessors} postprocessor${registeredPostprocessors === 1 ? '' : 's'}`)
    logger.info('Loading plugins: %s', parts.join(', '))

    // Which plugin registered which hook, so a phase can be broken down.
    //
    // `timings` said `finalized: 19400ms` and stopped there — and finalized is
    // where the reference check, schemas, lint and lighthouse all live, so the
    // one number said nothing about which of them cost it. Downstream that
    // took three separate measurements to attribute a 465ms lint pass.
    //
    // Labelled retroactively, because a plugin's identity is not knowable
    // until its factory RETURNS: the entry in the plugins array is already the
    // factory's result, so there is no name to read going in, and the
    // descriptor with `collection` on it only exists coming out. So the hooks
    // are diffed across the call and tagged with what the call produced.
    const hookNames = Object.keys(runtime.hooks)
    for (const [index, factoryReturn] of factoryEntries.entries()) {
        const before = new Map(hookNames.map(name => [name, runtime.hooks[name].length]))
        let descriptor
        try {
            descriptor = factoryReturn(core)
        } catch (err) {
            logger.error('Plugin factory threw on registration: %s', err.message)
            continue
        }
        const label = descriptor?.collection ?? descriptor?.type ?? `plugin-${index + 1}`
        for (const name of hookNames) {
            for (const hook of runtime.hooks[name].slice(before.get(name))) {
                // A plugin registering the same function twice keeps its first
                // label rather than being renamed by a later registration.
                if (typeof hook === 'function' && !hook.mikserPlugin) hook.mikserPlugin = label
            }
        }
    }
})

function kebabToCamel(s) {
    return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

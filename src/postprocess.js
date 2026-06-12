import path from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import _ from 'lodash'
import { useLogger } from './engine.js'
import engineRuntime from './runtime.js'

export async function loadPlugin(pluginName, workingFolder, loggerOverride) {
    // Worker contexts don't have access to the engine's pino instance
    // via useLogger() — callers from inside the Piscina dispatch pass
    // their port-forwarded logger explicitly so plugin-load failures
    // surface back in the engine's log stream instead of disappearing.
    const logger = loggerOverride ?? useLogger()

    // v9 registry first. Same shape as render.js — descriptors stored
    // under their name, keyed without the `post-` prefix. Workers see
    // empty registry and fall through to dynamic import.
    const stripped = pluginName.replace(/^post-/, '')
    const registered = engineRuntime.postprocessors?.get(stripped)
    if (registered) return registered

    const require = createRequire(path.join(workingFolder, 'package.json'))
    let nodeModulesResolved
    try {
        nodeModulesResolved = require.resolve(`mikser-io-${pluginName}`)
    } catch { /* package not installed at this level — fine, try next */ }

    const resolveLocations = [
        path.join(workingFolder, 'node_modules', `mikser-io-${pluginName}/index.js`),
        nodeModulesResolved,
        path.join(workingFolder, 'plugins', `${pluginName}.js`),
        path.join(path.dirname(import.meta.url), 'plugins', 'post', `${pluginName.replace('post-', '')}.js`)
    ].filter(Boolean)

    for (let resolveLocation of resolveLocations) {
        // See render.js loadPlugin — existence-check first so we can
        // distinguish "plugin not at this path" from "plugin found but its
        // transitive deps are missing".
        if (!existsSync(resolveLocation.replace(/^file:/, ''))) continue
        try {
            return await import(resolveLocation)
        } catch (err) {
            if (err.code === 'ERR_MODULE_NOT_FOUND') {
                logger?.error('Postprocess plugin %s found at %s but its dependencies are missing: %s', pluginName, resolveLocation, err.message)
            } else {
                logger?.error('Postprocess plugin %s failed to load (%s): %s', pluginName, resolveLocation, err.message)
            }
            throw err
        }
    }

    logger?.error('Postprocess plugin %s not found.', pluginName)
}

export default async ({ entity, options, config, context, state, logger, port }) => {

    // Piscina worker context: no main-process logger reaches the worker.
    // Build one that forwards records back to the engine over the
    // MessageChannel port the dispatcher transfers in. Same shape as
    // render.js's worker logger so engine-side handling is identical.
    logger = logger || {
        info(...args)   { port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'info',   args } })) },
        warn(...args)   { port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'warn',   args } })) },
        error(...args)  { port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'error',  args } })) },
        debug(...args)  { port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'debug',  args } })) },
        trace(...args)  { port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'trace',  args } })) },
        notice(...args) { port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'notice', args } })) },
    }

    const { postprocessor } = options
    const plugins = {}
    let pluginsToLoad = [...context.plugins || []]
    pluginsToLoad.push(`post-${postprocessor}`)
    if (entity.meta?.plugins) {
        pluginsToLoad.push(...entity.meta.plugins)
    }
    pluginsToLoad.push(...options.plugins)
    // `context.plugins` / `entity.meta.plugins` carry string
    // identifiers; `options.plugins` carries factory returns. Project
    // descriptors to their `post-${name}` identifier so loadPlugin()
    // can resolve them uniformly.
    pluginsToLoad = _.uniq(pluginsToLoad
        .map(p => {
            if (typeof p === 'string') return p
            if (p && typeof p === 'object' && typeof p.postprocess === 'function') {
                return `post-${p.name}`
            }
            return null
        })
        .filter(p => p && p.indexOf('post-') == 0))

    // Resolve all plugins up front so we can populate `runtime.config`
    // (the worker-side mini-runtime built below) with the requested
    // postprocessor's own options — same channel the legacy v8 path
    // populated via `runtime.config['post-pdf']`.
    for (let pluginName of pluginsToLoad) {
        const plugin = await loadPlugin(pluginName, options.workingFolder, logger)
        if (!plugin) continue // loadPlugin already logged the "not found" path
        plugins[pluginName] = plugin
    }

    const postprocessorPlugin = plugins[`post-${postprocessor}`]
    if (!postprocessorPlugin) {
        throw new Error(`Postprocessor "${postprocessor}" was requested but plugin "post-${postprocessor}" is not loaded`)
    }
    if (typeof postprocessorPlugin.postprocess !== 'function') {
        throw new Error(`Plugin "post-${postprocessor}" does not export a postprocess() function`)
    }

    const runtime = {
        [entity.type]: entity,
        entity,
        plugins,
        config: postprocessorPlugin.options,
        data: context.data,
    }

    for (const [pluginName, plugin] of Object.entries(plugins)) {
        if (!plugin?.load) continue
        try {
            await plugin.load({ entity, options, config: plugin.options, context, runtime, state, logger })
        } catch (err) {
            logger.error('Postprocess plugin %s load() failed: %s', pluginName, err.message)
            throw err
        }
    }

    return await postprocessorPlugin.postprocess({ entity, options, config: postprocessorPlugin.options, context, plugins, runtime, state, logger })
}

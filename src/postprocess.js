import path from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
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

    // Chain dispatch. The engine queued ONE task per (entity, chain);
    // we iterate stages here, threading the previous stage's output
    // path into the next stage's `entity.origin`. Intermediates land
    // in runtime/postprocess-scratch/<entity-derived>/<stage>.<ext>;
    // the final stage writes to entity.destination (outputFolder).
    //
    // Each stage's `postprocess()` is expected to read entity.origin,
    // write to entity.destination, and return either:
    //   { success: true, result: <output-path> }   — preferred
    //   <path string>                              — accepted
    //   <Buffer | string-of-bytes>                 — engine writes to
    //                                                entity.destination
    //                                                (legacy single-
    //                                                stage shape)
    //
    // The final stage's return value is what bubbles back to the
    // engine; intermediate stages' returns are consumed here.

    const chain = options.postprocessors ?? (options.postprocessor ? [options.postprocessor] : [])
    if (!chain.length) {
        throw new Error('Postprocess dispatch: no postprocessors in the chain')
    }

    const plugins = {}
    let pluginsToLoad = [...context.plugins || []]
    for (const stage of chain) pluginsToLoad.push(`post-${stage}`)
    if (entity.meta?.plugins) {
        pluginsToLoad.push(...entity.meta.plugins)
    }
    pluginsToLoad.push(...options.plugins)
    pluginsToLoad = _.uniq(pluginsToLoad
        .map(p => {
            if (typeof p === 'string') return p
            if (p && typeof p === 'object' && typeof p.postprocess === 'function') {
                return `post-${p.name}`
            }
            return null
        })
        .filter(p => p && p.indexOf('post-') == 0))

    for (let pluginName of pluginsToLoad) {
        const plugin = await loadPlugin(pluginName, options.workingFolder, logger)
        if (!plugin) continue
        plugins[pluginName] = plugin
    }

    // Pre-flight: every stage in the chain must resolve to a loaded
    // plugin with a postprocess() function. Fail loud at the start
    // rather than mid-chain.
    for (const stage of chain) {
        const plugin = plugins[`post-${stage}`]
        if (!plugin) {
            throw new Error(`Postprocessor "${stage}" was requested but plugin "post-${stage}" is not loaded`)
        }
        if (typeof plugin.postprocess !== 'function') {
            throw new Error(`Plugin "post-${stage}" does not export a postprocess() function`)
        }
    }

    // Run sidecar load() on every loaded plugin once (not per-stage).
    // load() typically sets up runtime helpers; one cycle is enough.
    const finalPlugin = plugins[`post-${chain[chain.length - 1]}`]
    const runtime = {
        [entity.type]: entity,
        entity,
        plugins,
        config: finalPlugin.options,
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

    // Scratch folder per entity. Lives under runtimeFolder so it
    // survives until cleanup but doesn't leak into outputFolder.
    const scratchDir = path.join(
        options.runtimeFolder ?? path.join(options.workingFolder, 'runtime'),
        'postprocess-scratch',
        entity.id.replace(/^\/+/, '').replace(/[/\\]/g, '_'),
    )
    const intermediatesToCleanup = []

    // Resolve the destination for stage i in the chain.
    //   - last stage → entity.destination (the final output path,
    //                  already swapped to the chain's last extension
    //                  by the engine).
    //   - all others → scratch/<stage>.<ext> where ext is the stage's
    //                  declared output.
    async function resolveStageDestination(stageIndex) {
        if (stageIndex === chain.length - 1) {
            return entity.destination
        }
        const plugin = plugins[`post-${chain[stageIndex]}`]
        // Stage's `output:` declaration (e.g. 'html', 'pdf'). When
        // absent, fall back to the prior file's extension — the stage
        // is mutating bytes without changing format.
        const ext = plugin.output ?? path.extname(entity.origin || entity.destination).slice(1) ?? 'bin'
        await mkdir(scratchDir, { recursive: true })
        const p = path.join(scratchDir, `${stageIndex}-${chain[stageIndex]}.${ext}`)
        // Relative-to-outputFolder, since post plugins resolve
        // entity.origin/destination against outputFolder.
        const rel = path.relative(options.outputFolder, p)
        return '/' + rel.split(path.sep).join('/')
    }

    let stageOrigin = entity.origin
    let stageResult
    try {
        for (let i = 0; i < chain.length; i++) {
            const stage = chain[i]
            const plugin = plugins[`post-${stage}`]
            const stageDestination = await resolveStageDestination(i)
            const stageEntity = {
                ...entity,
                origin: stageOrigin,
                destination: stageDestination,
            }
            stageResult = await plugin.postprocess({
                entity:  stageEntity,
                options, config:  plugin.options, context,
                plugins, runtime, state,   logger,
            })

            // Determine where this stage actually wrote. Acceptable
            // return shapes:
            //   { success: false, ... }     → fail the chain
            //   { success: true, result: P }→ P is the output path
            //   string                      → output path
            //   Buffer | string-of-bytes    → engine writes them to
            //                                 stageDestination for the
            //                                 next stage (or for the
            //                                 final write).
            if (stageResult && typeof stageResult === 'object' && stageResult.success === false) {
                throw new Error(`Postprocess stage ${stage} reported failure: ${stageResult.error ?? '(no message)'}`)
            }

            // If the stage handed us raw bytes, materialize them to
            // disk so the next stage has an origin path to read.
            const resultPayload = (stageResult && typeof stageResult === 'object' && 'result' in stageResult)
                ? stageResult.result
                : stageResult
            const isPath = typeof resultPayload === 'string' && (resultPayload.startsWith('/') || resultPayload.startsWith('./') || path.isAbsolute(resultPayload))

            if (!isPath && resultPayload != null) {
                // Engine materializes bytes to stageDestination.
                const abs = path.join(options.outputFolder, stageDestination)
                await mkdir(path.dirname(abs), { recursive: true })
                await writeFile(abs, resultPayload)
            }

            // Stage N+1's origin = this stage's output path
            // (relative-to-outputFolder, same shape entity.origin
            // already uses).
            const nextOrigin = isPath ? resultPayload : stageDestination
            if (i < chain.length - 1) {
                intermediatesToCleanup.push(nextOrigin)
            }
            stageOrigin = nextOrigin
        }
    } catch (err) {
        // Cleanup any intermediates the chain produced before the
        // failure. Final output (if any) was written to
        // entity.destination — but a failure means the chain did NOT
        // complete; remove that too so partial state doesn't leak.
        for (const p of intermediatesToCleanup) {
            try { await unlink(path.join(options.outputFolder, p)) } catch {}
        }
        try { await unlink(path.join(options.outputFolder, entity.destination)) } catch {}
        throw err
    }

    // Cleanup intermediate scratch files. Best-effort; misses are not
    // a hard failure — they'll re-overwrite next cycle if any survive.
    for (const p of intermediatesToCleanup) {
        try { await unlink(path.join(options.outputFolder, p)) } catch {}
    }

    // Cleanup the renderer's origin (first stage's input) when it's
    // a different path from the chain's final destination. The chain
    // contract puts this on the dispatcher rather than on layouts'
    // onComplete, which is what lets onComplete stay agnostic about
    // whether a postprocess output was written to disk at all.
    if (entity.origin && entity.origin !== entity.destination) {
        try { await unlink(path.join(options.outputFolder, entity.origin)) } catch {}
    }

    // Return undefined so the engine's onPostprocess loop doesn't
    // try to thread `result` back through layouts' onComplete (which
    // would attempt a writeFile against a non-bytes value). The
    // postprocess plugins have written directly to disk by this point;
    // there is nothing for the engine to flush.
    return undefined
}

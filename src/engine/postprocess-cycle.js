// The postprocess dispatcher: chains parsed off the render, dispatched the
// same three ways, with a failure counted as a render error.

import Piscina from 'piscina'
import map from 'p-map'
import path from 'node:path'
import postprocess from '../postprocess.js'
import render from '../render.js'
import runtime from '../runtime.js'
import { OPERATION, TASKS } from '../constants.js'
import { updateEntry, useJournal } from '../journal.js'
import { onBeforePostprocess, onPostprocess, postprocessEntities } from '../lifecycle.js'
import { loadPlugin as loadPostPlugin } from '../postprocess.js'
import { reportError } from '../report.js'
import { useLogger } from '../use-logger.js'
import { changeExtension, formatErrorContext } from '../utils/index.js'
import { workerMessages, workerSafeOptions } from './workers.js'

export function registerPostprocessCycle() {

    onBeforePostprocess(async (signal) => {
        // Resolve the output extension for each postprocessor exactly once
        // per cycle. A plugin can declare `export const output = '...'` to
        // separate its name from the produced file extension (e.g. post-mjml
        // names itself "mjml" but emits ".html"). Falls back to the
        // postprocessor name for plugins that don't declare it — preserves
        // the current behavior for post-pdf and any other existing plugin.
        const outputExtCache = new Map()
        const resolveOutputExt = async (postprocessor) => {
            if (outputExtCache.has(postprocessor)) return outputExtCache.get(postprocessor)
            let ext = postprocessor
            try {
                const plugin = await loadPostPlugin(`post-${postprocessor}`, runtime.options.workingFolder)
                if (plugin?.output) ext = plugin.output
            } catch { /* loadPostPlugin already logged */ }
            outputExtCache.set(postprocessor, ext)
            return ext
        }

        const tasks = []
        for await (const { entity, options, context, output } of useJournal('Queuing postprocess', [OPERATION.RENDER], signal)) {
            // Read the postprocessor chain. layouts plugin carries
            // it as `options.postprocessors` (array, normalized); the
            // singular `options.postprocessor` is a back-compat alias
            // for the head of the chain. Empty chain → no postprocess.
            const chain = options.postprocessors ?? (options.postprocessor ? [options.postprocessor] : [])
            if (output?.success && chain.length) {
                // The FINAL destination extension is the last stage's
                // `output:`. Intermediate stages' extensions are used
                // only for scratch path naming inside src/postprocess.js.
                const finalExt = await resolveOutputExt(chain[chain.length - 1])
                const destination = changeExtension(entity.destination, finalExt)

                tasks.push({
                    entity: {
                        ...entity,
                        origin: entity.destination,
                        destination
                    },
                    options: {
                        // Singular kept for back-compat with the worker
                        // serialization shape; chain is the source of
                        // truth.
                        postprocessor: chain[0],
                        postprocessors: chain,
                        tasks: options.tasks,
                        // When the originating render call passed
                        // `save: false`, the layouts plugin wrote the
                        // intermediate into runtime.options.previewFolder
                        // rather than outputFolder. Postprocess plugins
                        // resolve `entity.origin` against
                        // `options.outputFolder`, so swap it here so
                        // they look in the right place. No change for
                        // normal builds (entity.options.save unset →
                        // outputFolder).
                        ...(entity.options?.save === false
                            ? { outputFolder: runtime.options.previewFolder }
                            : {}),
                    },
                    context
                })
            }
        }
        if (tasks.length) await postprocessEntities(tasks)
    })

    onPostprocess(async (signal) => {
        const logger = useLogger()

        // Collect every postprocessor descriptor in the plugins list
        // and project to the `post-${name}` identifier the loader uses.
        // Per-postprocessor options now live on each descriptor (.options)
        // — no top-level `config['post-*']` channel anymore (ADR-0010).
        const postPluginNames = []
        for (const entry of runtime.options.plugins) {
            if (entry && typeof entry === 'object' && typeof entry.postprocess === 'function' && typeof entry.name === 'string') {
                postPluginNames.push(`post-${entry.name}`)
            }
        }
        const postPlugins = {}
        for (const pluginName of postPluginNames) {
            const plugin = await loadPostPlugin(pluginName, runtime.options.workingFolder)
            if (plugin) {
                postPlugins[pluginName] = plugin
                if (plugin.setup) await plugin.setup({ options: runtime.options, config: plugin.options, state: runtime.state, logger })
            }
        }

        const postprocessJobs = new Set()
        try {
            await map(useJournal('Postprocessing', [OPERATION.POSTPROCESS], signal), async entry => {
                const { id, entity, options, context } = entry
                const jobId = entity.id + ':' + entity.destination
                if (!postprocessJobs.has(jobId) && !options.ignore) {
                    postprocessJobs.add(jobId)
                    const postprocessOptions = {
                        entity,
                        options: {
                            tasks: TASKS.INLINE,
                            ...runtime.options,
                            ...options,
                        },
                        // Per-postprocessor options live on the descriptor
                        // and are read inside postprocess.js at dispatch
                        // time; the empty object here keeps the worker
                        // arg shape stable.
                        config: {},
                        context,
                        state: runtime.state
                    }
                    try {
                        let result
                        switch (postprocessOptions.options.tasks) {
                            case TASKS.INLINE:
                                postprocessOptions.logger = logger
                                postprocessOptions.signal = signal
                                if (!signal.aborted) {
                                    result = await postprocess(postprocessOptions)
                                }
                                break
                            case TASKS.SERIAL:
                                postprocessOptions.logger = logger
                                postprocessOptions.signal = signal
                                if (!signal.aborted) {
                                    result = await runtime.engine.queue.add(() => postprocess(postprocessOptions), { signal })
                                }
                                break
                            case TASKS.WORKER: {
                                // Postprocess in a Piscina worker. Same
                                // IPC logger forwarding shape as render
                                // WORKER (engine.js render dispatcher). The
                                // worker's plugins module-state is fresh per
                                // thread — plugins that hold state across
                                // calls (e.g. post-pdf's puppeteer browser
                                // launched in setup()) need to be re-entrant
                                // per worker, since the main-process setup()
                                // hook didn't run inside the worker.
                                // Stateless postprocessors (post-mjml) work
                                // out-of-the-box.
                                const mc = new MessageChannel()
                                mc.port2.onmessage = workerMessages()
                                mc.port2.unref()
                                postprocessOptions.port = mc.port1
                                // Same options-sanitization as the render
                                // WORKER path — drop plugin-surface
                                // functions before structured clone.
                                postprocessOptions.options = {
                                    ...workerSafeOptions(runtime.options),
                                    tasks: postprocessOptions.options.tasks,
                                    postprocessor: postprocessOptions.options.postprocessor,
                                    ...(postprocessOptions.options.outputFolder
                                        ? { outputFolder: postprocessOptions.options.outputFolder }
                                        : {}),
                                }
                                if (!signal.aborted) {
                                    result = await runtime.engine.postprocessWorkers.run(
                                        postprocessOptions,
                                        { signal, transferList: [mc.port1] }
                                    )
                                }
                                break
                            }
                        }
                        if (!signal.aborted) {
                            entry.output = { success: true }
                            if (result) entry.output.result = result
                            await runtime.complete(entry)
                            await updateEntry({ id, output: entry.output })
                        }
                        logger.debug('Postprocessed: [%s] %s → %s', options.postprocessor, entity.name || entity.id, entity.destination)
                    } catch (err) {
                        if (!signal.aborted) {
                            await updateEntry({ id, output: { success: false } })
                            logger.error('Postprocess error: %s%s %s', entity.id, formatErrorContext(entity, err, runtime.options), err.message)
                            // A failed postprocess wrote no file, so it has to
                            // count the same as a failed render. It did not:
                            // this line was the whole of it, the exit code
                            // stayed 0, and `errors` in --json never mentioned
                            // it — a build with output missing reporting
                            // success, which is the exact shape of bug the
                            // rest of this file exists to make impossible.
                            reportError(entity, err, {
                                postprocessor: options.postprocessor ?? null,
                                layout: entity.layout?.id ?? null,
                            })
                        }
                        logger.debug('Postprocess canceled')
                    }
                } else {
                    await updateEntry({ id, output: { success: true } })
                }
            }, {
                concurrency: runtime.options.threads,
                signal
            })
            postprocessJobs.size && logger.info('Postprocessed: %d', postprocessJobs.size)
        } finally {
            for (const [pluginName, plugin] of Object.entries(postPlugins)) {
                if (plugin.teardown) await plugin.teardown({ options: runtime.options, config: plugin.options, state: runtime.state, logger })
            }
        }
    })
}

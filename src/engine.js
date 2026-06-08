import path from 'node:path'
import { Command } from 'commander'
import { rm, lstat, realpath, mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import _ from 'lodash'
import Piscina from 'piscina'
import runtime from './runtime.js'
import { onInitialize, onInitialized, onRender, onCancel, onCancelled, onFinalized, onLoaded, onAfterRender, onBeforePostprocess, onPostprocess, postprocessEntities } from './lifecycle.js'
import { useJournal, updateEntry } from './journal.js'
import { globby } from 'globby'
import { OPERATION, TASKS } from './constants.js'
import { changeExtension, formatErrorContext, projectMeta } from './utils.js'
import render from './render.js'
import postprocess, { loadPlugin as loadPostPlugin } from './postprocess.js'
import map from 'p-map'
import Queue from 'p-queue'
import packageInfo from '../package.json' with { type: 'json' }
import { attachServerCliOptions, setupServer } from './server.js'
import { createMikserLogger } from './logger.js'

export async function setup(options) {
    runtime.options.threads = options?.threads !== undefined ? options.threads : 4
    runtime.engine = {
        // Logger built from logger.js — pino + multistream + inline
        // pino-pretty over a gauge-aware terminal stream. Initial level
        // is 'info'; bumped to 'debug'/'trace' after CLI parse if those
        // flags are set. Caller can override entirely via options.logger
        // (e.g. to supply a pre-configured pino instance with their own
        // transports); progress-bar coordination is then their problem.
        logger: options?.logger || createMikserLogger('info'),
        commander: new Command(),
        renderWorkers: new Piscina({
            filename: new URL('./render.js', import.meta.url).href,
            maxThreads: runtime.options.threads
        }),
        queue: new Queue({ concurrency: 1 })
    }
    runtime.state = {}

    onInitialize(async () => {
        runtime.engine.commander?.version(packageInfo.version)
            .option('-i --working-folder <folder>', 'set mikser working folder', './')
            .option('-p --plugins [plugins...]', 'list of mikser plugins to load', [])
            .option('-c --config <file>', 'set mikser mikser.config.js location', './mikser.config.js')
            .option('-m --mode <mode>', 'set mikser runtime mode', 'development')
            .option('-r --clear', 'clear current state before execution', false)
            .option('-o --output-folder <folder>', 'set mikser output folder relative to working folder', 'out')
            .option('-w --watch', 'watch entities for changes', false)
            .option('-d --debug', 'display debug statements')
            .option('-t --trace', 'display trace statements')
            .option('-e --runtime-folder <folder>', 'set mikser runtime folder relative to working folder', 'runtime')
        attachServerCliOptions(runtime.engine.commander)

        Object.assign(runtime.options, options || runtime.engine.commander.parse(process.argv).opts())
        // runtime.options.info gates the progress bar — gauge stays
        // silent in --debug/--trace modes because logs are voluminous
        // there and a bar on top would just be noise.
        runtime.options.info = true
        if (runtime.options.debug) {
            runtime.engine.logger.level = 'debug'
            runtime.options.info = false
        }
        if (runtime.options.trace) {
            runtime.engine.logger.level = 'trace'
            runtime.options.debug = false
            runtime.options.info = false
        }

        // Resolve folders inside onInitialize so journal.js and
        // catalog.js (which initialize in onInitialized) see absolute
        // paths and a guaranteed-existing runtimeFolder. The split is
        // deliberate: engine's onInitialize does setup that the rest of
        // the engine infrastructure depends on; onInitialized does
        // things plugins may need.
        runtime.options.workingFolder = path.resolve(runtime.options.workingFolder)
        process.chdir(runtime.options.workingFolder)

        runtime.options.runtimeFolder = path.join(runtime.options.workingFolder, runtime.options.runtimeFolder || 'runtime')
        runtime.options.outputFolder = path.join(runtime.options.workingFolder, runtime.options.outputFolder || 'out')
        // Scratch path for intermediate render artifacts when a caller
        // opted out of disk writes via render({ save: false }) but the
        // layout has a postprocessor that still needs to read the
        // intermediate. Lives under runtimeFolder so it's engine-owned
        // and never appears in outputFolder.
        runtime.options.previewFolder = path.join(runtime.options.runtimeFolder, 'preview')

        if (runtime.options.clear) {
            try {
                runtime.engine.logger.info('Clearing folders')
                await rm(runtime.options.outputFolder, { recursive: true })
                await rm(runtime.options.runtimeFolder, { recursive: true })
            } catch (err) {
                if (err.code != 'ENOENT')
                    throw err
            }
        }
        await mkdir(runtime.options.runtimeFolder, { recursive: true })
    })

    onInitialized(async () => {
        const logger = useLogger()
        logger.info('Working folder: %s', runtime.options.workingFolder)
        logger.info('Output folder: %s', runtime.options.outputFolder)
    })

    // Wire the HTTP server lifecycle (bring-up on onInitialized + late-
    // binding static mount and listen on onLoad/onLoaded). See server.js.
    // Called AFTER engine's own onInitialized registration so server's
    // bring-up logs come after the folder-info lines.
    setupServer()

    onLoaded(async () => {
        const logger = useLogger()
        logger.debug(runtime.options, 'Mikser options')

        // Cumulative render manifest — survives across watch cycles, used to
        // unlink stale output files when their source entity is deleted.
        // Keyed by "<entity.id>:<entity.destination>" so paginated outputs
        // for the same id stay distinct.
        runtime.state.manifest = new Map()
        const manifestPath = path.join(runtime.options.runtimeFolder, 'render-details.json')
        if (existsSync(manifestPath)) {
            try {
                const arr = JSON.parse(await readFile(manifestPath, 'utf8'))
                if (Array.isArray(arr)) {
                    for (const entity of arr) {
                        if (entity?.id && entity?.destination) {
                            runtime.state.manifest.set(`${entity.id}:${entity.destination}`, entity)
                        }
                    }
                }
            } catch (err) {
                logger.warn('Could not load render-details.json: %s', err.message)
            }
        }
    })

    onRender(async (signal) => {
        const logger = useLogger()
        const renderJobs = new Set()
        await map(useJournal('Rendering', [OPERATION.RENDER], signal), async entry => {
            const { id, entity, options, context } = entry
            const jobId = entity.id + ':' + entity.destination
            if (!renderJobs.has(jobId) && !options.ignore) {
                renderJobs.add(jobId)
                // Project reference-marker keys (`$author`, `$hero`, …)
                // into their normalized form (`author`, `hero`) before
                // the entity crosses into the renderer — applies whether
                // the render runs in-process or on a worker thread.
                // Templates and renderer plugins see plain field names;
                // the canonical `$`-keyed form stays in the catalog entry
                // where the schemas and refs plugins consume it.
                // Per ADR-0007 A4, on collision the `$`-version wins
                // deterministically in the projection.
                const renderEntity = entity?.meta
                    ? { ...entity, meta: projectMeta(entity.meta) }
                    : entity
                const renderOptions = {
                    entity: renderEntity,
                    options: {
                        tasks: TASKS.INLINE,
                        ...runtime.options,
                        ...options,
                    },
                    config: _.pickBy(runtime.config, (value, key) => _.startsWith(key, 'render-')),
                    context,
                    state: runtime.state
                }
                try {
                    let result
                    switch (renderOptions.options.tasks) {
                        case TASKS.INLINE:
                            renderOptions.logger = logger
                            renderOptions.signal = signal
                            if (!signal.aborted) {
                                result = await render(renderOptions)
                            }
                            break
                        case TASKS.SERIAL:
                            renderOptions.logger = logger
                            renderOptions.signal = signal
                            if (!signal.aborted) {
                                result = await runtime.engine.queue.add(() => render(renderOptions), { signal })
                            }
                            break
                        case TASKS.WORKER:
                            const mc = new MessageChannel();
                            mc.port2.onmessage = event => {
                                const message = JSON.parse(event.data)
                                if (message.command == 'logger') {
                                    runtime.engine.logger[message.data.log](...message.data.args)
                                }
                            }
                            mc.port2.unref()
                            renderOptions.port = mc.port1
                            result = await runtime.engine.renderWorkers.run(
                                renderOptions,
                                { signal, transferList: [mc.port1] }
                            )
                            break
                    }
                    if (!signal.aborted) {
                        entry.output = {
                            success: true,
                            result,
                        }
                        await runtime.complete(entry)
                        await updateEntry({ id, output: entry.output })
                    }

                    logger.debug('Rendered: [%s] %s → %s', options.renderer, entity.name || entity.id, entity.destination)
                } catch (err) {
                    if (!signal.aborted) {
                        await updateEntry({ id, output: { success: false } })
                        logger.error('Render error: %s%s %s', entity.id, formatErrorContext(entity, err, runtime.options), err.message)
                    }
                    logger.debug('Render canceled')
                }
            } else {
                await updateEntry({ id, output: { success: true } })
            }
        }, {
            concurrency: runtime.options.threads,
            signal
        })
        renderJobs.size && logger.info('Rendered: %d', renderJobs.size)
    })

    onAfterRender(async () => {
        const logger = useLogger()
        const manifest = runtime.state.manifest

        // Unlink stale output files for entities deleted in this cycle, and
        // prune them from the manifest. Matches by `entity.id` for direct hits
        // and by `entity.parent` so paginated children (whose id was rewritten
        // via changeExtension) are reclaimed alongside their source.
        for await (let { entity } of useJournal('Manifest cleanup', [OPERATION.DELETE])) {
            for (const [key, value] of manifest) {
                if (value.id === entity.id || value.parent === entity.id) {
                    const filePath = path.join(runtime.options.outputFolder, value.destination)
                    try {
                        await unlink(filePath)
                        logger.debug('Manifest unlinked stale output: %s', value.destination)
                    } catch { }
                    manifest.delete(key)
                }
            }
        }

        // Merge this cycle's successful renders. New ids appear; re-rendered
        // ids overwrite (same key); ids whose destination changed leave the
        // old key as a stale entry — handled by the cleanup pass on next DELETE.
        for await (let { output, entity } of useJournal('Output', [OPERATION.RENDER])) {
            if (output?.success) {
                manifest.set(`${entity.id}:${entity.destination}`, entity)
            }
        }

        const manifestPath = path.join(runtime.options.runtimeFolder, 'render-details.json')
        await writeFile(manifestPath, JSON.stringify(Array.from(manifest.values())), 'utf8')
    })

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
            if (output?.success && options.postprocessor) {
                const ext = await resolveOutputExt(options.postprocessor)
                let destination = changeExtension(entity.destination, ext)

                // cleanUrls renders a non-index page `foo` to
                // `foo/index.html` so the served URL is `/foo/`. A
                // postprocessor that emits a *different* file type (e.g.
                // PDF) shouldn't inherit that clean-URL folder — a
                // downloadable artifact wants to be `foo.pdf`, not
                // `foo/index.pdf`. Collapse the `/index` segment when the
                // produced extension differs from the rendered page's.
                // Genuine index documents (name ends in `index`) keep
                // their path.
                const originExt = path.extname(entity.destination).slice(1)
                const isCleanUrlPage =
                    runtime.config.layouts?.cleanUrls &&
                    !_.endsWith(entity.name, 'index') &&
                    path.basename(entity.destination, path.extname(entity.destination)) === 'index'
                if (ext !== originExt && isCleanUrlPage) {
                    destination = `${path.dirname(entity.destination)}.${ext}`
                }

                tasks.push({
                    entity: {
                        ...entity,
                        origin: entity.destination,
                        destination
                    },
                    options: {
                        postprocessor: options.postprocessor,
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
        const config = _.pickBy(runtime.config, (value, key) => _.startsWith(key, 'post-'))

        const postPlugins = {}
        for (const pluginName of runtime.options.plugins.filter(p => p.startsWith('post-'))) {
            const plugin = await loadPostPlugin(pluginName, runtime.options.workingFolder)
            if (plugin) {
                postPlugins[pluginName] = plugin
                if (plugin.setup) await plugin.setup({ options: runtime.options, config: config[pluginName], state: runtime.state, logger })
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
                        config,
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
                if (plugin.teardown) await plugin.teardown({ options: runtime.options, config: config[pluginName], state: runtime.state, logger })
            }
        }
    })

    onCancel(async () => {
        if (runtime.engine.renderWorkers.queueSize) {
            await new Promise(resolve => {
                runtime.engine.renderWorkers.once('drain', resolve)
            })
        }
    })

    onFinalized(async () => {
        const logger = useLogger()

        const paths = await globby('**/*', { cwd: runtime.options.outputFolder, followSymbolicLinks: false })
        for (let relativePath of paths) {
            let source = path.join(runtime.options.outputFolder, relativePath)
            const linkStat = await lstat(source)
            if (linkStat.isSymbolicLink()) {
                const destination = await realpath(source)
                if (!existsSync(destination)) {
                    await unlink(source)
                }
            }
        }
        logger.notice('Mikser completed')
    })

    onCancelled(async () => {
        const logger = useLogger()
        logger.notice('Mikser restarted')
    })

    console.info('\x1b[1mmikser\x1b[22;5;38;2;255;63;0m.\x1b[0m %s\n', packageInfo.version)
    return runtime
}

export function useLogger() {
    return runtime.engine?.logger
}

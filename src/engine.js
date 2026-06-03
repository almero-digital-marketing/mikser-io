import pino from 'pino'
import path from 'node:path'
import { Command } from 'commander'
import { rm, lstat, realpath, mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import _ from 'lodash'
import Piscina from 'piscina'
import runtime from './runtime.js'
import { onInitialize, onInitialized, onLoad, onRender, onCancel, onCancelled, onFinalized, onLoaded, onAfterRender, onBeforePostprocess, onPostprocess, postprocessEntities } from './lifecycle.js'
import { useJournal, updateEntry } from './journal.js'
import { globby } from 'globby'
import { OPERATION, TASKS } from './constants.js'
import { changeExtension, formatErrorContext } from './utils.js'
import render from './render.js'
import postprocess, { loadPlugin as loadPostPlugin } from './postprocess.js'
import map from 'p-map'
import Queue from 'p-queue'
import packageInfo from '../package.json' with { type: 'json' }

export async function setup(options) {
    runtime.options.threads = options?.threads !== undefined ? options.threads : 4
    runtime.engine = {
        logger: options?.logger || pino({
            transport: {
                target: 'pino-pretty'
            },
        }),
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
            .option('-s --server [port]', 'start an Express server on the given port (defaults to 3001)')
            .option('--cors [origin]', 'restrict server CORS to a specific origin (default *)')
            .option('--no-cors', 'disable server CORS headers')
            .option('--mcp [path]', 'enable MCP server (mounts at <path>, default /mcp)')

        Object.assign(runtime.options, options || runtime.engine.commander.parse(process.argv).opts())
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
        runtime.engine.logger.notice = runtime.engine.logger.info

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

        // Server bring-up: two paths, controlled by which of these are set.
        //
        //   runtime.options.app   — pre-supplied Express app (e.g. mikser
        //                           embedded inside an existing service).
        //                           The caller owns the listen lifecycle
        //                           and the static-route policy. Engine
        //                           stays out of routing/listening so it
        //                           doesn't clobber their setup; plugins
        //                           still mount their own routers on it.
        //
        //   --server [port]       — engine creates the Express app, mounts
        //   (runtime.options.server)  static for the output folder, and
        //                           listens on the port. The actual
        //                           listen() is deferred via the onLoad
        //                           hook below so it runs LAST in the
        //                           onLoaded phase — after every plugin
        //                           has had a chance to register routes.
        //
        // If both are present, the externally-supplied app wins; --server
        // becomes a no-op (the caller is in charge).
        if (runtime.options.app) {
            logger.info('Using externally-supplied Express app on runtime.options.app')
        } else if (runtime.options.server) {
            const { default: express } = await import('express').catch(() => {
                throw new Error('Express is required for --server. Run: npm install express')
            })
            runtime.options.app = express()
            runtime.options.port = runtime.options.server === true
                ? 3001
                : Number(runtime.options.server) || 3001
            logger.info('Server starting on port %d', runtime.options.port)

            // Trust-proxy: when mikser is behind a reverse proxy
            // (nginx, Caddy, an Express app, ngrok with edge), the
            // socket peer is the proxy — not the real client. Setting
            // trust proxy makes Express's req.ip walk X-Forwarded-For
            // back to the original requester, which is what mikser's
            // loopback-only auth check compares against.
            //
            // Accepted values (Express semantics):
            //   true                 — trust every hop (only safe when
            //                          the proxy strips/rewrites
            //                          X-Forwarded-* headers)
            //   'loopback'           — trust 127.0.0.1, ::1, and other
            //                          loopback addresses (correct for
            //                          a proxy on the same host)
            //   '10.0.0.0/8'         — trust a specific subnet
            //   false (default)      — no trust; req.ip == socket peer
            //
            // Without this and behind a proxy, mikser sees every
            // request as coming from the proxy's loopback address and
            // unauthenticated requests through the proxy would pass
            // the loopback gate. The startup warning below catches
            // some of those misconfigurations.
            const trustProxy = runtime.config.server?.trustProxy
            if (trustProxy !== undefined) {
                runtime.options.app.set('trust proxy', trustProxy)
                logger.info('Server trust proxy: %s', String(trustProxy))
            }

            // CORS — a server exists to be fetched, and in dev the
            // frontend is almost always on a different origin (a dev
            // server on another port, a separate domain). So CORS is ON
            // by default with Access-Control-Allow-Origin: *. The token
            // on /api (not CORS) is what gates mutations, and '*' can't
            // carry credentials, so this is low-risk. Pin it down with
            // --cors <origin> / config.server.cors, or disable entirely
            // with --no-cors / config.server.cors:false (recommended for
            // private/admin deployments). Mounted first so it covers
            // static routes and every plugin router.
            // Default on (?? true) so programmatic setup({ server }) —
            // which bypasses commander's --no-cors default — matches the
            // CLI. Explicit false (config or --no-cors) still disables.
            const corsOrigin = runtime.config.server?.cors ?? runtime.options.cors ?? true
            if (corsOrigin) {
                const origin = corsOrigin === true ? '*' : String(corsOrigin)
                runtime.options.app.use((req, res, next) => {
                    res.header('Access-Control-Allow-Origin', origin)
                    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
                    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
                    if (req.method === 'OPTIONS') return res.sendStatus(204)
                    next()
                })
                logger.info('CORS enabled: %s', origin)
            }
        }

        // MCP substrate — same engine-provides-transport, plugins-
        // register-tools shape as Express. See
        // documentation/decisions/0006-when-to-add-to-core.md for
        // the justification. The substrate object is exposed at
        // runtime.options.mcp; plugins use it directly via the SDK
        // (server.registerTool / server.registerResource). The
        // transport is mounted later, after plugin routes have had
        // a chance to register (see the onLoad below that handles
        // static serving + listen).
        if (runtime.options.mcp) {
            try {
                const { createMcpSubstrate, wireLoggerToMcp } = await import('./mcp.js')
                runtime.options.mcpPath = typeof runtime.options.mcp === 'string'
                    ? runtime.options.mcp
                    : '/mcp'
                runtime.options.mcp = createMcpSubstrate()

                // Fan every engine log call out to MCP clients as
                // `notifications/message`. Wraps in-place so the
                // existing logger reference (held by plugins, render
                // workers, useLogger consumers) gains the side-channel
                // automatically — no second logger to thread through.
                wireLoggerToMcp(runtime.engine.logger, runtime.options.mcp)
                logger.info('MCP substrate ready (mounts at %s when server is up)', runtime.options.mcpPath)
            } catch (err) {
                logger.error('Failed to enable MCP: %s', err.message)
            }
        }
    })

    // Registered here (inside setup) so it runs AFTER plugins.js's onLoad
    // (which is registered at module-import time). That ordering matters
    // because plugins.js loads user plugins during its onLoad — each plugin
    // factory may register onLoaded handlers that mount routes on
    // runtime.options.app. We want our listen() to run LAST in the
    // onLoaded phase, which is why we register it from inside another
    // onLoad — by then plugins have already appended their handlers.
    onLoad(() => {
        // Only auto-mount static + auto-listen when the engine owns the
        // app (created via --server). When an external app was supplied,
        // `port` is unset and we stay out of the way — the caller manages
        // both routing decisions and the listen lifecycle themselves.
        if (!runtime.options.app || runtime.options.port == null) return
        onLoaded(async () => {
            const logger = useLogger()
            const { default: express } = await import('express')

            // Mount MCP transport (if active) BEFORE the static
            // catch-all so /mcp isn't swallowed. After this runs the
            // server is fully reachable over HTTP for AI clients.
            if (runtime.options.mcp && runtime.options.mcpPath) {
                const { mountMcpOnExpress } = await import('./mcp.js')
                // mcp.js logs per-endpoint as it mounts — no extra log here.
                await mountMcpOnExpress(runtime.options.app, runtime.options.mcp, runtime.options.mcpPath)
            }

            // Serve the output folder as the catch-all static route.
            // Mounted LAST in the middleware chain so plugin routes
            // (e.g. /api/*) match first; anything that didn't match a
            // plugin's router falls through to the static handler and
            // gets served from <outputFolder>.
            runtime.options.app.use(express.static(runtime.options.outputFolder))
            logger.info('Serving %s at http://localhost:%d/',
                runtime.options.outputFolder.replace(runtime.options.workingFolder + '/', ''),
                runtime.options.port)

            await new Promise(resolve => {
                runtime.options.app.listen(runtime.options.port, () => {
                    logger.info('Server listening: http://localhost:%d', runtime.options.port)
                    resolve()
                })
            })
        })
    })

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
                const renderOptions = {
                    entity,
                    options: {
                        tasks: TASKS.POOL,
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
                        case TASKS.POOL:
                            renderOptions.logger = logger
                            renderOptions.signal = signal
                            if (!signal.aborted) {
                                result = await render(renderOptions)
                            }
                            break
                        case TASKS.QUEUE:
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
                            tasks: TASKS.POOL,
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
                            case TASKS.POOL:
                                postprocessOptions.logger = logger
                                postprocessOptions.signal = signal
                                if (!signal.aborted) {
                                    result = await postprocess(postprocessOptions)
                                }
                                break
                            case TASKS.QUEUE:
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

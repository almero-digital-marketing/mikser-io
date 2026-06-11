import path from 'node:path'
import { Command } from 'commander'
import { rm, lstat, realpath, mkdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import _ from 'lodash'
import Piscina from 'piscina'
import runtime from './runtime.js'
import { onInitialize, onInitialized, onRender, onCancel, onCancelled, onFinalized, onLoaded, onBeforePostprocess, onPostprocess, postprocessEntities } from './lifecycle.js'
import { useJournal, updateEntry } from './journal.js'
import { globby } from 'globby'
import { OPERATION, TASKS } from './constants.js'
import { changeExtension, formatErrorContext, projectMeta, lookupKeys } from './utils.js'
import render from './render.js'
import postprocess, { loadPlugin as loadPostPlugin } from './postprocess.js'
import map from 'p-map'
import Queue from 'p-queue'
import packageInfo from '../package.json' with { type: 'json' }
import { attachServerCliOptions, setupServer } from './server.js'
import { createMikserLogger } from './logger.js'
import { inputHashOf } from './utils.js'
import { createTrack } from './track.js'
import { queryContext } from './database/query-context.js'

// Build a structuredClone-safe copy of runtime.options for WORKER
// dispatch. Plugin surfaces live under `runtime.options.<plugin>` per
// the engine's namespacing convention and routinely hold functions
// (e.g. `runtime.options.layouts.inspect`, `runtime.options.preview.get`)
// — those don't cross thread boundaries via Piscina's structured clone.
//
// Per-key probe: anything that survives `structuredClone(value)` passes
// through; anything that throws (DataCloneError on functions/handles/
// errors with non-cloneable cause chains) is dropped. Engine fields
// (workingFolder, outputFolder, threads, info, debug, ...) are all
// primitives and pass through untouched. Plugin function surfaces drop
// out — workers don't need them; they have access to the catalog via
// their own sqlite handle and call back into the engine via the IPC
// port for logging.
function workerSafeOptions(opts) {
    const result = {}
    for (const [k, v] of Object.entries(opts)) {
        try {
            structuredClone(v)
            result[k] = v
        } catch { /* not cloneable — skip */ }
    }
    return result
}

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
        // Lazily-allocated worker pools. Render and postprocess both
        // default to INLINE; Piscina only matters when a layout opts
        // into TASKS.WORKER (`task: 'worker'`). minThreads: 0 prevents
        // Piscina from pre-spawning workers at construction time —
        // INLINE-only workloads pay zero worker cost. idleTimeout
        // unspawns workers that have sat idle, so transient bursts of
        // WORKER tasks don't leave threads alive for the rest of the
        // build.
        //
        // Separate pools for render and postprocess: a long PDF
        // postprocess shouldn't starve render dispatch (or vice versa),
        // and the two have very different per-task profiles
        // (renders ~μs-ms, postprocess often hundreds of ms).
        renderWorkers: new Piscina({
            filename: new URL('./render.js', import.meta.url).href,
            maxThreads: runtime.options.threads,
            minThreads: 0,
            idleTimeout: 30_000,
        }),
        postprocessWorkers: new Piscina({
            filename: new URL('./postprocess.js', import.meta.url).href,
            maxThreads: runtime.options.threads,
            minThreads: 0,
            idleTimeout: 30_000,
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
            .option('-f --force', 'rebuild everything; disable incremental dispatch', false)
            .option('-R --resume', 'continue from journal entries left by a previous interrupted run; skip the initial filesystem scan', false)
            .option('--verify', 'verify output folder against manifest; report drift instead of building', false)
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

        // --verify is a standalone read-only mode. Manifest has already
        // loaded in its own onLoaded (registered earlier at module
        // import). We diff disk against snapshots, print the report,
        // and exit. No build phases run.
        //
        // Exit codes match common CI conventions:
        //   0 — clean (output matches manifest exactly)
        //   1 — warnings (orphan files or unverifiable entries — no
        //                 corruption, but state is messy)
        //   2 — errors   (missing or mismatched files — output is
        //                 actually wrong on disk)
        if (runtime.options.verify) {
            if (!runtime.manifest) {
                logger.error('Verify: no manifest available — nothing to check against')
                process.exit(2)
            }
            const diff = await runtime.manifest.verify()
            const { missing, mismatched, unverifiable, orphaned } = diff

            const total = runtime.manifest.size()
            const errors = missing.length + mismatched.length
            const warnings = orphaned.length + unverifiable.length

            for (const e of missing)     logger.error('Missing:    %s (entity %s)', e.destination, e.id)
            for (const e of mismatched)  logger.error('Mismatched: %s (entity %s)', e.destination, e.id)
            for (const e of unverifiable) logger.warn('No hash:    %s (entity %s)', e.destination, e.id)
            for (const e of orphaned)    logger.warn('Orphan:     %s', e.path)

            const verdict = errors > 0 ? 'FAIL' : (warnings > 0 ? 'WARN' : 'OK')
            logger.notice('Verify %s: %d snapshots, %d missing, %d mismatched, %d unverifiable, %d orphaned',
                verdict, total, missing.length, mismatched.length, unverifiable.length, orphaned.length)
            process.exit(errors > 0 ? 2 : (warnings > 0 ? 1 : 0))
        }
    })

    onRender(async (signal) => {
        const logger = useLogger()
        const renderJobs = new Set()
        // Computed once per cycle — runtime.config doesn't mutate
        // mid-cycle, so every render gets the same filtered slice.
        // Native key iteration + String#startsWith; was a per-render
        // `_.pickBy(runtime.config, (v,k) => _.startsWith(k,'render-'))`
        // which charged ~20 predicate calls + 1 object allocation per
        // entry. Symmetric with onPostprocess's `config` below.
        const renderConfig = {}
        for (const key in runtime.config) {
            if (key.startsWith('render-')) renderConfig[key] = runtime.config[key]
        }

        // Collect this cycle's mutated entity ids/hrefs/entities so the
        // manifest skip check can re-render anything whose dependencies
        // (layout, partials, $-refs, catalog queries) changed even if
        // the entity itself is byte-identical. Built once from this
        // cycle's CREATE/UPDATE/DELETE journal entries — RENDER entries
        // are this cycle's work, not the trigger.
        //
        // - `mutatedRefs` is a Map<key, Set<lang|null>>: the keys are
        //   the ids / hrefs / id-minus-extension forms a refClosure
        //   entry might target; the values are the set of languages
        //   that touched that key this cycle (null for entities with
        //   no meta.lang). The Map shape preserves the fast `.has(key)`
        //   membership check the existing skip logic relied on AND
        //   adds language information so multilingual sites don't
        //   over-invalidate. When a French author entity changes,
        //   English posts that reference the same /authors/<name>
        //   href don't re-render — the lang sets disagree.
        // - `currentHashes` carries the current input hash for each
        //   mutated entity. Cold-start file discovery emits CREATE for
        //   every file even when content didn't change; without the
        //   hash gate, every render whose dep appears in the journal
        //   would falsely invalidate.
        // - `mutatedEntities` carries the entity payloads themselves so
        //   the query-match check can call `sift(filter)` against each
        //   mutation to decide whether a stored query dep is hit.
        const mutatedRefs = new Map()
        const currentHashes = new Map()
        const mutatedEntities = new Map()
        for await (let { entity, operation } of useJournal('Manifest mutations', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE])) {
            if (!entity?.id) continue
            mutatedEntities.set(entity.id, entity)
            const hash = operation === OPERATION.DELETE ? null : inputHashOf(entity)
            const lang = entity.meta?.lang ?? null
            // Expand the mutated entity into every form a refClosure
            // entry might target — id, meta.href, AND id-minus-extension
            // — via lookupKeys. Without the stripped form, a refClosure
            // recorded against the natural author/blog-post pattern
            // (`$author: /documents/authors/dick`) would never match
            // the mutated `/documents/authors/dick.yml` here and
            // manifest.shouldSkip would silently return true, pinning
            // the post's output to bytes that reference stale author
            // data. refs.inverseClosureOf and catalog.findEntity both
            // use the same extension-tolerant resolution; the manifest
            // layer has to match.
            //
            // Each key carries the language tag of the mutation so
            // shouldSkip can constrain by language compatibility.
            //
            // For DELETE we set `null` as the current hash so manifest.
            // shouldSkip can distinguish "target was deleted from the
            // catalog" from "target wasn't in this cycle's mutations
            // at all." Without this distinction, a consumer whose
            // refClosure points at a deleted partial/layout would
            // silently skip re-rendering.
            for (const key of lookupKeys(entity)) {
                if (!mutatedRefs.has(key)) mutatedRefs.set(key, new Set())
                mutatedRefs.get(key).add(lang)
                currentHashes.set(key, hash)
            }
        }
        let skipped = 0

        await map(useJournal('Rendering', [OPERATION.RENDER], signal), async entry => {
            const { id, entity, options, context } = entry
            const jobId = entity.id + ':' + entity.destination
            if (!renderJobs.has(jobId) && !options.ignore) {
                renderJobs.add(jobId)

                // Manifest skip: prior snapshot exists, inputHash and
                // layoutHash match, no ref-target mutated this cycle.
                // Disabled when a postprocessor is configured because
                // postprocessors typically consume the intermediate
                // rendered file (post-pdf, post-mjml). Skipping the
                // render leaves the postprocess input missing on the
                // next run. A postprocess-aware manifest that also
                // skips when the postprocess output is current would
                // close the gap — not yet implemented.
                if (!options.postprocessor && runtime.manifest?.shouldSkip(entity, mutatedRefs, currentHashes, mutatedEntities)) {
                    skipped++
                    entry.output = { success: true, skipped: 'manifest' }
                    await updateEntry({ id, output: entry.output })
                    logger.debug('Manifest skip: %s → %s', entity.name || entity.id, entity.destination)
                    return
                }
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
                // Per-render dep tracker — partials reported by the
                // renderer plugin's partial-loading hooks, queries
                // reported automatically by catalog methods via the
                // queryContext ALS established below. Worker dispatch
                // can't share this object across thread boundaries —
                // those renders get layout-only deps (added by
                // manifest.collectEdges) and rely on coarser
                // invalidation. INLINE is the default mode.
                const track = createTrack()
                const renderOptions = {
                    entity: renderEntity,
                    options: {
                        tasks: TASKS.INLINE,
                        ...runtime.options,
                        ...options,
                    },
                    config: renderConfig,
                    context,
                    state: runtime.state,
                    track,
                }
                try {
                    let result
                    // Wrap the dispatch in the queryContext so catalog
                    // queries called anywhere inside the render (renderer
                    // plugin, layout sidecar, helper functions) report
                    // their filters to the track object automatically.
                    // INLINE/SERIAL inherit the ALS through await
                    // boundaries; WORKER mode crosses a thread boundary
                    // so its renders don't pick up the context — they
                    // fall back to layout-only deps.
                    result = await queryContext.run({ entityId: entity.id, track }, async () => {
                        switch (renderOptions.options.tasks) {
                            case TASKS.INLINE:
                                renderOptions.logger = logger
                                renderOptions.signal = signal
                                if (!signal.aborted) {
                                    return await render(renderOptions)
                                }
                                return undefined
                            case TASKS.SERIAL:
                                renderOptions.logger = logger
                                renderOptions.signal = signal
                                if (!signal.aborted) {
                                    return await runtime.engine.queue.add(() => render(renderOptions), { signal })
                                }
                                return undefined
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
                                // Strip plugin-surface functions
                                // (runtime.options.layouts.inspect, etc.) so
                                // Piscina's structured clone doesn't choke on
                                // them. Engine-side primitives pass through;
                                // plugin surfaces are reachable via the
                                // worker's own sqlite handle or by IPC over
                                // the port.
                                renderOptions.options = {
                                    ...workerSafeOptions(runtime.options),
                                    tasks: renderOptions.options.tasks,
                                    ...options,
                                }
                                // Track is a closure object — its .partial /
                                // .query methods can't cross thread
                                // boundaries. Workers fall back to
                                // layout-only deps (added by
                                // manifest.collectEdges), so drop the track
                                // entirely before dispatch.
                                renderOptions.track = undefined
                                return await runtime.engine.renderWorkers.run(
                                    renderOptions,
                                    { signal, transferList: [mc.port1] }
                                )
                        }
                    })
                    if (!signal.aborted) {
                        entry.output = {
                            success: true,
                            result,
                        }
                        // Manifest owns the refClosure schema; we just
                        // hand it the entity, the track, and the sidecar
                        // queries (collected at layouts.onBeforeRender
                        // inside queryContext). collectEdges adds the
                        // auto-layout edge, hashes track.partials via
                        // catalog lookup, and merges template-time +
                        // sidecar queries.
                        const edges = runtime.manifest.collectEdges({
                            entity,
                            track,
                            sidecarQueries: context?.sidecarQueries,
                        })
                        entry.deps = edges
                        // Pagination produces synthetic pageEntities
                        // (index.2.html, index.3.html, ...) whose ids
                        // are NOT in mikser_entities — they exist only
                        // at render time. Roll their dynamic refs up to
                        // entity.parent (set by layouts.onBeforeRender
                        // for pages 2+) so the mikser_refs FK to
                        // mikser_entities holds. The parent's own
                        // render also writes to the same source_id;
                        // INSERT OR IGNORE in stmtInsertEdge handles the
                        // dedup across pages. Invalidation re-dispatches
                        // the parent and the pagination expansion
                        // produces the children from there, so granular
                        // per-page refs aren't needed.
                        runtime.refs?.replaceDynamic(entity.parent ?? entity.id, edges)
                        await runtime.complete(entry)
                        await updateEntry({ id, output: entry.output, deps: edges })
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
        renderJobs.size && logger.info('Rendered: %d', renderJobs.size - skipped)
        skipped && logger.info('Manifest skipped: %d', skipped)
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
                                mc.port2.onmessage = event => {
                                    const message = JSON.parse(event.data)
                                    if (message.command == 'logger') {
                                        runtime.engine.logger[message.data.log](...message.data.args)
                                    }
                                }
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
        if (runtime.engine.postprocessWorkers.queueSize) {
            await new Promise(resolve => {
                runtime.engine.postprocessWorkers.once('drain', resolve)
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

import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import _ from 'lodash'
import Database from 'better-sqlite3'
import { useLogger } from './engine.js'
import { formatLogArgs } from './utils.js'
import engineRuntime from './runtime.js'

// Worker-side sqlite handle. Opened lazily on first render task (we
// only know the workingFolder/runtimeFolder once we receive a task —
// Piscina workers don't have engine state at bootstrap). Read-only +
// WAL means workers don't block the engine's writer; concurrent workers
// don't block each other.
//
// One connection per worker thread. The whole engine catalog stays on
// disk; workers query exactly what their render touches via prepared
// statements. Replaces the prior "engine ships state.layouts.sitemap
// over the wire per render task" path — that was reserializing the
// entire sitemap (potentially 100MB+ at 14k entities) for every Piscina
// dispatch.
let workerDb = null
let stmtHrefLookup = null
let stmtIdLookup = null

function ensureWorkerDb(options) {
    if (workerDb) return
    const dbPath = path.join(options.runtimeFolder, 'mikser.sqlite')
    workerDb = new Database(dbPath, { readonly: true, fileMustExist: true })
    // No-op if the engine already set it; better-sqlite3 wants the
    // setting once for WAL-mode consistency with the writer.
    workerDb.pragma('journal_mode = WAL')
    // Read-only consumers only need the JSON body. meta_href is
    // indexed in mikser_entities; one row per (href, lang) tuple.
    stmtHrefLookup = workerDb.prepare(
        'SELECT data FROM mikser_entities WHERE meta_href = ?',
    )
    // By id (PK) — for lookupUrl resolving a served-entity reference to
    // its deployed URL (ADR-0011).
    stmtIdLookup = workerDb.prepare(
        'SELECT data FROM mikser_entities WHERE id = ?',
    )
}

// Match the legacy `state.layouts.sitemap[href]` return shape:
//   - 0 hits  → undefined
//   - 1 hit, no lang → the entity directly (callers test for `.id`)
//   - 1 hit, with lang → { [lang]: entity }
//   - N hits → { lang: entity, ... } (lang variants)
// href.js's runtime.href helper then unwraps either form.
function lookupHrefViaDb(href) {
    const rows = stmtHrefLookup.all(href)
    if (rows.length === 0) return undefined
    if (rows.length === 1) {
        const entity = JSON.parse(rows[0].data)
        if (!entity.meta?.lang) return entity
        return { [entity.meta.lang]: entity }
    }
    const result = {}
    for (const row of rows) {
        const entity = JSON.parse(row.data)
        result[entity.meta?.lang ?? 'default'] = entity
    }
    return result
}

// Resolve a served-entity reference (its id) to a deployed URL for render
// output (ADR-0011). Renders project-but-don't-expand, so a template that
// needs an asset's URL resolves the ref here:
//   {{ lookupUrl meta.image }}           → served path
//   {{ lookupUrl meta.video 'poster' }}  → a preset derivative
// `origin` (runtime.options.url) makes it absolute so static outputs —
// emails, feeds — carry a whole URL; absent, it stays base-relative.
// Unresolved refs return unchanged, staying visible like lookupHref.
function lookupUrlViaDb(ref, preset, origin) {
    if (typeof ref !== 'string') return ref
    const row = stmtIdLookup.get(ref)
    if (!row) return ref
    const meta = JSON.parse(row.data).meta || {}
    // A template helper called with one arg still receives the renderer's
    // options/hash object as the second — only treat a string as a preset.
    const rel = typeof preset === 'string' ? meta.presets?.[preset] : meta.url
    if (!rel) return ref
    return origin ? origin + rel : rel
}

export default async ({ entity, options, config, context, state, logger, port, track }) => {
    logger = logger || {
        info(...args) {
            port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'info', args } }))
        },
        warn(...args) {
            port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'warn', args } }))
        },
        error(...args) {
            port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'error', args } }))
        },
        trace(...args) {
            port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'trace', args } }))
        },
        notice(...args) {
            port.postMessage(JSON.stringify({ command: 'logger', data: { log: 'notice', args } }))
        }
    }

    async function loadPlugin(pluginName) {
        // v9: check the runtime registry first. Renderers / postprocessors
        // that came through `plugins: [renderHbs(), ...]` were stored at
        // onLoad keyed by their descriptor name (e.g. 'hbs'). Strip the
        // 'render-' prefix to match the registry key. Workers see an
        // empty registry (separate process, separate runtime singleton)
        // and fall through to the dynamic-import path below.
        const stripped = pluginName.replace(/^render-/, '')
        const registered = engineRuntime.renderers?.get(stripped)
        if (registered) return registered

        const require = createRequire(path.join(options.workingFolder, 'package.json'))
        let nodeModulesResolved
        try {
            nodeModulesResolved = require.resolve(`mikser-io-${pluginName}`)
        } catch { /* package not installed at this level — fine, try next */ }

        const resolveLocations = [
            path.join(options.workingFolder, 'node_modules', `mikser-io-${pluginName}/index.js`),
            nodeModulesResolved,
            path.join(options.workingFolder, 'plugins', `${pluginName}.js`),
            path.join(path.dirname(import.meta.url), 'plugins', 'render', `${pluginName.replace('render-', '')}.js`)
        ].filter(Boolean)

        for (let resolveLocation of resolveLocations) {
            // Existence-check first: once we know the plugin file is there,
            // any subsequent ERR_MODULE_NOT_FOUND is a *transitive* dep
            // missing (e.g. plugin imports a package that isn't installed),
            // not a "this plugin isn't here, try the next path" signal.
            if (!existsSync(resolveLocation.replace(/^file:/, ''))) continue
            try {
                return await import(resolveLocation)
            } catch (err) {
                if (err.code === 'ERR_MODULE_NOT_FOUND') {
                    logger.error('Render plugin %s found at %s but its dependencies are missing: %s', pluginName, resolveLocation, err.message)
                } else {
                    logger.error('Render plugin %s failed to load (%s): %s', pluginName, resolveLocation, err.message)
                }
                throw err
            }
        }

        logger.error('Render plugin %s not found.', pluginName)
    }

    const { renderer } = options
    const plugins = {}
    let pluginsToLoad = [...context.plugins || []]
    pluginsToLoad.push(`render-${renderer}`)
    if (entity.meta?.plugins) {
        pluginsToLoad.push(...entity.meta.plugins)
    }
    pluginsToLoad.push(...options.plugins)
    // `context.plugins` and `entity.meta.plugins` carry string
    // identifiers (frontmatter `plugins: ['render-href']` etc.).
    // `options.plugins` carries factory-return values from the
    // top-level config; renderer descriptors are projected to their
    // identifier here. Lifecycle plugins (functions) and
    // postprocessor descriptors get filtered out — the renderer path
    // only cares about renderer-shaped entries.
    pluginsToLoad = _.uniq(pluginsToLoad
        .map(p => {
            if (typeof p === 'string') return p
            if (p && typeof p === 'object' && (typeof p.load === 'function' || typeof p.render === 'function')) {
                return `render-${p.name}`
            }
            return null
        })
        .filter(p => p && p.indexOf('render-') == 0))

    ensureWorkerDb(options)

    const runtime = {
        [entity.type]: entity,
        entity,
        plugins,
        config: config[`render-${renderer}`],
        data: context.data,
        // Worker-side catalog lookup by href. Replaces the previous
        // state.layouts.sitemap map that was serialized per render
        // task. Goes through the same WAL-backed read-only handle
        // every worker shares with the engine writer.
        lookupHref: lookupHrefViaDb,
        // Resolve a served-entity reference to its deployed URL, absolute
        // when runtime.options.url is set (ADR-0011).
        lookupUrl: (ref, preset) => lookupUrlViaDb(ref, preset, options.url),
        content() {
            return readFileSync(entity.source, { encoding: 'utf8' })
        },
        // Logger functions are exposed directly so each renderer's
        // auto-helper loop picks them up are picked up; falls back to the local `logger` in
        // worker contexts where the engine singleton isn't initialised.
        //
        // Args are flattened into a single space-separated message so
        // every value the template passed shows up — pino otherwise drops
        // trailing positional args unless the first contains %s/%d format
        // specifiers. Handlebars appends an internal options object as
        // the last arg, which we strip before joining.
        log: (...args) => (useLogger() ?? logger).info(formatLogArgs(args)),
        warn: (...args) => (useLogger() ?? logger).warn(formatLogArgs(args)),
        error: (...args) => (useLogger() ?? logger).error(formatLogArgs(args)),
        debug: (...args) => (useLogger() ?? logger).debug(formatLogArgs(args)),
        trace: (...args) => (useLogger() ?? logger).trace(formatLogArgs(args)),
    }

    for (let pluginName of pluginsToLoad) {
        const plugin = await loadPlugin(pluginName)
        plugins[pluginName] = plugin
        if (plugin?.load) await plugin.load({ entity, options, config: plugin.options, context, runtime, state, logger })
    }

    const rendererPlugin = plugins[`render-${renderer}`]
    return await rendererPlugin?.render({ entity, options, config: rendererPlugin?.options, context, plugins, runtime, state, logger, track })
}

// Build the error thrown when a submitted entity goes through a full
// process cycle but never renders. useRenderer can't see *why* — by the
// time it gives up, the journal is cleared — but it knows what it
// submitted, so it branches on whether a layout was even requested and
// points at the log line carrying the authoritative reason (the layouts
// plugin warns when a render-requested entity matches no layout).
//
// `.status = 422` (Unprocessable Entity): the request was well-formed
// but the entity can't be rendered as submitted. The API endpoint reads
// err.status (defaulting to 500) so a no-layout render returns a client
// error, not a server fault.
function incompleteRenderError(entity) {
    const id = entity?.id ?? '<unknown>'
    const msg = entity?.meta?.layout
        ? `Render did not complete for ${id}: it requested layout "${entity.meta.layout}" ` +
          `but produced no output. Check the log for a "Layout not found" warning (the name ` +
          `may not exist) or a "Render error" (the layout matched but threw).`
        : `Render did not complete for ${id}: the entity has no meta.layout and matched no ` +
          `layout, so nothing rendered it. Set meta.layout, add a layouts.match rule, or name ` +
          `it to match a layout (auto-layout).`
    const err = new Error(msg)
    err.status = 422
    return err
}

/**
 * Bind to the runtime and return an on-demand renderer that pipelines
 * concurrent calls into the minimum number of `runtime.process()` cycles.
 * The returned binding is stateful — each call to useRenderer() owns its
 * own pending queue and `completed`-hook lifecycle. Mount once per
 * consumer (the API plugin mounts one; a library service mounts its own).
 *
 * @example
 *   const { render } = useRenderer(runtime)
 *   const { output, entity } = await render(entityShape)
 *
 * @param {object} runtime                  - the mikser runtime singleton
 * @param {object} [opts]
 * @param {number} [opts.defaultTimeout]    - per-render timeout in ms (default 30_000)
 * @returns {{ render: (entity, { timeout? }?) => Promise<{ output, entity }> }}
 */
export function useRenderer(runtime, { defaultTimeout = 30_000 } = {}) {
    let pending = []
    let cycleRunning = false

    async function runBatch() {
        if (cycleRunning || pending.length === 0) return
        cycleRunning = true

        const batch = pending
        pending = []

        const remaining = new Map(batch.map(b => [b.correlationId, b]))
        const completedHooks = runtime.hooks.completed
        const hook = async (entry) => {
            const cid = entry.entity?.options?.correlationId
            if (!cid) return
            const item = remaining.get(cid)
            if (!item) return
            // Only resolve on the FINAL completion. For postprocessor-
            // equipped entities the engine fires runtime.complete twice:
            // once after render (intermediate bytes, entity.origin not
            // set) and once after postprocess (final bytes, entity.origin
            // set to the intermediate destination). useRenderer's
            // contract is "return the pipeline's final output", so we
            // skip the intermediate fire and wait for the final.
            const hasPostprocessor = entry.entity?.layout?.postprocessor
            const isFinal = !hasPostprocessor || entry.entity?.origin != null
            if (!isFinal) return
            remaining.delete(cid)
            clearTimeout(item.timer)
            item.resolve({ output: entry.output, entity: entry.entity })
        }
        completedHooks.push(hook)

        for (const item of batch) {
            item.timer = setTimeout(() => {
                if (remaining.delete(item.correlationId)) {
                    item.reject(new Error(`Render timeout for ${item.entity.id}`))
                }
            }, item.timeout)
        }

        try {
            for (const item of batch) {
                await runtime.update(item.entity).catch(item.reject)
            }
            await runtime.process()
        } catch (err) {
            for (const item of remaining.values()) {
                clearTimeout(item.timer)
                item.reject(err)
            }
            remaining.clear()
        } finally {
            for (const item of remaining.values()) {
                clearTimeout(item.timer)
                item.reject(incompleteRenderError(item.entity))
            }
            const idx = completedHooks.indexOf(hook)
            if (idx >= 0) completedHooks.splice(idx, 1)
            cycleRunning = false
            if (pending.length) setImmediate(runBatch)
        }
    }

    /**
     * Submit an entity for rendering. Resolves with `{ output, entity }`
     * where `output.result` is whatever the renderer/postprocessor returned
     * (a string for HTML/text outputs, a Buffer for PDFs, etc.).
     *
     * Requests arriving concurrently are coalesced into the next available
     * `runtime.process()` cycle — within that cycle, mikser's worker pool
     * renders the batch in parallel.
     *
     * Two control flags mirror mikser's default-keep-everything behavior;
     * both opt-out via strict `=== false`:
     *
     * - `catalog: true` (default) — keep the entity in the catalog after
     *   the render. Pass `catalog: false` to prune the catalog row;
     *   useful for on-demand renders where the metadata row would just
     *   accumulate.
     * - `save: true` (default) — write the rendered output to disk at
     *   `<outputFolder>/<entity.destination>`. Pass `save: false` to
     *   skip the final disk write; the bytes still come back via
     *   `output.result` for you to pipe wherever you want (HTTP
     *   response, S3, …). For layouts with a postprocessor (e.g.
     *   `*.html-pdf.*`), the intermediate is written to a scratch path
     *   under `runtime.options.previewFolder` (engine-owned, never
     *   in outputFolder) so the postprocessor can consume it; only
     *   the FINAL output is skipped from disk. `output.result` is
     *   always the FINAL pipeline output — PDF bytes for a
     *   `*.html-pdf.*` layout, MJML-derived HTML for
     *   `*.html-mjml.*`, etc., not the intermediate.
     *
     * The rendered output's bytes are always returned in `output.result`
     * regardless of either flag — `save` only affects whether they also
     * end up on disk.
     *
     * Per-entity engine state (correlation id, control flags) lives at
     * `entity.options.*` — same noun mikser uses for engine config
     * (`runtime.options`) and plugin params, scoped to one entity's
     * pass through the lifecycle. Consumers should not set
     * `entity.options.correlationId` themselves; useRenderer owns it.
     *
     * @param {object} entity                - any entity-shaped object
     * @param {object} [opts]
     * @param {number}  [opts.timeout]       - override the default timeout
     * @param {boolean} [opts.catalog=true]  - keep the catalog row after render
     * @param {boolean} [opts.save=true]     - write the rendered output to disk
     * @returns {Promise<{output, entity}>}
     */
    async function render(entity, { timeout = defaultTimeout, catalog = true, save = true } = {}) {
        const result = await new Promise((resolve, reject) => {
            const correlationId = randomUUID()
            // Engine-set fields live under entity.options. The caller's
            // render(entity, { save: false }) becomes
            // entity.options.save = false here — same noun mikser uses
            // for engine config (runtime.options) and plugin params,
            // just scoped to one entity's pass through the lifecycle.
            //
            // Only set `save` when explicitly opting out — leaves the
            // entity.options as a clean { correlationId } in the common
            // case rather than carrying a redundant save:true.
            const prepared = {
                ...entity,
                options: {
                    ...entity.options,
                    correlationId,
                    ...(save === false ? { save: false } : {}),
                },
            }
            pending.push({
                entity: prepared,
                correlationId,
                timeout,
                resolve,
                reject,
                timer: null,
            })
            if (!cycleRunning) setImmediate(runBatch)
        })

        if (catalog === false) {
            // Explicit opt-out: prune the catalog row so it doesn't
            // accumulate. The rendered output file stays on disk — the
            // bytes are the work product. We deliberately bypass the
            // journal/DELETE path here (which would also unlink the file
            // via the manifest module's cleanup) and splice the entity
            // out of the in-memory catalog directly. Strict equality so
            // ambiguous inputs (null, "false", 0) fall through to the
            // default of keeping the row.
            const entities = runtime.catalog?.data?.entities
            if (entities) {
                const idx = entities.findIndex(e => e.id === result.entity.id)
                if (idx >= 0) entities.splice(idx, 1)
            }
        }

        return result
    }

    return { render }
}
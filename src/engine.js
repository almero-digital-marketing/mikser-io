import path from 'node:path'
import { Command } from 'commander'
import { rm, lstat, realpath, mkdir, unlink, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import _ from 'lodash'
import Piscina from 'piscina'
import runtime from './runtime.js'
import { onInitialize, onInitialized, onLoad, onImport, onRender, onCancel, onCancelled, onFinalized, onLoaded, onBeforePostprocess, onPostprocess, postprocessEntities } from './lifecycle.js'
import { instanceControl } from './instance.js'
import { useJournal, updateEntry } from './journal.js'
import { globby } from 'globby'
import { OPERATION, TASKS } from './constants.js'
import { changeExtension, formatErrorContext, projectMeta, lookupKeys } from './utils.js'
import { reportRendered, reportSkipped, reportError, renderErrorCount, emitReport, finishCycle, reportAssetUse, assetUse } from './report.js'
import { checkReferences } from './references.js'
import { toolSchemas, invokeTool, toolResultText, toolResultFailed } from './tools.js'
import { registerBuiltinTools } from './builtin-tools.js'
import { useDatabase } from './database/index.js'
import render from './render.js'
import postprocess, { loadPlugin as loadPostPlugin } from './postprocess.js'
import map from 'p-map'
import Queue from 'p-queue'
import packageInfo from '../package.json' with { type: 'json' }
import { attachServerCliOptions, setupServer } from './server.js'
import { createMikserLogger } from './logger.js'
import { inputHashOf } from './utils.js'
import { createTrack, mergeTrack } from './track.js'
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
// The parent half of the worker IPC port, shared by the render and
// postprocess paths because they carry the same traffic.
//
// A worker is a separate thread with its own runtime singleton, so it cannot
// reach `runtime.state.report`. It does not need to: `logger` is the only
// passenger, and re-emitting a worker's record here puts it through the parent's
// own streams — including the one the report reads. A warning raised inside a
// render therefore lands in the report by the same route as its message reaches
// the terminal, with no second channel to keep in step.
function workerMessages() {
    return event => {
        const message = JSON.parse(event.data)
        switch (message.command) {
            case 'logger':
                runtime.engine.logger[message.data.log](...message.data.args)
                break
        }
    }
}

function workerSafeOptions(opts) {
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

// Warn for anything the EMITTED output points at that is not there.
//
// Complements the helper-call check below rather than repeating it: this reads
// what shipped, so it also sees paths written by hand, and it resolves them the
// way a browser does, which is the only way to see a url that works solely
// because a `..` run was floored at the site root.
//
// A floored url is not broken today. It is the same markup one level deeper
// away from being broken, and it means the emitted depth does not match the
// page — so it is reported separately rather than folded in with the failures.
//
// Warn, never fail: a missing asset must not stop a dev server. Both lists
// carry stable codes into `--json` so a deploy script can decide for itself.
// Returns the set of broken targets so the helper-call check can skip them.
async function reportBrokenReferences(logger) {
    const outputFolder = runtime.options.outputFolder
    if (!outputFolder || !existsSync(outputFolder)) return new Set()

    const siteRoots = runtime.config?.siteRoots ?? []
    const { broken, overDeep, checked } = await checkReferences(outputFolder, { siteRoots })
    if (!checked) return new Set()

    const SHOWN = 10
    const named = (files) =>
        files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '')

    for (const { url, target, files } of broken.slice(0, SHOWN)) {
        logger.warn({ code: 'reference-broken', url, target, files },
            'Resolves to nothing: %s (from %s) — %s', url, named(files), target)
    }
    if (broken.length) {
        logger.warn({ code: 'reference-broken-summary', broken: broken.length, checked },
            '%d of %d reference(s) in the output resolve to nothing%s. A URL helper builds the '
            + 'path rather than looking it up, so these are links to files nothing produced.',
            broken.length, checked, broken.length > SHOWN ? `, ${SHOWN} shown` : '')
    }

    // Grouped by how FAR each climbed, because a site whose every over-deep url
    // climbs the same distance does not have N problems — it has one base that
    // is off by a constant. Printing it N times is precisely how a real signal
    // gets filtered out, which is the failure this check exists to prevent.
    const byClimb = new Map()
    for (const entry of overDeep) {
        if (!byClimb.has(entry.floored)) byClimb.set(entry.floored, [])
        byClimb.get(entry.floored).push(entry)
    }
    // One distance, many urls: structural. The helper's base is wrong, the urls
    // are not — they load at every depth, because the climb is always floored.
    // That wants a different reaction than a hand-written `../..` that happens
    // to be right on one page and is a 404 waiting on the next.
    const structural = byClimb.size === 1 && overDeep.length > 1

    for (const [climb, entries] of [...byClimb].sort(([a], [b]) => a - b)) {
        const examples = entries.slice(0, 3).map(e => e.url)
        logger.warn(
            {
                code: 'reference-over-deep', climbs: climb, count: entries.length,
                structural, urls: examples,
                files: [...new Set(entries.flatMap(e => e.files))].slice(0, 3),
            },
            structural
                ? '%d references climb %d level(s) above the site root — every one of them, by the '
                  + 'same amount. They load: a browser discards the extra `..`. What is wrong is the '
                  + 'base they were built from, not the links. Examples: %s'
                : '%d reference(s) climb %d level(s) above the site root and load only because a '
                  + 'browser discards the extra `..`. Each breaks if the same markup renders one '
                  + 'level deeper. Examples: %s',
            entries.length, climb, examples.join(', '))
    }

    if (overDeep.length) {
        logger.warn({ code: 'reference-over-deep-summary', overDeep: overDeep.length, checked, structural },
            '%d of %d reference(s) resolve above the site root.%s',
            overDeep.length, checked,
            siteRoots.length ? '' : ' No siteRoots are declared, so this resolved against the output '
                + 'root — declare siteRoots if a subtree is deployed as its own domain.')
    }

    return new Set(broken.map(b => b.target))
}

// Warn for anything a render linked to that is not in the output.
//
// Deliberately phrased as what was OBSERVED. Only entities that rendered this
// cycle recorded anything, so an incremental build checks the pages it built
// and says nothing about the rest — the same reasoning the assets plugin
// already applies to its preset warning, and for the same reason: a warning
// that overclaims gets filtered, and the filtered-out line is the real one.
async function reportMissingAssets(logger, alreadyReported = new Set()) {
    const used = assetUse()
    if (!used.length) return
    const outputFolder = runtime.options.outputFolder
    if (!outputFolder) return

    const missing = []
    for (const [destination, ids] of used) {
        const file = path.join(outputFolder, destination.replace(/^\//, ''))
        // The output scan resolves the same file the way a browser does and
        // names the pages that link it, which is strictly more useful. Where
        // both would fire, one warning is enough.
        if (alreadyReported.has(destination.replace(/^\//, ''))) continue
        if (!existsSync(file)) missing.push([destination, ids])
    }
    if (!missing.length) return

    // Capped, with the total alongside. One broken preset can be referenced by
    // every page on the site, and a thousand lines of it buries whatever else
    // the build said.
    const SHOWN = 10
    for (const [destination, ids] of missing.slice(0, SHOWN)) {
        logger.warn({ code: 'asset-missing', destination, referencedBy: ids },
            'Linked but not in the output: %s — referenced by %s', destination,
            ids.slice(0, 3).join(', ') + (ids.length > 3 ? ` and ${ids.length - 3} more` : ''))
    }
    logger.warn({ code: 'asset-missing-summary', missing: missing.length, checked: used.length },
        '%d of %d linked file(s) are not in the output%s. A URL helper builds the path rather than looking it '
        + 'up, so this is a link to something nothing produced — usually a preset that did not run, or a '
        + 'template naming an extension the preset no longer emits.',
        missing.length, used.length,
        missing.length > SHOWN ? `, ${SHOWN} shown` : '')
}

// The report-only commands, as functions that RETURN their exit code.
//
// They used to be inline here and call process.exit, which is fine for a
// process whose only job is to answer one question and stop. It is not fine
// for the instance that has to answer the same question on behalf of a client
// and stay alive — and answering it there is the point, because a local run
// reads a catalogue another process is in the middle of writing.
//
// `request` carries the CLIENT's arguments. Reading runtime.options here would
// answer with the instance's own flags, which are whatever it happened to be
// started with.
export async function runReportOnly(request = {}) {
    const logger = useLogger()
    const {
        tools = runtime.options.tools,
        tool = runtime.options.tool,
        toolArgs = runtime.options.toolArgs,
        json = runtime.options.json,
        explain = runtime.options.explain,
        auditOutput = runtime.options.auditOutput,
    } = request

    if (tools) {
        const schemas = toolSchemas()
        if (json) {
            process.stdout.write(JSON.stringify(schemas, null, 2) + '\n')
        } else if (!schemas.length) {
            logger.warn('No tools registered. The mcp plugin registers the standard set; '
                + 'this flag only lists and invokes what is registered.')
        } else {
            for (const schema of schemas) {
                process.stdout.write(`${schema.name}\n    ${String(schema.description).split('\n')[0]}\n`)
            }
        }
        return 0
    }

    if (tool) {
        // An empty catalog answers every question with a confident nothing —
        // `null`, `total: 0`, "no render claims this destination" — all of
        // which read as "the thing you asked about does not exist" when the
        // truth is "nothing has been built here yet". Said once, before the
        // answer, so it cannot be missed.
        const entityCount = (() => {
            try {
                return useDatabase().handle
                    .prepare('SELECT count(*) AS n FROM mikser_entities').get()?.n ?? 0
            } catch { return null }
        })()
        if (entityCount === 0 && !runtime.manifest?.size?.()) {
            logger.warn('The catalog and manifest are empty — no build has run in this working '
                + 'folder. Tools answer from what the last build recorded, so this one will '
                + 'report nothing found. Run a build first.')
        }

        let args = {}
        if (toolArgs) {
            try {
                args = JSON.parse(toolArgs)
            } catch (err) {
                logger.error('--tool-args is not valid JSON: %s', err.message)
                return 3
            }
        }
        let result
        try {
            result = await invokeTool(tool, args)
        } catch (err) {
            logger.error('%s', err.message)
            return 3
        }
        process.stdout.write(toolResultText(result) + '\n')
        // A tool that reports failure must not exit 0 — an agent reading CLI
        // output has only the exit code to branch on.
        return toolResultFailed(result) ? 1 : 0
    }

    if (explain) {
        // Exit codes:
        //   0 — the entity was found and described
        //   3 — not in the catalog (distinct from --audit-output's 1/2, which are
        //       about output drift; "no such entity" is neither clean nor
        //       corrupt, it is a question that could not be answered)
        const { explain: explainEntity, formatExplain } = await import('./explain.js')
        const report = await explainEntity(explain)
        process.stdout.write((json ? JSON.stringify(report, null, 2) : formatExplain(report)) + '\n')
        return report.found ? 0 : 3
    }

    if (auditOutput) {
        if (!runtime.manifest) {
            logger.error('Verify: no manifest available — nothing to check against')
            return 2
        }
        const { verdict, missing, mismatched, unverifiable, orphaned, collisions } =
            await runtime.manifest.auditOutput()
        const total = runtime.manifest.size()

        for (const e of missing)      logger.error('Missing:    %s (entity %s)', e.destination, e.id)
        for (const e of mismatched)   logger.error('Mismatched: %s (entity %s)%s', e.destination, e.id,
            e.writtenBy ? ` — the bytes on disk are ${e.writtenBy}'s` : '')
        for (const e of unverifiable) logger.warn('No hash:    %s (entity %s)', e.destination, e.id)
        for (const e of orphaned)     logger.warn('Orphan:     %s', e.path)
        // Named per destination: "two entities write here" is only actionable
        // if you know which two.
        for (const c of collisions)   logger.warn('Collision:  %s ← %s', c.destination, c.entities.join(', '))

        // Level picked from the verdict, because the level IS the marker in
        // pino-pretty's messageFormat: notice renders 🟢, warn 🟡, error 🔴. A
        // fixed `notice` prints a green tick next to the word FAIL, which
        // reads as success at a glance even though the exit code is right.
        const report = verdict === 'FAIL' ? logger.error : verdict === 'WARN' ? logger.warn : logger.notice
        report.call(logger,
            'Audit %s: %d snapshots, %d missing, %d mismatched, %d unverifiable, %d orphaned, %d collisions',
            verdict, total, missing.length, mismatched.length, unverifiable.length, orphaned.length, collisions.length)

        // Say what a pass means, because the name promises more than the check
        // can deliver.
        //
        // This compares each output file against the hash its OWN render
        // recorded. Every render rewrites that snapshot, so a render whose
        // output changed records the new bytes and then matches them: a
        // rendering regression verifies clean, by construction, and no amount
        // of care in the comparison changes that. It is a tampering check —
        // files edited, truncated or removed outside mikser — not a
        // regression check.
        //
        // Said on a PASS only. On a failure the listed differences are the
        // message, and this would bury them.
        if (verdict === 'OK') {
            logger.info(
                'Audit compares each output against the hash its own render recorded, so it catches files '
                + 'changed or removed outside mikser — not a render that changed. A render that changed is '
                + 'reported as it happens, under `output-drift`.')
        }
        return verdict === 'FAIL' ? 2 : verdict === 'WARN' ? 1 : 0
    }

    return null   // not a report-only request
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
    // The engine's own diagnostics, as tools. Registered here rather than by a
    // plugin so they exist on a bare engine — `--tool mikser_audit_output` must not
    // need an agent surface configured when `--audit-output` does not.
    registerBuiltinTools()

    // One engine per working folder: publish the control socket when this
    // process is long-running, and warn when a private one starts in a folder
    // somebody else is already holding.
    instanceControl()

    onInitialize(async () => {
        runtime.engine.commander?.version(packageInfo.version)
            .option('-i --working-folder <folder>', 'set mikser working folder', './')
            .option('-c --config <file>', 'set mikser mikser.config.js location', './mikser.config.js')
            .option('-m --mode <mode>', 'set mikser runtime mode', 'development')
            .option('-r --clear', 'clear current state before execution', false)
            .option('--render-presets [name]', 're-render preset derivatives whose sources and revisions are unchanged; with a name, only that preset')
            .option('-o --output-folder <folder>', 'set mikser output folder relative to working folder', 'out')
            .option('-w --watch', 'watch entities for changes', false)
            .option('-f --force', 'rebuild everything; disable incremental dispatch', false)
            .option('-R --resume', 'continue from journal entries left by a previous interrupted run; skip the initial filesystem scan', false)
            .option('--audit-output', 'audit the output folder against the snapshots the last build recorded — detects files changed or removed outside mikser, NOT a render that changed', false)
            .option('--explain <entity>', 'explain one entity — layout, destination, hashes, refClosure, and whether a build would re-render it. Accepts an id, a meta.href, or an id without its extension. Reports instead of building.')
            .option('--json', 'machine-readable output (with --explain, --tool, and for a build\'s render/skip/warning report)', false)
            .option('--tools', 'list the tools this build exposes, then exit', false)
            .option('--tool <name>', 'run one tool and print its result, then exit. The same tools an MCP client sees, so an agent reading CLI output and an agent speaking MCP ask the engine the same questions.')
            .option('--tool-args <json>', 'JSON arguments for --tool (e.g. \'{"destination":"/bg/index.html"}\')')
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

        // The sqlite file and the WAL sidecars it leaves beside it.
        const isDatabaseArtifact = (name) =>
            name.endsWith('.sqlite') || name.endsWith('.sqlite-wal') || name.endsWith('.sqlite-shm')

        if (runtime.options.clear) {
            try {
                runtime.engine.logger.info('Clearing folders')
                await rm(runtime.options.outputFolder, { recursive: true })
                // Everything in the runtime folder EXCEPT the database.
                //
                // Removing the folder wholesale took the database with it, and
                // with it every table registered `durable` — an OAuth client
                // registration, a refresh token, a form submission: data no
                // file can reproduce, which is the whole reason that flag
                // exists. `--clear` promising a rebuild and delivering a
                // sign-out is the same bug the durable flag was added to fix,
                // reached by a different route.
                //
                // The database is cleared too, but through its own wipe, which
                // drops the derived tables and keeps the durable ones.
                for (const entry of await readdir(runtime.options.runtimeFolder, { withFileTypes: true })
                    .catch(() => [])) {
                    if (isDatabaseArtifact(entry.name)) continue
                    await rm(path.join(runtime.options.runtimeFolder, entry.name), { recursive: true, force: true })
                }
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

    // Public URL resolution. CLI --url wins; otherwise read runtime.config.url
    // populated by the user's mikser.config.js. Stamped on runtime.options.url
    // (no trailing slash) for plugins to consume in their onLoaded.
    //
    // Plugins that need external reachability (webhook receivers, absolute
    // links in emails, MCP preview URLs, forms share links) read this. The
    // standard gating pattern is:
    //
    //     const canPush = runtime.options.url?.startsWith('https://')
    //     if (canPush) registerWebhookAt(`${runtime.options.url}/api/X/webhook`)
    //     else         setupPollingFallback()
    //
    // Runs at onLoad — after config.js fires its onLoad (which populates
    // runtime.config) and before any plugin's onLoaded.
    onLoad(async () => {
        const logger = useLogger()

        // Onto OPTIONS, not left on config: the url helpers read it, and they
        // run in render workers, which receive the worker-safe options and
        // never see runtime.config.
        runtime.options.siteRoots = runtime.config?.siteRoots ?? []
        if (runtime.options.siteRoots.length) {
            logger.info('Site roots: %s', runtime.options.siteRoots.join(', '))
        }

        const cli = runtime.options.url
        const cfg = runtime.config?.url
        const raw = cli ?? cfg
        if (raw == null || raw === '') {
            runtime.options.url = undefined
            return
        }
        try {
            new URL(raw)
        } catch (err) {
            throw new Error(`Invalid --url / config.url value: ${raw} (${err.message})`)
        }
        runtime.options.url = String(raw).replace(/\/+$/, '')
        logger.info('Public URL: %s%s', runtime.options.url,
            runtime.options.url.startsWith('https://') ? ' (webhook-capable)' : ' (http; plugins will not enable push webhooks)')
    })

    onImport(async () => {
        const logger = useLogger()
        // --tools / --tool: the CLI half of the tool surface.
        //
        // There are two agent workflows against mikser — one speaking MCP over
        // HTTP, one running the CLI and reading its output — and every tool
        // built for the first was invisible to the second. Rather than growing
        // a flag per tool, which drifts the moment a tool is added, this
        // dispatches through the same registry a session uses. A tool
        // registered by any plugin is reachable from both surfaces the moment
        // it exists.
        //
        // Dispatched at `import` rather than `loaded`, and the difference is
        // load-bearing: the engine's own onLoaded is registered during setup(),
        // ahead of every plugin's — including the ones that register the tools.
        // Listing from there returned exactly one, the tool the mcp substrate
        // creates for itself. By `import` every onLoaded has run and the
        // registry is complete. Nothing is imported, because this exits first,
        // the same way --explain and --audit-output do.
        if (runtime.options.tools || runtime.options.tool) {
            const code = await runReportOnly()
            if (code !== null) process.exit(code)
        }
    })

    onLoaded(async () => {
        const logger = useLogger()
        logger.debug(runtime.options, 'Mikser options')

        // --audit-output is a standalone read-only mode. Manifest has already
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
        // --explain: report on one entity and exit, like --audit-output. Placed
        // before it because a caller reaching for both means the explain.
        //
        // Exit codes:
        //   0 — the entity was found and described
        //   3 — not in the catalog (distinct from --audit-output's 1/2, which are
        //       about output drift; "no such entity" is neither clean nor
        //       corrupt, it is a question that could not be answered)
        // The same three commands the instance answers over the socket —
        // one implementation, so a forwarded --audit-output cannot disagree with a
        // local one about what it checked.
        const code = await runReportOnly()
        if (code !== null) process.exit(code)
    })

    onRender(async (signal) => {
        const logger = useLogger()
        const renderJobs = new Set()
        // destination → the entity ids that actually rendered to it this
        // cycle. Recorded past the skip gate rather than alongside renderJobs
        // so it holds renders that ran, which is what makes "one overwrote
        // the other" a true statement rather than a guess about two claims.
        const renderedTo = new Map()

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
                const decision = options.postprocessor
                    // A postprocessor consumes the intermediate rendered
                    // file, so skipping would leave its input missing.
                    ? { skip: false, reason: 'postprocessor' }
                    // Scheduled BECAUSE the thing that renders it moved. The
                    // manifest cannot see that: an asset's input hash is its
                    // own source, and a preset's revision is not part of it,
                    // so the skip was correct about the entity and wrong about
                    // the render. Bumping a preset's `revision` — the
                    // documented way to force a rebuild — therefore deleted
                    // the stale marker and left the derivative untouched.
                    : options.rendererChanged
                    ? { skip: false, reason: 'renderer-changed' }
                    : runtime.manifest?.skipDecision(entity, mutatedRefs, currentHashes, mutatedEntities)
                        ?? { skip: false, reason: 'no-manifest' }
                if (decision.skip) {
                    skipped++
                    entry.output = { success: true, skipped: 'manifest' }
                    await updateEntry({ id, output: entry.output })
                    reportSkipped(entity, decision.reason)
                    logger.debug('Manifest skip: %s → %s', entity.name || entity.id, entity.destination)
                    return
                }
                if (entity.destination) {
                    if (!renderedTo.has(entity.destination)) renderedTo.set(entity.destination, new Set())
                    renderedTo.get(entity.destination).add(entity.id)
                }
                // Reported on the way OUT, not here: `rendered` means the
                // output moved, and a render that throws writes nothing. The
                // decision is carried down to the success path so the reason
                // and its detail still travel with it.
                //
                // Same detail at debug, for tailing a watch run. One line per
                // render is too much for a build's normal output — the counts
                // are the summary and --json is the record — but when you are
                // watching one page misbehave, the trigger is the whole point.
                if (logger.isLevelEnabled?.('debug') ?? true) {
                    logger.debug('Render %s: %s%s', entity.id, decision.reason,
                        decision.changed?.length ? ` (${decision.changed.join(', ')})`
                        : decision.matched ? ` (${JSON.stringify(decision.matched.filter)}`
                            + `${decision.matched.by ? ` ← ${decision.matched.by}` : ''})`
                        : decision.dependency ? ` (${decision.dependency.kind} `
                            + `${decision.dependency.target} ${decision.dependency.cause})`
                        : '')
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
                // `meta: true` turns on read-recording over the entity's own
                // meta. Opt-out rather than opt-in: a contract that is only
                // correct when someone remembered to enable it is a contract
                // nobody can rely on. Set `metaReads: false` to switch it off.
                const track = createTrack({ meta: runtime.options.metaReads !== false,
                                            consumed: runtime.options.metaReads !== false })
                const renderOptions = {
                    entity: renderEntity,
                    options: {
                        tasks: TASKS.INLINE,
                        ...runtime.options,
                        ...options,
                    },
                    // Per-renderer options live on each renderer
                    // descriptor (.options) and are picked up inside
                    // render.js at dispatch time — no top-level config
                    // channel anymore (ADR-0010).
                    config: {},
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
                                mc.port2.onmessage = workerMessages()
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

                    // One shape from both dispatch modes. A worker returns its
                    // track's CONTENTS alongside the output, because the track
                    // itself could not be sent to it — folding them in here is
                    // what gives a worker render the same partial, lookup and
                    // meta-read deps an inline one has always had.
                    const rendered = result
                    result = rendered?.output
                    if (rendered?.track) mergeTrack(track, rendered.track)

                    // Which files this entity's template linked to. Harvested
                    // here because this is the one place that has both the
                    // track and the entity that produced it — a worker's track
                    // has just been folded in, so a worker render is covered
                    // the same as an inline one.
                    for (const destination of track.assets ?? []) {
                        reportAssetUse(destination, renderEntity.id)
                    }

                    if (!signal.aborted) {
                        // Meta reads ride on `output`, which is already
                        // free-form JSON on the journal row, rather than in
                        // `deps`: deps is the edge list that drives
                        // invalidation, and a property path is not an edge.
                        //
                        // Both halves are merged here. The template's reads
                        // come through the render track; the SIDECAR's come
                        // through the context, because a sidecar runs earlier,
                        // in the layouts plugin, against its own track — and
                        // the sidecar is the half no parser can see.
                        const metaReads = [
                            ...(track?.metaReads ?? []),
                            ...(context?.sidecarMetaReads ?? []),
                        ]
                        // Which keys of OTHER entities this render read, keyed
                        // by the entity they belong to. Merged from the same two
                        // places: the render's own track, and the sidecar's,
                        // which runs earlier on the main thread.
                        const consumedReads = new Map()
                        for (const [cid, paths] of [
                            ...(track?.consumedReads ?? []),
                            ...(context?.sidecarConsumedReads ?? []),
                        ]) {
                            const into = consumedReads.get(cid) ?? new Set()
                            for (const path of paths) into.add(path)
                            consumedReads.set(cid, into)
                        }
                        entry.output = {
                            success: true,
                            result,
                            ...(metaReads.length ? { metaReads: [...new Set(metaReads)].sort() } : {}),
                            ...(consumedReads.size ? {
                                consumedReads: [...consumedReads]
                                    .map(([cid, paths]) => [cid, [...paths].sort()])
                                    .sort(([a], [b]) => a.localeCompare(b)),
                            } : {}),
                        }
                        // A render that produced nothing at all. Distinct from
                        // a render that THREW, which lands in `errors` and
                        // leaves the previous good bytes on disk: this one
                        // succeeded, wrote an empty file over whatever was
                        // there, and counted itself in `rendered`.
                        //
                        // Deliberately narrow. It catches total failure, not a
                        // page that rendered its chrome and lost its content —
                        // that output is not empty and this will not see it.
                        // Only a string can be judged; a renderer returning
                        // some other shape is left alone rather than guessed at.
                        if (typeof result === 'string' && result.trim() === '') {
                            logger.warn(
                                { code: 'empty-output', entity: entity.id,
                                  layout: entity.meta?.layout ?? null,
                                  destination: entity.destination ?? null },
                                'Rendered %s to an EMPTY file at %s. The render succeeded, so this is not in ' +
                                'errors — but it overwrote the destination with nothing. Usually the layout ' +
                                'produced no output for this entity: check that it matched the layout you expect ' +
                                'and that the branch it took writes something.',
                                entity.name || entity.id, entity.destination ?? '(no destination)')
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

                    // A success clears whatever was recorded about this
                    // destination failing, so the retry set drains itself.
                    runtime.manifest?.clearFailure(entity)
                    reportRendered(entity, decision.reason, decision)
                    logger.debug('Rendered: [%s] %s → %s', options.renderer, entity.name || entity.id, entity.destination)
                } catch (err) {
                    if (!signal.aborted) {
                        await updateEntry({ id, output: { success: false } })
                        const context = formatErrorContext(entity, err, runtime.options)
                        logger.error('Render error: %s%s %s', entity.id, context, err.message)
                        // The machine-readable half of that same line. Without
                        // it a build that fails every page reports rendered:N,
                        // warnings:0 and exits 0 — three clean signals and only
                        // the human log knowing otherwise.
                        // Durable, so the next cycle knows to try again and
                        // --explain stops calling this destination current.
                        runtime.manifest?.recordFailure(entity, {
                            error: err.message,
                            context: context.trim() || null,
                            at: Date.now(),
                        })
                        const failure = runtime.manifest?.failureAt(entity.id, entity.destination)
                        reportError(entity, err, {
                            renderer: options.renderer ?? null,
                            layout: entity.layout?.id ?? null,
                            context: context.trim() || null,
                            // When it STARTED failing, and how many attempts.
                            // "broke just now" and "broken since 14:02" are
                            // different situations and the reader needs to
                            // tell them apart at a glance.
                            since: failure?.firstFailedAt ?? null,
                            attempts: failure?.attempts ?? 1,
                        })
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
        // Jobs minus skips minus THROWS. Counting a failed render as
        // rendered is the same overstatement the report used to make.
        const failed = renderErrorCount()
        renderJobs.size && logger.info('Rendered: %d', renderJobs.size - skipped - failed)
        skipped && logger.info('Manifest skipped: %d', skipped)
        failed && logger.error('Render errors: %d', failed)

        // Two entities writing one destination in the same cycle: one
        // silently overwrote the other, and every other signal reads clean.
        // Reported per cycle rather than only by --audit-output because this is
        // the moment it happened, and because a build that discards half its
        // output must not report warnings: 0.
        //
        // Derived from the destinations THIS cycle rendered, so an
        // established collision the operator already knows about does not
        // re-warn on every unrelated build; --audit-output is where the standing
        // state lives.
        for (const [destination, ids] of renderedTo) {
            if (ids.size < 2) continue
            const entities = [...ids].sort()
            logger.warn(
                { code: 'destination-collision', destination, entities },
                'Destination collision: %s written by %d entities in this cycle (%s). '
                + 'One overwrote the other — whichever rendered last wins.',
                destination, entities.length, entities.join(', '),
            )
        }
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
        // Close the cycle: stamp it and file it in the history, so a caller
        // that asked "tell me about cycle N" gets an answer after N ends
        // rather than only while it is the current one.
        finishCycle()

        // A cycle with failed renders is not a completed build, and the word
        // people read is this one.
        const failed = renderErrorCount()
        if (failed) logger.error('Mikser completed with %d render error%s', failed, failed === 1 ? '' : 's')
        else logger.notice('Mikser completed')

        // Is everything the templates linked to actually there?
        //
        // The URL helpers build paths; they do not resolve them. So a preset
        // that never ran, a library that was not copied, or a template naming
        // an extension the preset stopped producing all yield a well-formed
        // link to a file that does not exist — and the only symptom is a
        // missing image on the deployed site, found by a person.
        //
        // Checked at the end of the cycle because that is the first moment the
        // answer is stable: derivatives are produced during the cycle, so
        // asking any earlier would report files that were about to appear.
        // --render-presets with nothing to consume it.
        //
        // The flag is implemented by the assets plugin, so without that plugin
        // it reaches nobody: the build runs normally, nothing is re-derived,
        // and the operator is left to notice. Checked here rather than at
        // onLoaded because the engine's own onLoaded is registered first and
        // runs before any plugin has set itself up.
        if (runtime.options.renderPresets && !runtime.state?.assets?.renderPresetsHandled) {
            useLogger().error({ code: 'render-presets-unhandled' },
                '--render-presets was passed, but no assets plugin is loaded to act on it. '
                + 'Nothing was re-derived. Add assets() to the plugins array, or drop the flag.')
            process.exitCode = 1
        }

        const brokenTargets = await reportBrokenReferences(useLogger())
        await reportMissingAssets(useLogger(), brokenTargets)

        // After the cycle, and only under --json. stdout has been kept clear
        // for exactly this (the logger writes to stderr under --json), so the
        // document is the only thing on it and can be piped to jq.
        emitReport()

        // Non-zero for a one-shot build, so `mikser && mikser --audit-output` cannot
        // pass with every page in the site stale. `exitCode` rather than
        // process.exit so the report above is flushed and shutdown runs.
        //
        // Watch mode keeps going: a failed render there is a state to fix in
        // the next cycle, not a reason to tear down the watcher. That is also
        // what makes the failure self-concealing in watch — the errors scroll
        // past between two green builds — so the exit code is precisely the
        // signal CI needs and the one interactive use must not have.
        //
        // 1, not 2: --audit-output already uses 2 for output drift and --explain 3
        // for not-found. "The build ran and some renders threw" is its own
        // thing.
        if (failed && !runtime.options.watch) process.exitCode = 1
    })

    onCancelled(async () => {
        const logger = useLogger()
        logger.notice('Mikser restarted')
    })

    // Banner to stderr under --json / --tool / --tools, for the same reason the
    // logger goes there: stdout must contain only the document. An agent
    // reading CLI output pipes stdout, and a banner in front of the JSON is
    // the difference between a parse and a crash.
    //
    // argv directly, not runtime.options: commander parses in a lifecycle
    // hook, which runs after setup() returns, so options.json is still
    // undefined here. The logger has no such problem — it writes during the
    // run, by which time options exist.
    const quietStdout = ['--json', '--tool', '--tools'].some(flag => process.argv.includes(flag))
    if (runtime.options?.json || quietStdout) {
        process.stderr.write(`mikser. ${packageInfo.version}\n`)
    } else {
        console.info('\x1b[1mmikser\x1b[22;5;38;2;255;63;0m.\x1b[0m %s\n', packageInfo.version)
    }
    return runtime
}

export function useLogger() {
    return runtime.engine?.logger
}

// Boot: the option parse, the folders, the cache and durable stores, and
// everything that has to be true before a cycle can start.

import packageInfo from '../../package.json' with { type: 'json' }
import path from 'node:path'
import render from '../render.js'
import runtime from '../runtime.js'
import { completeCliParse } from '../cli.js'
import { onInitialize, onInitialized, onLoad, onLoaded } from '../lifecycle.js'
import { INSTALLED_LOG_TTL_MS, LOG_LEVELS, applyLogRequest, rememberBaseLevel } from '../logger/index.js'
import { attachServerCliOptions, setupServer } from '../server.js'
import { useLogger } from '../use-logger.js'
import { mkdir, readdir, rm } from 'fs/promises'

// `options` is setup's own argument, not runtime.options: a programmatic
// caller can pass a resolved options object and skip the CLI parse entirely,
// which is the one line below that needs it. It is threaded in rather than
// read off runtime, because at this point runtime.options is what it is
// about to become.
export function registerBoot(options) {
    onInitialize(async () => {
        runtime.engine.commander?.version(packageInfo.version)
            .option('-i --working-folder <folder>', 'set mikser working folder', './')
            .option('-c --config <file>', 'set mikser mikser.config.js location', './mikser.config.js')
            .option('-m --mode <mode>', 'set mikser runtime mode', 'development')
            .option('-r --clear', 'clear current state before execution', false)
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
            .option('--fingerprint', 'hash everything this build wrote — including what it wrote through a '
                + 'symlink, which `find` does not descend into — and exit. One comparable number per output '
                + 'tree, plus one per asset preset, for proving an upgrade moved no bytes.', false)
            // One level, not two booleans.
            //
            // `--debug` and `--trace` could not say "warnings only on this
            // build" or "trace this one thing", and --debug did not work at
            // all: it moved the logger's level while the terminal stream kept
            // the one it was built with, so debug records were accepted and
            // discarded. Both are gone rather than aliased — a flag that lies
            // is worse than a flag that is missing.
            .option('-l --log <level>', `log level for this run: ${LOG_LEVELS.join(', ')}`)
            .option('--log-install <level>', 'set the log level on a RUNNING instance, so its own '
                + `rebuilds are verbose too. Expires after ${INSTALLED_LOG_TTL_MS / 60000} minutes and `
                + 'dies with the process. Levels as above.')
            .option('--log-reset', 'return a running instance to its configured log level', false)
            .option('-e --runtime-folder <folder>', 'set mikser runtime folder relative to working folder', 'runtime')
        attachServerCliOptions(runtime.engine.commander)

        // Which check answers which question.
        //
        // The boundaries between these are real and none of them is redundant,
        // but that knowledge lived only in commit messages — which are the
        // wrong place for it, because nobody reads them before they need the
        // answer. A caller choosing how to verify a build was left to learn it
        // by experiment, one release at a time.
        //
        // On --help rather than in a doc alone: this is read at the moment the
        // question is being asked.
        runtime.engine.commander.addHelpText('after', `
Which check answers which question:

  Did this build write what it thought it wrote?
      --audit-output        compares the output on disk against the manifest.
                            Catches tampering, truncation and a file deleted
                            behind the build's back. Structurally CANNOT catch
                            a render that changed, because a render rewrites
                            its own snapshot — afterwards the new bytes agree
                            with themselves.

  Did an upgrade change what a render produces?
      --force               re-renders every ENTITY and reports output-drift:
                            same inputs, different bytes. This is the one that
                            catches a renderer, helper or dependency moving
                            under the build. It also reconciles deletions.

                            NOT derivatives. Assets are re-derived on a preset
                            revision or a source change, and --force is
                            neither — so a sharp upgrade is invisible to it.
                            Use --render-presets for that half.

  Do the URLs in the output point at anything?
      (runs every build)    reads the emitted html and css and resolves each
                            reference the way a browser would. Reports what
                            resolves to nothing, what a preset never produced,
                            and what loads only because a browser discarded a
                            climb above the site root.

  Are the derivatives current?
      --render-presets [n]  re-derives every preset, or one by name, without
                            touching anything else. For a preset edited without
                            bumping its revision. Declared by the assets
                            plugin, so it exists only in a project that loads
                            one — and a config without assets() refuses it as
                            unknown rather than accepting it and doing nothing.

  Start over.
      --clear               removes the output folder and reopens the cache.
                            A boot operation: it is refused while an instance
                            is running in the same folder.

  Did an upgrade move any bytes?
      --fingerprint         hash everything the build wrote, including what it
                            wrote THROUGH A SYMLINK — files() emits by
                            symlinking and assets links the derivatives tree
                            in, so \`find out -type f\` descends into neither.
                            One number for the whole output and one per shared
                            tree, stable across runs. Take it before and after
                            an upgrade and compare.

  Is this build one a person is waiting on?
      (automatic)           runtime.options.requested is true for a build a
                            client asked for — including one forwarded to a
                            running instance — and false for a watcher's own
                            cycle. An expensive check reads it to stand down in
                            the dev loop without standing down forever: an
                            instance is ALWAYS in watch mode, so watch alone
                            answers the wrong question.

  What did this build do, and cost?
      --json                the whole report as one document on stdout, with
                            every warning carrying a stable code, and per-phase
                            timings in milliseconds so two releases can be
                            compared.

The full version, with what each code means: docs/diagnostics.md`)

        // Stage one of two. The config names the plugins and is not read
        // until onLoad, so at this moment the engine does not yet know every
        // option this build understands — a plugin's is not registered. Left
        // strict, `mikser --lighthouse` would be rejected before the plugin
        // that defines it had been constructed.
        //
        // Tolerated here and decided in stage two, where the table is complete
        // — see completeCliParse(). The 9.81.0 refusal is not weakened, it is
        // moved to the point where "unknown" can be answered.
        runtime.engine.commander.allowUnknownOption(true).allowExcessArguments(true)

        // --help is answered in stage two, for the same reason the parse is.
        //
        // Commander prints help and exits the moment it sees the flag, which
        // in stage one is before any plugin has been constructed — so the help
        // would list core's options and silently omit every option the
        // project's own plugins add. A help text that is missing the flag you
        // are looking for is worse than a slower one.
        //
        // Held out of this parse and answered after the table is complete. It
        // does mean `--help` now loads the config, which is the honest cost of
        // describing THIS project's mikser rather than a generic one.
        const helpFlags = ['--help', '-h']
        runtime.engine.helpRequested = process.argv.some(arg => helpFlags.includes(arg))
        const argv = runtime.engine.helpRequested
            ? process.argv.filter(arg => !helpFlags.includes(arg))
            : process.argv
        Object.assign(runtime.options, options || runtime.engine.commander.parse(argv).opts())
        // runtime.options.info gates the progress bar — gauge stays
        // silent in --debug/--trace modes because logs are voluminous
        // there and a bar on top would just be noise.
        //
        // Applied through setLogLevel so the terminal STREAM moves with the
        // logger — the whole reason --debug did nothing.
        runtime.options.info = true
        const asked = runtime.options.log
        // The same call the instance makes for a forwarded request — see
        // applyLogRequest. Two implementations drifted within one commit.
        const logRefusal = applyLogRequest({
            log: asked,
            logInstall: runtime.options.logInstall,
            logReset: runtime.options.logReset,
        })
        if (logRefusal) throw new Error(logRefusal)
        rememberBaseLevel(asked && LOG_LEVELS.includes(asked) ? asked : 'info')

        // Resolve folders inside onInitialize so journal.js and
        // catalog.js (which initialize in onInitialized) see absolute
        // paths and a guaranteed-existing runtimeFolder. The split is
        // deliberate: engine's onInitialize does setup that the rest of
        // the engine infrastructure depends on; onInitialized does
        // things plugins may need.
        // Whether --config was TYPED, for config.js.
        //
        // Relative config paths resolve against the working folder, not the
        // folder the command was run in — that is what makes the default
        // './mikser.config.js' follow --working-folder, and `-c prod.js`
        // reads as "the prod config of the site I am pointing at", which is
        // how it is used. Deliberately unchanged.
        //
        // What was missing is what happens when the path is wrong. Nothing
        // distinguished "this project has no config" from "the config you
        // named is not there", so a mistyped path printed the path, reported
        // no plugins, and exited 0 over an empty output folder. config.js
        // needs to know which case it is in, and only commander can say.
        runtime.options.configExplicit =
            runtime.engine?.commander?.getOptionValueSource?.('config') === 'cli'

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
}

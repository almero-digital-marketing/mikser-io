

import Queue from 'p-queue'
import packageInfo from '../../package.json' with { type: 'json' }
import path from 'node:path'
import postprocess from '../postprocess.js'
import render from '../render.js'
import runtime from '../runtime.js'
import { registerBuiltinTools } from '../builtin-tools.js'
import { TASKS } from '../constants.js'
import { instanceControl } from '../instance.js'
import { LOG_LEVELS, createMikserLogger } from '../logger/index.js'
import { useLogger } from '../use-logger.js'
import { Command } from 'commander'
import { registerBoot } from './boot.js'
import { registerReportDispatch } from './dispatch.js'
import { registerRenderCycle } from './render-cycle.js'
import { registerPostprocessCycle } from './postprocess-cycle.js'
import { registerFinalize } from './finalize.js'
import { createWorkerPools } from './workers.js'
import { resolveThreads } from './threads.js'
export { runReportOnly } from './report-only.js'
export { useLogger } from '../use-logger.js'

export async function setup(options) {
    // The width a programmatic caller asked for, or the default. The CLI flag
    // and the config key are resolved later, at onLoad, because the config is
    // not loaded yet here — see resolveThreads and boot.js. The pools below
    // are rebuilt there if that resolution moves the number.
    runtime.options.threads = resolveThreads({ cli: options?.threads }).threads
    runtime.engine = {
        // Logger built from logger.js — pino + multistream + inline
        // pino-pretty over a gauge-aware terminal stream. Initial level
        // is 'info'; bumped to 'debug'/'trace' after CLI parse if those
        // flags are set. Caller can override entirely via options.logger
        // (e.g. to supply a pre-configured pino instance with their own
        // transports); progress-bar coordination is then their problem.
        logger: options?.logger || createMikserLogger('info'),
        // What a programmatic caller asked for, kept so boot's post-config
        // resolution can treat it the way it treats a typed --threads. The
        // resolved value alone cannot say whether 4 was asked for or defaulted.
        requestedThreads: options?.threads,
        commander: new Command(),
        // Lazily-allocated worker pools, sized by `threads`. Render and
        // postprocess both default to INLINE; Piscina only matters when a
        // layout opts into TASKS.WORKER (`task: 'worker'`). See
        // createWorkerPools for why they are built here and may be replaced
        // once the config has been read.
        ...createWorkerPools(runtime.options.threads),
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

    registerBoot(options)
    registerReportDispatch()
    registerRenderCycle()
    registerPostprocessCycle()
    registerFinalize()

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
    // The banner is an info record, so a level above info must not print it.
    //
    // `--log silent` printed the version line and nothing else — the one line
    // the flag most obviously promises to remove — because this runs before
    // the level is applied. Only the FORWARDED path was ever silent, and that
    // is the path the test exercises, so the test could not see it.
    //
    // argv again, for the reason quietStdout reads it: commander parses in a
    // lifecycle hook, which runs after setup() returns.
    if (!argvWantsInfo()) return runtime
    // Through the logger when nobody is watching, so it gets a timestamp.
    //
    // This line marks a process start, which in a supervisor's log is the
    // most useful thing on the page — it is how a restart is found at all.
    // Written straight to the stream it was undated and, worse, carried its
    // own hardcoded escapes into a file that no terminal would ever render.
    //
    // The decorated form stays for a terminal, where it is a banner rather
    // than a record.
    if (runtime.options?.json || quietStdout) {
        // Written straight to stderr, NOT through the logger: the logger picks
        // its sink per-write from runtime.options.json, which commander has
        // not parsed yet — the same reason quietStdout reads argv above. A
        // banner routed through it here lands on stdout and turns the
        // document into a parse error, which is the failure this branch was
        // added to prevent in the first place.
        process.stderr.write(`mikser. ${packageInfo.version}\n`)
    } else if (process.stdout.isTTY && !process.env.NO_COLOR) {
        console.info('\x1b[1mmikser\x1b[22;5;38;2;255;63;0m.\x1b[0m %s\n', packageInfo.version)
    } else {
        // Redirected: through the logger, so the line that marks a process
        // start carries a timestamp. In a supervisor's log that is the most
        // useful line on the page — it is how a restart is found at all — and
        // written straight to the stream it was undated and carried its own
        // escapes into a file no terminal will render.
        const logger = useLogger()
        if (logger) logger.info('mikser. %s', packageInfo.version)
        else process.stdout.write(`mikser. ${packageInfo.version}\n`)
    }
    return runtime
}


// The level asked for on the command line, before commander has parsed.
// Both spellings, both flags: `--log warn` and `--log=warn`, and
// `--log-install`, which on a run with no instance to forward to sets the
// level for this process.
function argvLogLevel() {
    for (const flag of ['--log', '--log-install', '-l']) {
        const at = process.argv.indexOf(flag)
        if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1]
        const inline = process.argv.find(arg => arg.startsWith(`${flag}=`))
        if (inline) return inline.slice(flag.length + 1)
    }
    return null
}

function argvWantsInfo() {
    const level = argvLogLevel()
    if (!level || !LOG_LEVELS.includes(level)) return true
    return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf('info')
}

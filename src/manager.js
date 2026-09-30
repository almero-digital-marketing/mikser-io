import runtime from './runtime.js'
import chokidar from 'chokidar'
import cron from 'node-cron'
import { onProcess, onFinalized } from './lifecycle.js'
import { resetReport } from './report.js'
import { useLogger } from './engine/index.js'
import { configStale } from './instance.js'
import { ACTION } from './constants.js'
import { junkFilter } from './utils/index.js'

const tasks = []

// The watch-cycle trigger, in one place rather than four copies.
//
// Debounced by a second so a burst of file events becomes one cycle. The
// report is cleared as the cycle STARTS, not when it is scheduled, so it
// always describes the cycle that just ran: without this it accumulates for
// the life of a watch process, and "what did the last rebuild do" becomes
// "here is everything since boot, find the end yourself".
//
// Not done inside runtime.process(): the first cycle's `gated` count is
// recorded during import, which runs BEFORE process(), so resetting there
// would wipe it out of a one-shot build's report.
function scheduleProcess() {
    clearTimeout(runtime.engine.processTimeout)
    runtime.engine.processTimeout = setTimeout(async () => {
        await warnConfigStale()
        resetReport()
        runtime.process()
    }, 1000)
}

// Editing config/*.js while watching changes nothing, and says nothing.
//
// Node has the module cached, and the config stamp is only compared at
// startup — that is where "Config changed since the last run. Wiping the
// cache…" comes from. So a watch process keeps running the logic it booted
// with, rebuilds happily, and reports green. Reported after it cost a
// consumer several rounds: a derivation plugin they had already fixed kept
// producing the old output, every symptom pointed at the data rather than at
// the process, and they reported it as broken twice before finding it.
//
// The check already exists — instance.js compares mtimes across
// configCoverage.files to refuse a forwarded command against drifted config.
// It just never ran on this path, where no client is asking.
//
// A warning, not a reload: re-importing a config module does not re-run the
// plugin registration that happened at boot, so a "reload" that only
// refreshed the module would be a more convincing version of the same lie.
// Restarting is the honest fix, and mikser_ping already reports `stale` for
// packages installed since boot on exactly this reasoning.
async function warnConfigStale() {
    if (runtime.options.watch !== true) return
    let changed = null
    try {
        changed = await configStale()
    } catch { return }          // never let a diagnostic break the rebuild
    if (!changed || changed === configStaleReported) return
    configStaleReported = changed
    useLogger().warn(
        { code: 'config-stale-in-process', file: changed },
        'Config changed on disk (%s) but this process is still running the version it started with — '
        + 'Node has the module cached and config is only re-read at startup. This rebuild, and every one '
        + 'after it, uses the OLD logic. Restart to pick it up.',
        changed)
}

// One warning per file, so a watch session editing the same module in a loop
// does not print it on every save — and a DIFFERENT file still speaks up.
let configStaleReported = null

export async function createdHook(name, context) {
    if (!runtime.started) return

    const synced = await runtime.sync({
        action: ACTION.CREATE,
        name,
        context
    })

    if (synced) {
        scheduleProcess()
    }
}

export async function updatedHook(name, context) {
    if (!runtime.started) return

    const synced = await runtime.sync({
        action: ACTION.UPDATE,
        name,
        context
    })

    if (synced) {
        scheduleProcess()
    }
}

export async function triggeredHook(name, context) {
    if (!runtime.started) return

    const synced = await runtime.sync({
        action: ACTION.TRIGGER,
        name,
        context
    })

    if (synced) {
        scheduleProcess()
    }
}

export async function deletedHook(name, context) {
    if (!runtime.started) return

    const synced = await runtime.sync({
        action: ACTION.DELETE,
        name,
        context
    })

    if (synced) {
        scheduleProcess()
    }
}

// Dot-prefixed anything, plus the OS/file-manager litter that is NOT
// dot-prefixed — Thumbs.db and desktop.ini were measurably being watched.
// A function rather than a regex because chokidar 4+ dropped glob support in
// `ignored` and a function is the one form that has stayed stable.
const ignoreJunk = (filePath) => /[/\\]\./.test(filePath) || junkFilter()(filePath)

// Wait for the bytes to stop moving before saying a file arrived.
//
// Without this an event fires the moment a file appears, and the tools people
// actually upload with do not write in one go. A WebDAV client, Finder and
// `rsync` without --inplace all write a temporary file into the watched folder
// and rename it afterwards, so the sequence is: `add` for a name that is about
// to stop existing, a checksum read of a file that is still growing, and a
// rename out from under both.
//
// Measured on a live site during a video upload. Four server deaths in one
// afternoon from the vanishing half, and — worse, because nothing stopped —
// one derivative built from a file read at ZERO BYTES: its checksum note held
// d41d8cd98f00b204e9800998ecf8427e, the md5 of nothing, where a file that size
// should carry `size:head:tail`. The build called that current and the next
// one agreed with it.
//
// 500ms is the compromise the two failures point at from opposite sides. It is
// long enough to swallow a temp-file rename and a local tear, short enough
// that an incremental rebuild of a saved document still feels immediate — the
// engine's own budget for one is about 100ms. A big upload over a slow link
// needs more, and the files plugin asks for more; anything can, through
// `options`.
const AWAIT_WRITE_FINISH = { stabilityThreshold: 500, pollInterval: 100 }

// `interval` and `binaryInterval` are NOT here, and their absence is the fix.
//
// They were set to 1000 and 3000, which reads as a debounce and is not one:
// chokidar consumes both only inside `if (opts.usePolling)` (handler.js), and
// polling is off. They described an intention that never ran, which is the
// most expensive kind of setting to leave lying around — somebody reads them
// and stops looking for the debounce that is actually missing. Polling can be
// asked for explicitly through `options`, and then they would apply.
const WATCH_DEFAULTS = {
    ignored: ignoreJunk,
    ignoreInitial: true,
    awaitWriteFinish: AWAIT_WRITE_FINISH,
}

// Watch a folder, with mikser's own settings and none of its lifecycle.
//
// `watch()` below turns file events into SYNC events — it is how a source
// folder becomes entities, and pointing it at anything else feeds output back
// in as input. A plugin that only wants to know when bytes changed needs the
// watching without the meaning, and was otherwise reaching for chokidar
// directly: a second copy of a dependency the engine already has, and a second
// junk filter that would drift from this one.
//
// followSymlinks matters more than it looks. The files plugin serves a file by
// symlinking it from the source folder into the output folder, so a watcher on
// the output folder that did not follow links would see the link created once
// and never hear about the file again — every stylesheet edit silently
// invisible to anything watching what is served.
export function watchFolder(folder, handler, options = {}) {
    return chokidar
        .watch(folder, {
            ...WATCH_DEFAULTS,
            followSymlinks: true,
            ...options,
        })
        .on('all', (event, fullPath) => handler(event, fullPath))
}

export function watch(name, folder, options = {}) {
    if (runtime.options.watch !== true) return

    // Every hook is AWAITED and its failure caught here.
    //
    // They used to be called and dropped: `createdHook(name, …)` with no
    // await inside an async listener, which makes a rejection nobody is
    // holding. There is no unhandledRejection handler in a plugin's reach, so
    // the default applied — Node printed the error and exited 1. A watcher
    // that dies of an asynchronous error from a file that moved is the worst
    // available failure mode, because the only evidence is an exit code: it
    // happened four times in one afternoon on a live site and each time the
    // symptom was "the server is gone".
    //
    // Caught per event, not per watcher, so one bad file costs that file and
    // not the process.
    const deliver = async (hook, fullPath) => {
        const relativePath = fullPath.replace(`${folder}/`, '')
        try {
            await hook(name, { relativePath })
        } catch (err) {
            reportWatchFailure(err, fullPath)
        }
    }

    chokidar.watch(folder, { ...WATCH_DEFAULTS, ...options })
        .on('all', () => {
            clearTimeout(runtime.engine.processTimeout)
        })
        .on('add',    fullPath => deliver(createdHook, fullPath))
        .on('change', fullPath => deliver(updatedHook, fullPath))
        .on('unlink', fullPath => deliver(deletedHook, fullPath))
        .on('error',  err => reportWatchFailure(err))
}

// A file that is gone is not an error; anything else is.
//
// The vanishing case is ordinary for a watcher — the event describes a moment
// that has already passed — so it is a warning naming the path, and the build
// carries on. Everything else keeps its stack, because a watcher that
// swallows real faults is the same silence in a different costume.
function reportWatchFailure(err, fullPath) {
    const logger = useLogger()
    if (err?.code === 'ENOENT') {
        logger?.warn(
            { code: 'source-vanished', path: err.path ?? fullPath },
            'Watched file disappeared before it could be read: %s. Nothing was imported for it — '
            + 'this is what an upload that writes a temporary file and renames it looks like.',
            err.path ?? fullPath ?? 'unknown')
        return
    }
    logger?.error('Watcher failed for %s: %s', fullPath ?? 'the watched folder', err?.stack ?? err?.message ?? err)
}

export function schedule(name, expression, context) {
    if (runtime.options.watch !== true) return
    const logger = useLogger()
    const taks = cron.schedule(expression, async () => {
        logger.info('Scheduled task executed: %s %s', name, expression)
        triggeredHook(name, context)
    }, {
        scheduled: false
    })
    tasks.push(taks)
}

onProcess(() => {
    if (!tasks.length) return
    const logger = useLogger()
    logger.debug('Stopping scheduled tasks: %d', tasks.length)
    for (let task of tasks) {
        task.stop()
    }
})

onFinalized(() => {
    if (!tasks.length) return
    const logger = useLogger()
    logger.debug('Starting scheduled tasks: %d', tasks.length)
    for (let task of tasks) {
        task.start()
    }
})
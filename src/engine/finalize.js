// The end of a cycle: the summary, the output checks, and what a cancelled
// cycle has to undo.

import path from 'node:path'
import render from '../render.js'
import runtime from '../runtime.js'
import { onCancel, onCancelled, onFinalized } from '../lifecycle.js'
import { finishCycle, renderErrorCount } from '../report.js'
import { useLogger } from '../use-logger.js'
import { existsSync } from 'fs'
import { lstat, realpath, unlink } from 'fs/promises'
import { globby } from 'globby'
import { reportBrokenReferences, reportMissingAssets, formatBytes } from './checks.js'

export function registerFinalize() {

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

        // The `render-presets-unhandled` guard is gone, and so is the state it
        // read.
        //
        // It existed because core declared `--render-presets` while the assets
        // plugin implemented it, so the flag could be passed at a build that
        // had no plugin to act on it — accepted, ignored, and reported after
        // the fact. The plugin declares the option itself now, so a config
        // without assets() does not have the flag at all and a misspelling is
        // refused by name before anything is built. There is nothing left to
        // warn about after the event.


        const brokenTargets = await reportBrokenReferences(useLogger())
        await reportMissingAssets(useLogger(), brokenTargets)

        // The report is NOT emitted here any more. This hook is registered
        // when the engine is imported, so it runs first among finalized hooks
        // and every plugin's findings would land after the document was
        // written. runtime.finalize() emits it once every hook has run.

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
}

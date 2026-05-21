import cliProgress from 'cli-progress'
import runtime from './runtime.js'
import { useLogger } from './engine.js'
import formatTime from 'cli-progress/lib/format-time.js'
import { onInitialized } from './lifecycle.js'
import util from 'util'

let progress = {}

function log(log) {
    const { bar, total, value, name } = progress
    const isActive = bar?.isActive
    isActive && bar?.stop()
    log()
    isActive && bar?.start(total, value, { name, details: '' })
}

onInitialized(() => {
    const logger = useLogger()
    if (runtime.options.info) {
        logger.info = (...args) => log(() => console.log(...args))
        logger.warn = (...args) => log(() => console.log('🟡 ' + args[0], ...args.slice(1)))
        logger.error = (...args) => log(() => console.log('🔴 ' + args[0], ...args.slice(1)))
        logger.notice = (...args) => log(() => console.log('🟢 ' + args[0], ...args.slice(1)))
        logger.trace = (...args) => updateProgressDetails(util.format(...args))
    }
})

export function trackProgress(name, total) {
    if (!name || !total) return
    const logger = useLogger()
    logger.debug('%s started: %d', name, total)
    progress.bar?.stop()
    progress = {
        name,
        total,
        value: 0,
        stamp: Date.now(),
        bar: runtime.options.info ? new cliProgress.SingleBar({
            noTTYOutput: true,
            hideCursor: true,
            clearOnComplete: true,
            barsize: 30,
            format: '{name}: {bar} {percentage}% | ETA: {eta_formatted} {details}',
        }, cliProgress.Presets.shades_grey) : null
    }
    progress.bar?.start(total, 0, { name, details: '' })
}

export function stopProgress() {
    const logger = useLogger()
    const { value, total, bar, name } = progress
    bar?.stop()
    if (value < total) {
        logger.warn('%s unfinished: %d', name, total - value)
    } else {
        const time = Math.round((Date.now() - progress.stamp) / 1000)
        logger.info('%s finished: %d %s', name, total, formatTime(time, { autopaddingChar: '' }))
    }
    progress = {}
}

export function updateProgress() {
    progress.name && progress.value++
    progress.bar?.increment()
    if (progress?.value == progress?.total) {
        stopProgress()
    }
}

export function updateProgressDetails(details) {
    const logger = useLogger()
    logger.debug(details)
    progress.bar?.update({ details: `| ${details}` })
}
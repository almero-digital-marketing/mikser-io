// Pino logger + apt-style progress bar, integrated.
//
// What this owns:
//   - The mikser logger instance (pino + pino-pretty + multistream)
//   - The bottom-pinned progress bar (gauge — same library npm uses)
//   - Coordination between the two so log lines don't garble the bar
//   - Multi-destination shipping: terminal + zero or more transports
//     declared in runtime.config.logging.transports
//
// Why this shape:
//
// pino is the source of truth for log records. Anything any plugin or
// engine module emits goes through pino. From pino, records fan out via
// `pino.multistream` to:
//   1. An inline pino-pretty stream that writes to our custom Writable
//      (so we can coordinate with the gauge before/after each line)
//   2. Zero or more third-party transports configured in
//      runtime.config.logging.transports — anything pino's transport
//      worker pattern supports (pino-loki, @axiomhq/pino, pino-datadog,
//      a file shipper, etc.).
//
// Progress is a separate concern that runs ALONGSIDE pino. The gauge
// instance owns the bottom row of the terminal. The custom Writable
// calls `gauge.disable()` before writing a log line and `gauge.enable()`
// after — the cleanup pattern npm uses at scale.

import pino from 'pino'
import pretty from 'pino-pretty'
import Gauge from 'gauge'
import { Writable } from 'node:stream'
import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoad } from './lifecycle.js'

// Custom level — `notice` slots between info and warn. Used by mikser
// for "the build cycle completed" / "the engine restarted" lines that
// want visibility above info noise but aren't warnings.
const CUSTOM_LEVELS = { notice: 35 }

// Plugin-side log transport registry — paired with `addLogTransport`
// below. Two-state lifecycle:
//
//   - Before createMikserLogger() runs (the plugin factory phase, when
//     mikser.config.js is being import()'d and the factories embedded
//     in `plugins: []` are calling addLogTransport synchronously), the
//     entries land in pendingTransports. createMikserLogger drains it
//     alongside the declarative runtime.config.logging.transports when
//     it builds the multistream.
//
//   - After createMikserLogger() has run, `currentStreams` and
//     `currentLevel` are populated. Any later addLogTransport call
//     (e.g. from a plugin's onLoaded hook, or a deferred integration)
//     builds the new stream, pushes it onto currentStreams, and swaps
//     runtime.engine.logger to a fresh pino instance backed by the
//     updated multistream. useLogger() reads runtime.engine.logger
//     fresh on each call, so the new transport starts receiving
//     records immediately for every subsequent log call.
//
// The shape `{ level?, target, options? }` mirrors what
// runtime.config.logging.transports already accepts.
const pendingTransports = []
let currentStreams = null
let currentLevel   = 'info'

// Per-level icons prepended via pino-pretty's messageFormat. Empty
// strings for levels we don't want to decorate — debug/trace are noisy
// enough already. messageFormat receives `log.level` as a number, so we
// reverse-map via LEVEL_LABELS to get the icon — pino-pretty's third
// argument to messageFormat looks like a level label but is actually a
// sentinel string for the string-template form, not the real label.
const ICONS = {
    fatal:  '💥 ',
    error:  '🔴 ',
    warn:   '🟡 ',
    notice: '🟢 ',
    info:   '',
    debug:  '',
    trace:  '',
}
const LEVEL_LABELS = {
    60: 'fatal',
    50: 'error',
    40: 'warn',
    35: 'notice',
    30: 'info',
    20: 'debug',
    10: 'trace',
}

// Gauge instance and current-bar state. Built lazily on first
// trackProgress() call — non-TTY contexts and debug/trace modes never
// create the gauge at all.
let gauge = null
let currentBar = null

function ensureGauge() {
    if (gauge) return gauge
    gauge = new Gauge(process.stdout, {
        updateInterval: 80,
        cleanupOnExit: true,
        // npm-flavored template: section name, count (subsection), bar
        // fill. No `percentage` token — gauge doesn't auto-derive it
        // from `completed`, and the fill + `N/total` already convey
        // progress; a separate "67%" is redundant. gauge picks the
        // theme (unicode vs ASCII) based on terminal capability.
        template: [
            { type: 'section',     default: '' },
            ': ',
            { type: 'subsection',  default: '' },
            ' ',
            { type: 'progressbar', length: 30 },
        ],
    })
    return gauge
}

// Writable that pino-pretty writes formatted lines into. Coordinates
// with the gauge: clears the bar, prints the log line, restores the
// bar. When no gauge is active (boot, non-TTY, debug/trace mode), this
// is a thin pass-through to stdout.
function createTerminalStream() {
    return new Writable({
        write(chunk, enc, cb) {
            if (gauge) gauge.disable()
            // --json puts a machine-readable document on stdout, so every
            // log line has to go somewhere else or the document cannot be
            // parsed. stderr rather than silence: the operator still sees
            // the build, and `mikser --explain x --json | jq` still works —
            // which is the entire point of the flag.
            const out = runtime.options?.json ? process.stderr : process.stdout
            out.write(chunk, enc)
            if (gauge) gauge.enable()
            cb()
        },
    })
}

// Build the mikser logger. Called by engine.setup() at the start of
// the boot, and called again at onLoad (this module's onLoad hook,
// which fires after config.js's) so transports declared in
// runtime.config.logging.transports are picked up.
//
// `level` is pino's log level — set to whatever runtime.options.{debug,
// trace} resolves to, defaulting to 'info'.
export function createMikserLogger(level = 'info') {
    const terminalStream = createTerminalStream()
    const prettyStream = pretty({
        destination:   terminalStream,
        colorize:      true,
        // apt-like minimal format: hide timestamp / pid / hostname, and
        // suppress the level prefix entirely via a customPrettifier
        // that returns an empty string. The icon prepended by
        // messageFormat (🟡 / 🔴 / 🟢 / …) is what signals level. The
        // raw pino record still carries `level`, so third-party
        // transports get full structured data.
        ignore:        'pid,hostname,time',
        customLevels:  'notice:35',
        customPrettifiers: {
            level: () => '',
        },
        messageFormat: (log, key) => {
            const icon = ICONS[LEVEL_LABELS[log.level]] ?? ''
            return icon + (log[key] ?? '')
        },
    })

    const streams = [{ level, stream: prettyStream }]

    // Two sources of transports merged into one list:
    //
    //   - runtime.config.logging.transports (declarative — user-config-
    //     driven). The historical surface; still works unchanged.
    //   - pendingTransports (plugin-side, drained here). Plugin factories
    //     that called addLogTransport at config-load time land here.
    //
    // Each entry is `{ level?, target, options? }` — same shape
    // pino.transport() accepts. Transport workers that fail to load
    // (missing dep, bad config) surface to stderr but don't crash the
    // engine — the terminal stream stays alive.
    const declared = runtime.config?.logging?.transports ?? []
    for (const t of [...declared, ...pendingTransports]) {
        const s = buildTransportStream(t, level)
        if (s) streams.push(s)
    }
    pendingTransports.length = 0

    currentStreams = streams
    currentLevel   = level

    return pino(
        {
            level: 'trace',          // accept everything; per-stream level filters from there
            customLevels: CUSTOM_LEVELS,
        },
        pino.multistream(streams)
    )
}

// Construct a multistream entry for a transport descriptor. Returns
// null when the underlying pino.transport() call throws (missing
// dependency, bad options) — caller treats null as "skip".
function buildTransportStream(entry, defaultLevel) {
    try {
        return {
            level:  entry.level ?? defaultLevel,
            stream: pino.transport({ target: entry.target, options: entry.options }),
        }
    } catch (err) {
        process.stderr.write(
            `Logger: failed to load transport "${entry.target}": ${err.message}\n`
        )
        return null
    }
}

// Add a log transport from anywhere in mikser-io's lifecycle —
// typically from a plugin's factory (the canonical Better Stack /
// Datadog / Loki / Axiom / Sentry shape) or from a plugin's onLoaded
// hook for deferred / runtime-resolved integrations.
//
// Behavior depends on when this is called:
//
//   - Before createMikserLogger() has run (factory phase during
//     config.js's onLoad — plugin factories called inside the user's
//     mikser.config.js evaluate here): the entry queues. The next
//     createMikserLogger() call drains the queue.
//
//   - After createMikserLogger() has run (plugin onLoaded, any later
//     hook, runtime injection): the new pino.transport stream is
//     built and pushed onto the live multistream, then runtime.engine
//     .logger is swapped to a fresh pino backed by the updated list.
//     useLogger() reads runtime.engine.logger on each call, so all
//     subsequent log emissions reach the new transport.
//
// Returns true when the transport was queued or successfully added,
// false when transport stream construction failed (the load error
// already went to stderr via buildTransportStream).
export function addLogTransport(entry) {
    if (currentStreams === null) {
        pendingTransports.push(entry)
        return true
    }
    const s = buildTransportStream(entry, currentLevel)
    if (!s) return false
    currentStreams.push(s)
    if (runtime.engine) {
        runtime.engine.logger = pino(
            { level: 'trace', customLevels: CUSTOM_LEVELS },
            pino.multistream(currentStreams),
        )
    }
    return true
}

// Replace the bootstrap logger (built by engine.setup() with the
// terminal-only stream) with one that includes any third-party
// transports from runtime.config.logging.transports. Runs at onLoad
// AFTER config.js's onLoad — module-load order in mikser-io/index.js
// imports config.js before this file, so this hook registers later and
// fires later.
//
// MUTATING runtime.engine.logger means useLogger() — which reads
// `runtime.engine?.logger` fresh on each call — sees the new instance
// from this point on. Captured-in-closure copies (`const logger =
// useLogger()`) from earlier setup callbacks keep the old one, but by
// this phase those callbacks have all run; the captured copies belong
// to closures that have already executed.
onLoad(() => {
    if (!runtime.engine?.logger) return
    const haveDeclared = (runtime.config?.logging?.transports?.length ?? 0) > 0
    const havePending  = pendingTransports.length > 0
    if (!haveDeclared && !havePending) return
    const level = runtime.engine.logger.level
    runtime.engine.logger = createMikserLogger(level)
})

// Progress API. Surface preserved: trackProgress / updateProgress /
// stopProgress / updateProgressDetails. Gauge-backed; no-op in non-TTY
// contexts or when runtime.options.info is false (i.e. --debug / --trace
// modes, where logs are voluminous and a bar would just be noise).

export function trackProgress(name, total) {
    if (!name || !total) return
    const logger = useLogger()
    logger.debug('%s started: %d', name, total)
    if (!process.stdout.isTTY || !runtime.options.info) return
    currentBar = { name, total, value: 0, started: Date.now() }
    ensureGauge().show({ section: name, subsection: `0/${total}` }, 0)
}

export function updateProgress() {
    if (!currentBar) return
    currentBar.value++
    const { name, total, value } = currentBar
    gauge?.show({ section: name, subsection: `${value}/${total}` }, value / total)
    if (value >= total) stopProgress()
}

export function stopProgress() {
    if (!currentBar) return
    const logger = useLogger()
    const { name, total, value, started } = currentBar
    gauge?.hide()
    if (value < total) {
        logger.warn('%s unfinished: %d', name, total - value)
    } else {
        const elapsed = Math.round((Date.now() - started) / 1000)
        logger.info('%s finished: %d %ds', name, total, elapsed)
    }
    currentBar = null
}

export function updateProgressDetails(details) {
    const logger = useLogger()
    logger.debug(details)
    if (!currentBar || !gauge) return
    gauge.show(
        { section: currentBar.name, subsection: details },
        currentBar.value / currentBar.total,
    )
}

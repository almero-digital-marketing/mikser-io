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
import path from 'node:path'
import runtime from './runtime.js'
import { useLogger } from './engine.js'
import { onLoad, onFinalized } from './lifecycle.js'
import { captureWarning, captureFault } from './report.js'

// Custom level — `notice` slots between info and warn. Used by mikser
// for "the build cycle completed" / "the engine restarted" lines that
// want visibility above info noise but aren't warnings.
const CUSTOM_LEVELS = { notice: 35 }

// pino's numeric levels. The report keeps warn and error in separate buckets,
// so the capture stream routes on these rather than taking everything the
// stream hands it as one kind of thing.
const WARN_LEVEL = 40
const ERROR_LEVEL = 50

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
            // --tool is the same contract: stdout carries the tool's result and
            // nothing else, because an agent reading CLI output pipes it.
            const out = (runtime.options?.json || runtime.options?.tool || runtime.options?.tools)
                ? process.stderr : process.stdout
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

    // A terminal is watched as it happens. A file is read afterwards.
    //
    // The minimal format below is right for the first and wrong for the
    // second, and until now it was used for both — so a supervisor's log was
    // a wall of undated lines wearing ANSI escapes. Reconstructing an
    // incident from one meant ordering events by file mtimes and git commit
    // dates because the build's own log could not say when anything happened,
    // and every excerpt had to be piped through sed to be readable.
    //
    // Decided from the stream these lines actually land on, which is stderr
    // under --json / --tool (stdout carries the document there). The logger is
    // rebuilt at onLoad, by which point those options are parsed, so the
    // second construction gets it right even if the first cannot.
    //
    // Same signal the progress bar already uses — a gauge is pointless in a
    // file for the same reason a timestamp is pointless on a terminal.
    const target = (runtime.options?.json || runtime.options?.tool || runtime.options?.tools)
        ? process.stderr : process.stdout
    const attended = Boolean(target.isTTY)

    const prettyStream = pretty({
        destination:   terminalStream,
        // NO_COLOR is honoured on a terminal too; nobody wants escapes in a
        // file regardless.
        colorize:      attended && !process.env.NO_COLOR,
        // `SYS:standard` carries the date, milliseconds AND the UTC offset.
        // The offset is not decoration: the incident that prompted this
        // needed a container's clock lined up against commit dates in
        // another zone, and a bare wall-clock time cannot answer that.
        ...(attended ? {} : { translateTime: 'SYS:standard' }),
        // apt-like minimal format: hide pid / hostname, and suppress the
        // level prefix entirely via a customPrettifier that returns an empty
        // string. The icon prepended by messageFormat (🟡 / 🔴 / 🟢 / …) is
        // what signals level. The raw pino record still carries `level`, so
        // third-party transports get full structured data. `time` is dropped
        // only when someone is watching.
        ignore:        attended ? 'pid,hostname,time' : 'pid,hostname',
        // The terminal gets the SENTENCE; the structured fields go to the
        // report and to transports.
        //
        // Warnings carry `{ code, ...fields }` so the build report has
        // something assertable, and pino-pretty would otherwise print that
        // object under every one of them — turning a one-line warning into a
        // six-line block. The fields are still on the raw record, which is
        // what the report stream and every transport read, so nothing is lost
        // by not showing them twice.
        hideObject:    true,
        customLevels:  'notice:35',
        customPrettifiers: {
            level: () => '',
        },
        // The CODE, on the line a person is reading.
        //
        // A finding had two names: the report called it `output-drift` and the
        // console said "produced different bytes from the same inputs", and
        // nothing on the console contained the string someone reading
        // docs/diagnostics.md would grep for. So a script watching the build
        // matched prose — the half that is free to be reworded — while the
        // stable identifier existed only in a document that script was not
        // reading.
        //
        // Printed here because this is the one function every line passes
        // through, so the code cannot be attached to the record and missing
        // from the terminal: they come from the same field. `hideObject` still
        // suppresses the rest of the structured fields, which belong in the
        // report and would turn a one-line warning into a block.
        //
        // Only where there is a code. An ordinary info line has no identity to
        // print and gains nothing from a bracket.
        messageFormat: (log, key) => {
            const icon = ICONS[LEVEL_LABELS[log.level]] ?? ''
            const code = typeof log.code === 'string' && log.code ? `[${log.code}] ` : ''
            return icon + code + (log[key] ?? '')
        },
    })

    const streams = [{ level, stream: prettyStream }]

    // The build report's `warnings` and `faults` are views of this stream
    // rather than channels of their own. Anything that calls logger.warn is a
    // warning and anything that calls logger.error with a `code` is a fault,
    // wherever it was raised — including inside a render worker, whose logger
    // already comes back over the IPC port and is re-emitted here, so no
    // separate transport is needed to carry either out of a thread.
    //
    // One stream, two destinations, because the two are different facts and
    // the report keeps them apart. A warning says something shipped and is
    // wrong; a coded error says a subsystem cannot work at all. `errors` in
    // the report is neither — it means a render THREW and wrote nothing, and
    // stays exactly what it was.
    //
    // Uncoded error records are not captured. Those are events about one
    // thing (`Render error: doc-1`), which already travels in `errors` with
    // the entity attached, and a fault needs an identity to be one condition
    // rather than forty. Note that `logger.error(err, msg)` puts an errno
    // under `err` rather than at the top level, so a raw throw logged that way
    // does not accidentally become a fault.
    streams.push({
        level: 'warn',
        stream: new Writable({
            write(chunk, _encoding, callback) {
                for (const line of String(chunk).split('\n')) {
                    if (!line) continue
                    try {
                        const record = JSON.parse(line)
                        if (record.level === WARN_LEVEL) captureWarning(record)
                        else if (record.level >= ERROR_LEVEL && record.code) captureFault(record)
                    } catch { /* not a record we can read; the terminal still got it */ }
                }
                callback()
            },
        }),
    })

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

// The levels a person can ask for, in pino's order.
export const LOG_LEVELS = ['trace', 'debug', 'info', 'notice', 'warn', 'error', 'fatal', 'silent']

// What the run was configured with, so a reset has something to return to.
let baseLevel = 'info'
// { level, expiresAt } — set by --log-install, survives the request that set it.
let installedLevel = null

// Move the level, and mean it.
//
// `--debug` used to set runtime.engine.logger.level and stop there, which did
// nothing observable: the pino INSTANCE accepted debug records while the
// terminal stream still filtered them at the level it was constructed with,
// so they were accepted and discarded. It only ever worked when a logging
// transport happened to be configured, because that is the one path that
// rebuilt the logger. Measured on 10.4.0: identical output with and without
// the flag, down to the line count.
//
// So the stream entry moves too, and the instance is rebuilt over the live
// stream list the way addLogTransport already does — same swap, so a transport
// added earlier survives.
//
// TRANSPORTS KEEP THEIR OWN LEVEL. They were built with the level they
// declared, and `--log debug` is a statement about what the operator wants to
// SEE, not an instruction to flood Better Stack. A transport that wants more
// says so in its own entry.
export function setLogLevel(level) {
    if (!LOG_LEVELS.includes(level)) return false
    if (currentStreams === null || !runtime.engine) return false
    // Index 0 is the terminal entry — see createMikserLogger, where the list
    // is seeded with it before any transport is appended.
    currentStreams[0] = { ...currentStreams[0], level }
    currentLevel = level
    runtime.engine.logger = pino(
        { level: 'trace', customLevels: CUSTOM_LEVELS },
        pino.multistream(currentStreams),
    )
    return true
}

// The level a run starts at, remembered so --log-reset has a target.
export function rememberBaseLevel(level) {
    if (LOG_LEVELS.includes(level)) baseLevel = level
}

// Raise the level on a RUNNING instance, until it expires.
//
// The case a per-request flag structurally cannot serve: a watcher's own
// rebuilds. Today the only way to make a misbehaving production instance
// verbose is to restart it — which drops every connected MCP and drive
// session, and is the incident path, so the tool you need is available only by
// performing the risky act you are trying to diagnose.
//
// EXPIRES, because the failure mode is a full disk weeks later with nobody
// remembering who asked. It also dies with the process, so a restart is a
// second guarantee rather than the only one.
export function installLogLevel(level, ttlMs = INSTALLED_LOG_TTL_MS) {
    if (!LOG_LEVELS.includes(level)) return false
    installedLevel = { level, expiresAt: Date.now() + ttlMs }
    return setLogLevel(level)
}

export function resetLogLevel() {
    installedLevel = null
    return setLogLevel(baseLevel)
}

// What is in force, and whether an installed level has run out. Called at the
// top of a cycle so expiry lands on a build boundary rather than mid-render.
export function applyInstalledLogLevel() {
    if (!installedLevel) return null
    if (Date.now() >= installedLevel.expiresAt) {
        const expired = installedLevel.level
        installedLevel = null
        setLogLevel(baseLevel)
        return { expired, level: baseLevel }
    }
    if (currentLevel !== installedLevel.level) setLogLevel(installedLevel.level)
    return { level: installedLevel.level, expiresAt: installedLevel.expiresAt }
}

// Where the level RESTS between requests: an installed one if there is one,
// otherwise what the run was configured with.
//
// The single rule the restore needs. Putting back "the level before this
// request" instead was wrong for exactly one case and it was the important
// one: --log-reset captured debug, cleared it, and the restore put debug back,
// so the reset appeared to do nothing.
export function restingLogLevel() {
    return installedLevel?.level ?? baseLevel
}

// What is in force right now, so a caller can put it back.
export function currentLogLevel() {
    return currentLevel ?? baseLevel
}

export function installedLogLevel() {
    return installedLevel ? { ...installedLevel } : null
}

// Thirty minutes: long enough to reproduce something on a live instance,
// short enough that forgetting costs a log file rather than a disk.
export const INSTALLED_LOG_TTL_MS = 30 * 60 * 1000

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

// Progress API: trackProgress / updateProgress / stopProgress /
// updateProgressDetails. A gauge where a terminal is watching, coded records
// where one is not, and nothing at all for a phase that took no time.

// Long phases only, and long means TIME.
//
// A record per quartile is right for 800 documents and absurd for 5. Eleven
// of a plain build's thirteen phases carry exactly five items, so reporting
// them the way a bar counts took a piped no-op build from 32 lines to 97 —
// sixty-five progress records, five in the same millisecond to say a phase
// did nothing. That is written into the log a deployment keeps, which is the
// log the installed-level expiry exists to protect.
//
// A minimum TOTAL would fix the count and get the other half wrong: four PDFs
// through Chrome is a small phase and a slow one, and it is exactly the phase
// worth narrating. Elapsed time is what "long" means and it needs no
// per-phase tuning.
//
// It is an INTERVAL rather than a threshold, and quartiles are gone with it.
// A quartile is a fraction of the WORK, so it says nothing about how often a
// line appears: four records land in three seconds on a fast phase and four
// records cover an hour on a slow one. Time is the axis a reader cares about,
// so one line per interval, however much work passed in between.
//
// This gates the RUNNING commentary only. `progress-finished` is not behind
// it: every phase says that it ran and what it cost, whatever the duration.
// Gated, a short phase produced no record at all and a build could not say
// what it had done — and off a TTY that line is the only place phase timings
// come from.
export const PROGRESS_INTERVAL_MS = 30_000

// Which item, not just how far. A phase name alone says a build is doing
// something; the thing a stuck build needs to say is WHAT it is stuck on.
function progressDetail(detail) {
    if (detail === null || detail === undefined || detail === '') return null
    const text = String(detail)
    const root = runtime.options?.workingFolder
    if (!root || !path.isAbsolute(text)) return text
    // An entity id LOOKS absolute and is not a filesystem path.
    // `/documents/p3706.md` relativised against the working folder becomes
    // `../../../documents/p3706.md`, which names nothing anyone can act on.
    // So shorten only what is genuinely INSIDE the folder, and leave every
    // other string exactly as the call site handed it over.
    const relative = path.relative(root, text)
    return relative.startsWith('..') ? text : relative
}

// A duration rounded away to nothing is not a measurement.
//
// `finished: 5 0s` was the first version of this and `0s` said nothing;
// millisecond resolution moved the same defect one order of magnitude down,
// where nine of a plain build's thirteen phases still printed `0ms`. The
// clock is the cause rather than the format — Date.now() cannot resolve
// below a millisecond — so phases are timed with performance.now(), and each
// band is printed at the resolution it actually has. The floor exists
// because even a monotonic clock can report two identical readings, and
// `0.00ms` would be the same lie a third time.
export function formatDuration(ms) {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
    if (ms >= 1) return `${Math.round(ms)}ms`
    if (ms >= 0.01) return `${ms.toFixed(2)}ms`
    return '<0.01ms'
}

function emitProgress({ name, total, value, detail }) {
    const at = progressDetail(detail)
    const fields = { code: 'progress', phase: name, total, value }
    if (at) useLogger()?.info({ ...fields, detail: at }, '%s: %d/%d — %s', name, value, total, at)
    else useLogger()?.info(fields, '%s: %d/%d', name, value, total)
}

export function trackProgress(name, total) {
    if (!name || !total) return
    const logger = useLogger()
    logger.debug('%s started: %d', name, total)
    // The bar writes to stdout, and stdout is where --json and --tool put
    // their DOCUMENT. Forwarded, those writes are captured and framed to the
    // client, so the gauge landed inside the JSON:
    // `^[[?25lDocuments import: >416/800` at byte 0, and JSON.parse threw —
    // 4 runs in 10 at the default level on an 800-document corpus.
    //
    // Checked HERE rather than through runtime.options.info, because this is
    // the actual invariant and info is a preference. A preference can be
    // forgotten on a path; an invariant stated at the one place a bar starts
    // cannot.
    const carriesDocument = runtime.options?.json || runtime.options?.tool || runtime.options?.tools

    // TRACKED always, DRAWN only where a bar belongs.
    //
    // The two used to be one decision, so anything that could not draw also
    // stopped counting — and `stopProgress` returns early without a bar, which
    // is where the "finished: N in Ns" line comes from. A piped build
    // therefore reported no phase timings at all, and suppressing the bar for
    // --json would have extended that to every machine reading the output.
    // Losing the graphics is the point; losing the information is not.
    const drawn = !carriesDocument && Boolean(process.stdout.isTTY) && Boolean(runtime.options.info)
    const now = performance.now()
    currentBar = { name, total, value: 0, started: now, drawn, lastReport: now, detail: null }
    if (drawn) ensureGauge().show({ section: name, subsection: `0/${total}` }, 0)
}

export function updateProgress(detail) {
    if (!currentBar) return
    currentBar.value++
    // The call site hands over whatever identifies the item it is on — a
    // path, an id — and pays one assignment for it. Formatting happens at
    // emit time, at most four times a phase, so naming the work costs the
    // 14k-entity import nothing.
    if (detail !== undefined) currentBar.detail = detail
    const { name, total, value, drawn } = currentBar
    if (drawn) {
        gauge?.show({ section: name, subsection: `${value}/${total}` }, value / total)
    } else {
        // One line per interval, not per item and not per quartile: a bar
        // redraws in place and costs one line, a log record does not, so 800
        // documents is 800 lines of noise if this counts the way the bar does.
        // A phase that finishes inside the interval says nothing at all while
        // it runs — its finished line covers it.
        const now = performance.now()
        if (now - currentBar.lastReport >= PROGRESS_INTERVAL_MS && value < total) {
            currentBar.lastReport = now
            emitProgress(currentBar)
        }
    }
    if (value >= total) stopProgress()
}

export function stopProgress() {
    if (!currentBar) return
    const logger = useLogger()
    const { name, total, value, started } = currentBar
    // Rounded so the field carries real sub-millisecond precision without
    // float noise; the message formats it separately.
    const ms = Math.round((performance.now() - started) * 1000) / 1000
    gauge?.hide()
    // Structured either way, so a machine reading --json's stderr gets the
    // same facts a person reads off the bar.
    //
    // This line has to stand alone. With the running commentary on an
    // interval it is the ONLY record most phases produce, and `Documents
    // import finished: 5 0s` said neither what the five were nor how long it
    // took — a count with no subject and a duration rounded away to nothing.
    //
    // The subject is the PHASE, not an item. The last entity a phase happened
    // to walk is not what the phase was about: seven journal phases in a row
    // reported the same `/layouts/page.hbs` because that is where the walk
    // ended, and `Files import finished: 3, last .../social-fb.svg` put a
    // filename into the build log that nothing had anything to say about — it
    // broke a test asserting that file is never mentioned, which is exactly
    // the misreading it invites. `Files import finished: 3 in 3ms` already
    // says what finished, how much of it, and what it cost. The running
    // records keep the item, because there it shows MOVEMENT.
    if (value < total) {
        logger.warn({ code: 'progress-unfinished', phase: name, total, value, missing: total - value },
            '%s unfinished: %d of %d after %s', name, total - value, total, formatDuration(ms))
    } else {
        logger.info({ code: 'progress-finished', phase: name, total, ms },
            '%s finished: %d in %s', name, total, formatDuration(ms))
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

// What a caller asked for about logging, applied the same way from argv and
// from a forwarded request.
//
// It was written twice and the copies drifted immediately: the argv path threw
// on an unknown level and set `info`, the forwarded path called setLogLevel and
// ignored the false it returns. So `--log chatty` exited 1 locally and built
// normally with a watcher up, and `--log silent` left the progress bar running
// on an instance. The same forwarded/local split --json and --force each had,
// and this feature's own argument against itself: a flag that lies is worse
// than a flag that is missing.
//
// Returns an error STRING rather than throwing, because the two callers need
// different things from a failure — argv throws, the instance refuses over the
// socket — and a shared implementation should not decide that for them.
export function applyLogRequest({ log, logInstall, logReset } = {}) {
    for (const [flag, level] of [['--log', log], ['--log-install', logInstall]]) {
        if (level !== undefined && level !== null && !LOG_LEVELS.includes(level)) {
            return `${flag} ${level}: no such level. Levels: ${LOG_LEVELS.join(', ')}`
        }
    }
    if (logReset) resetLogLevel()
    if (logInstall) installLogLevel(logInstall)
    if (log) setLogLevel(log)

    // A bar on top of debug output is noise, and silent means silent.
    const level = log || logInstall
    if (level === 'trace' || level === 'debug' || level === 'silent') {
        runtime.options.info = false
    }
    return null
}

// An installed level, disclosed and expired, once per cycle.
//
// Disclosed for the reason an installed command is: it is state left on a live
// instance that changes what the process does, and the person who finds it
// weeks later is not the person who set it. A level at debug is quieter to
// leave behind than a probe and louder in effect — the deployment's out log is
// already 1.6MB, and a watcher rebuilding on every editor save at debug grows
// it fast. The failure lands as a full disk with nobody remembering who asked.
//
// Expiry is checked here rather than on a timer so it lands on a build
// boundary instead of mid-render, and the level also dies with the process, so
// a restart is a second guarantee rather than the only one.
//
// onFinalized, matching where the commands plugin announces an installed
// command — the report is reset at the top of a cycle, and a warning raised
// anywhere earlier than the last hook did not survive into the document a
// forwarded --json emits. Measured, not assumed: on onImport and on onFinalize
// the line reached the instance's log and the report stayed empty.
onFinalized(() => {
    const state = applyInstalledLogLevel()
    if (!state) return
    const logger = useLogger()
    if (state.expired) {
        logger?.info('Log level installed with --log-install has expired; back to %s', state.level)
        return
    }
    const minutes = Math.max(0, Math.round((state.expiresAt - Date.now()) / 60000))
    logger?.warn(
        { code: 'log-level-installed', level: state.level, expiresIn: `${minutes}m` },
        'This instance is running at log level %s, installed with --log-install — it is not the '
        + 'configured level and it is not this build asking for it. Expires in %dm, or on --log-reset, '
        + 'or when the process restarts.',
        state.level, minutes)
})

// The progress bar, and the records that stand in for it.
//
// Runs ALONGSIDE pino rather than through it. The gauge owns the bottom row
// of the terminal, so the logger's stream has to clear the bar before writing
// a line and restore it after — `pauseBar` / `resumeBar` below are that
// coordination, and they are the only reason streams.js knows this module
// exists. The dependency points this way deliberately: progress owns the
// gauge, and the log stream asks it to step aside.

import Gauge from 'gauge'
import path from 'node:path'
import runtime from '../runtime.js'
import { useLogger } from '../engine.js'


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

// Called by the log stream around every line it writes. Exported rather than
// reaching for the gauge from there, so this module stays the only place that
// knows whether a bar exists.
export function pauseBar() {
    if (gauge) gauge.disable()
}

export function resumeBar() {
    if (gauge) gauge.enable()
}

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
